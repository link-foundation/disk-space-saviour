/**
 * `scan(options) → Report`: finds reclaimable space on the host and, through
 * Docker, inside running containers and nested daemons. Never deletes.
 */

import {
  configureContainerHost,
  resetWritableLayers,
} from './docker/writable.js';
import path from 'node:path';
import { setInterval, clearInterval } from 'node:timers';
import { scanDocker } from './docker/scan.js';
import { LocalEnv } from './env/local.js';
import { configureScanPolicy } from './env/policy.js';
import { configureCacheRoots } from './env/cache-roots.js';
import {
  CONTAINER_ROOTS,
  finishScope,
  requestedRoots,
  resolveRoots,
  scanScope,
} from './env/roots.js';
import { checkSignal, environmentScope } from './env/scope.js';
import { block, tierTotals } from './items.js';
import { hostExecutor, trace } from './exec.js';
import { GitInspector } from './git.js';
import { LivenessProbe } from './liveness.js';
import { resolveOptions } from './options.js';
import { isWithin, matchesExcluded } from './paths.js';
import { scanAgents } from './scanners/agents.js';
import { GLOBAL_RULES, scanGlobal, targetedRules } from './scanners/global.js';
import { scanProjects } from './scanners/projects.js';
import { scanSystem } from './scanners/system.js';
import { scanVersions } from './scanners/versions.js';
import { VERSION_RULES } from './rules/versions.js';
import { readSwap } from './swap.js';
import {
  authenticateReport,
  authenticatedReport,
  saveScan,
  ScanIndex,
  scopeKey,
} from './scan-state.js';
import { PhaseTimer, timed } from './timings.js';

export const SCANNERS = {
  projects: scanProjects,
  global: scanGlobal,
  versions: scanVersions,
  agents: scanAgents,
  system: scanSystem,
};

export const REPORT_SCHEMA = 1;
const trustedReports = new WeakMap();
const reportEnvironments = new WeakMap();
export const scannedEnvironment = (report) => reportEnvironments.get(report);
const RESCAN_OPTIONS = new Set([
  'roots',
  'containerRoots',
  'scanners',
  'containers',
  'host',
  'docker',
  'dockerDepth',
  'maxDepth',
  'staleAge',
  'olderThan',
  'inactive',
  'minSize',
  'only',
  'exclude',
  'includeVolumes',
  'removeStoppedContainers',
  'investigationMaxAge',
  'removeContainers',
  'removeImages',
  'allowDirtyRepos',
  'allowDirtyContainers',
  'noNative',
  'journalKeep',
  'env',
  'now',
  'signal',
  'scanBudget',
  'onScanProgress',
]);

function safetySnapshot(report) {
  return JSON.stringify(report);
}

function sealReport(report) {
  trustedReports.set(report, safetySnapshot(report));
  return report;
}

function unchangedDiscoveryScope(report, input) {
  const original = resolveOptions(report.options);
  const overrides = Object.fromEntries(
    Object.entries(input).filter(
      ([name, value]) =>
        RESCAN_OPTIONS.has(name) && value !== undefined && value !== null
    )
  );
  return (
    scopeKey(original) ===
    scopeKey(resolveOptions({ ...original, ...overrides }))
  );
}

/** Rebuild scanner-derived actions when a report came from JSON or changed. */
export async function revalidateReport(saved, input = {}) {
  if (trustedReports.get(saved) === safetySnapshot(saved)) {
    return saved;
  }
  saved = saved.report?.schema === REPORT_SCHEMA ? saved.report : saved;
  if (
    unchangedDiscoveryScope(saved, input) &&
    (await authenticatedReport(
      saved,
      input.cacheDir,
      input.now?.() ?? Date.now()
    ))
  ) {
    return sealReport(saved);
  }
  const scope = Object.fromEntries(
    [
      'roots',
      'containerRoots',
      'scanners',
      'containers',
      'host',
      'docker',
      'dockerDepth',
      'maxDepth',
    ].map((name) => [name, saved.options?.[name]])
  );
  for (const [key, value] of Object.entries(input)) {
    if (RESCAN_OPTIONS.has(key) && value !== undefined && value !== null) {
      scope[key] = value;
    }
  }
  const current = await scan(scope);
  const selected = new Set((saved.items ?? []).map((item) => item.id));
  current.items = current.items.filter((item) => selected.has(item.id));
  current.totals = tierTotals(current.items);
  return sealReport(current);
}

export { CONTAINER_ROOTS };

/**
 * Builds the scanner context of one environment.
 * @param {object} env environment adapter
 * @param {object} options resolved options
 * @param {{roots?: string[]|null}} [overrides]
 */
export async function environmentContext(env, options, overrides = {}) {
  await configureScanPolicy(env, {
    ...options,
    roots: requestedRoots(env, options, overrides),
  });
  const liveness = new LivenessProbe(env, {
    staleAgeMs: options.staleAgeMs,
    inactiveMs: options.inactiveMs,
    now: options.now,
  });
  await liveness.refresh(true);
  const homes = await env.homeDirs();
  await configureCacheRoots(env, homes);
  const tmpDirs = await env.tmpDirs();
  const { roots, entries } = await resolveRoots(
    env,
    options,
    overrides,
    homes,
    tmpDirs
  );
  env.scanScope = scanScope(env, options, entries);
  return {
    env,
    git: new GitInspector(env),
    liveness,
    now: options.now(),
    options: { ...options, homes, tmpDirs, roots },
  };
}

/**
 * Runs every enabled scanner in one environment.
 * @param {object} env
 * @param {object} options resolved options
 * @param {{roots?: string[]|null, errors?: object[]}} [extra]
 * @returns {Promise<object[]>} items
 */
/** A run limited to global or version rules skips the other scanners. */
function selectedScanners(options) {
  if (!targetedRules(options.only)) {
    return options.scanners;
  }
  const rules = { global: GLOBAL_RULES, versions: VERSION_RULES };
  return options.scanners.filter(
    (name) => rules[name] && targetedRules(options.only, rules[name]).length > 0
  );
}

export async function scanEnvironment(env, options, extra = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }
  const started = Date.now(),
    deadline = started + options.scanBudgetMs;
  const timer = setTimeout(
    () => controller.abort(new Error('scan time budget exceeded')),
    options.scanBudgetMs
  );
  const found = new Map();
  const completed = new Set();
  let scanner = 'context';
  const progress = () =>
    options.onScanProgress?.({
      env: env.id,
      scanner,
      elapsedMs: Date.now() - started,
      items: found.size,
      candidates: found.size,
      filesSized: env.scanMetrics?.filesSized ?? 0,
      directoriesSized: env.scanMetrics?.directoriesSized ?? 0,
      indexHits: env.scanMetrics?.indexHits ?? 0,
      sizeCacheHits: env.scanMetrics?.sizeCacheHits ?? 0,
      status: env.scanStatus,
    });
  env.scanStatus = 'scanning';
  const interval = setInterval(progress, 5000);
  try {
    return await environmentScope(
      env,
      controller.signal,
      () => {
        progress();
        return scanEnvironmentScoped(
          env,
          options,
          extra,
          found,
          completed,
          (name) => {
            scanner = name;
            progress();
          }
        );
      },
      deadline
    );
  } catch (error) {
    env.scanStatus = options.signal?.aborted
      ? 'aborted'
      : controller.signal.aborted
        ? 'budget-exceeded'
        : 'error';
    (extra.errors ?? []).push({ env: env.id, scanner, message: error.message });
    const items = [...found.values()];
    for (const item of items) {
      if (options.signal?.aborted || !completed.has(item.id)) {
        block(item, `scan incomplete: ${error.message}`);
      }
    }
    return items;
  } finally {
    finishScope(env, selectedScanners(options).includes('projects'));
    clearTimeout(timer);
    clearInterval(interval);
    options.signal?.removeEventListener('abort', abort);
    progress();
  }
}

/** Phase timings of an environment, started on its first scan. */
function environmentTimings(env) {
  env.timings ??= new PhaseTimer();
  return env.timings;
}

async function scanEnvironmentScoped(
  env,
  options,
  extra,
  found,
  completed,
  stage
) {
  const errors = extra.errors ?? [];
  const context = await environmentTimings(env).measure('context', () =>
    environmentContext(env, options, extra)
  );
  context.timings = env.timings;
  context.emit = (item) => found.set(item.id, item);
  let stopped = false;
  const ready = async (items) => {
    await env.timings.measure('storage', () => attributeStorage(env, items));
    for (const item of items) {
      for (const target of item.paths) {
        block(item, env.scanPolicy.removalReason(target));
      }
      completed.add(item.id);
    }
    if (
      env.kind === 'host' &&
      context.scanner === 'global' &&
      options.onScanPhase
    ) {
      const result = await options.onScanPhase(
        sealReport({
          schema: REPORT_SCHEMA,
          tool: 'disk-space-saviour',
          createdAt: new Date(options.now()).toISOString(),
          host: { env: env.id, label: env.label, platform: env.platform },
          options: reportOptions(options),
          environments: [envDescriptor(env, 0, [])],
          items: filterItems(items, options, [], env.path),
          totals: tierTotals(items),
          errors: [],
          docker: null,
        })
      );
      stopped ||= result === false;
    }
    return !stopped;
  };
  context.ready = ready;
  let incomplete = false;
  for (const name of selectedScanners(options)) {
    checkSignal(env.signal);
    context.scanner = name;
    stage(name);
    const scanner = SCANNERS[name];
    if (!scanner) {
      throw new Error(
        `Unknown scanner: ${name} (expected ${Object.keys(SCANNERS).join(', ')})`
      );
    }
    const started = Date.now();
    const previous = new Set(found.keys());
    try {
      const entries = await env.timings.measure(`scanner:${name}`, () =>
        scanner(context)
      );
      for (const item of entries) {
        context.emit(item);
      }
      await ready(entries.filter((item) => !completed.has(item.id)));
    } catch (error) {
      checkSignal(env.signal);
      incomplete = true;
      for (const [id, item] of found) {
        if (![previous, completed].some((set) => set.has(id))) {
          block(item, `scan incomplete: ${error.message}`);
        }
      }
      errors.push({ env: env.id, scanner: name, message: error.message });
    }
    trace('scanner', name, 'in', env.id, `${Date.now() - started}ms`);
    if (stopped) {
      env.scanStatus = 'goal-reached';
      return [...found.values()];
    }
  }
  stage('storage');
  const items = [...found.values()];
  for (const item of items) {
    for (const target of item.paths) {
      block(item, env.scanPolicy.removalReason(target));
    }
  }
  for (const message of await accessErrorMessages(env)) {
    errors.push({ env: env.id, scanner: 'filesystem', message });
  }
  env.scanStatus = incomplete ? 'error' : 'complete';
  return items;
}

/** Report messages for paths the scan could not inspect. */
function accessErrorMessages(env) {
  return env.accessErrorMessages
    ? env.accessErrorMessages()
    : [...(env.accessErrors?.values() ?? [])];
}

async function attributeStorage(env, items) {
  if (env.writableLayer) {
    const usages = await env.usageMany([
      ...new Set(items.flatMap((item) => item.paths)),
    ]);
    for (const item of items.filter((entry) => entry.paths.length > 0)) {
      const measured = item.paths
        .map((target) => usages.get(target))
        .filter(Boolean);
      item.bytes = measured.reduce((sum, usage) => sum + usage.bytes, 0);
      item.totalBytes = measured.reduce(
        (sum, usage) => sum + (usage.totalBytes ?? usage.bytes),
        0
      );
      item.imageBytes = measured.reduce(
        (sum, usage) => sum + (usage.imageBytes ?? 0),
        0
      );
      item.imageRef =
        measured.find((usage) => usage.imageRef)?.imageRef ?? null;
      item.sizeUnknown = measured.some((usage) => usage.sizeUnknown);
      if (!item.sizeUnknown && item.bytes === 0 && item.imageBytes > 0) {
        block(
          item,
          'all bytes are in the image layer; remove the stopped container and its unused image after the task completes, or rebuild without caches'
        );
      }
    }
  }
}

/**
 * Container ids of the container dss itself runs in (from mount sources
 * such as `/var/lib/docker/containers/<id>/hostname`).
 * @returns {Promise<string[]>}
 */
export async function selfContainerIds(env) {
  if (env.platform !== 'linux' || typeof env.readText !== 'function') {
    return [];
  }
  const ids = new Set();
  const pattern = /(?:containers\/|docker[-/])([0-9a-f]{64})/g;
  const cgroup =
    (await env.readText('/proc/self/cgroup').catch(() => null)) ?? '';
  for (const match of cgroup.matchAll(pattern)) {
    ids.add(match[1]);
  }
  const mounts =
    (await env.readText('/proc/self/mountinfo').catch(() => null)) ?? '';
  for (const line of mounts.split('\n')) {
    const mountpoint = line.split(' ')[4];
    if (
      !['/etc/hostname', '/etc/hosts', '/etc/resolv.conf'].includes(mountpoint)
    ) {
      continue;
    }
    for (const match of line.matchAll(pattern)) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

/**
 * `only` entries name an ecosystem, rule, kind or item id, or a path or
 * glob: an item matches it when each of its paths lies inside the path, or
 * the path or one of its ancestors matches the glob.
 */
function matchesOnly(item, only, pathApi = path) {
  return (
    only.length === 0 ||
    only.some(
      (entry) =>
        [item.ecosystem, item.rule, item.kind, item.id].includes(entry) ||
        insideOnlyPath(item, entry, pathApi)
    )
  );
}

function insideOnlyPath(item, entry, pathApi) {
  const glob = /[*?[]/.test(entry);
  if (!glob && !pathApi.isAbsolute(entry) && !path.win32.isAbsolute(entry)) {
    return false;
  }
  return (
    item.paths?.length > 0 &&
    item.paths.every((target) =>
      glob
        ? matchesExcluded(target, [entry], pathApi)
        : isWithin(target, entry, pathApi)
    )
  );
}

function excluded(item, exclude, pathApi) {
  return item.paths.some(
    (target) =>
      matchesExcluded(target, exclude, pathApi) ||
      exclude.some(
        (pattern) =>
          !/[*?[]/.test(pattern) && isWithin(pattern, target, pathApi)
      )
  );
}

function underDaemonRoot(item, daemons, pathApi) {
  return daemons.some(
    (daemon) =>
      daemon.env === item.env &&
      daemon.rootDir &&
      item.action?.type === 'remove' &&
      item.paths.some((target) => isWithin(target, daemon.rootDir, pathApi))
  );
}

/**
 * Applies `only`, `exclude` and `minSize`, and drops paths owned by a
 * Docker daemon (those are reclaimed through Docker only).
 */
export function filterItems(items, options, daemons = [], pathApi) {
  return items.filter(
    (item) =>
      (item.bytes >= options.minSizeBytes ||
        item.sizeUnknown ||
        item.imageBytes >= options.minSizeBytes ||
        item.container?.pinnedImage?.bytes >= options.minSizeBytes) &&
      matchesOnly(item, options.only, pathApi) &&
      !excluded(item, options.exclude, pathApi) &&
      !underDaemonRoot(item, daemons, pathApi)
  );
}

/**
 * Items that share every block with an installed app (APFS clones): they
 * free nothing, so they are not offered, but `du` counts them at full size.
 */
function sharedItems(items, options, pathApi) {
  return filterItems(
    items.filter((item) => item.sharedWith),
    { ...options, minSizeBytes: 0 },
    [],
    pathApi
  ).map((item) => ({
    rule: item.rule,
    path: item.path,
    apparentBytes: item.apparentBytes,
    sharedWith: item.sharedWith,
  }));
}

function envDescriptor(env, depth, chain) {
  return {
    id: env.id,
    label: env.label,
    kind: env.kind,
    depth,
    chain,
    hint: env.probeHint ?? null,
    scanStatus: env.scanStatus ?? null,
    scope: env.scanScope ?? null,
    layerSource: env.writableLayer?.source ?? null,
    timings: env.timings?.toJSON() ?? [],
  };
}

async function withDisk(env, descriptor, options) {
  const target = env.platform === 'win32' ? env.currentHome : '/';
  const disk = await env.diskUsage(target).catch(() => null);
  return {
    ...descriptor,
    disk: disk ? { path: target, ...disk } : null,
    swap: await readSwap(env, {
      stateDir: options.cacheDir,
      disk,
      now: options.now?.(),
    }),
  };
}

/**
 * Scans one running container found by the Docker walk (any depth). Roots
 * come from `containerRoots`/`roots` via environmentContext, never from the
 * host's resolved defaults.
 */
export function containerScanner(options, errors) {
  return (inner) => scanEnvironment(inner, options, { errors });
}

async function dockerSection(env, options, errors) {
  if (options.docker === false) {
    return null;
  }
  const hostRecord = {
    env,
    executor: env.executor ?? hostExecutor(),
    chain: [],
  };
  try {
    const result = await scanDocker(
      hostRecord,
      { ...options, selfContainerIds: await selfContainerIds(env) },
      containerScanner(options, errors)
    );
    errors.push(...result.errors);
    if (options.docker === true && result.daemons.length === 0) {
      errors.push({
        env: env.id,
        scanner: 'docker',
        message: 'no reachable Docker daemon',
      });
    }
    return result;
  } catch (error) {
    errors.push({ env: env.id, scanner: 'docker', message: error.message });
    return null;
  }
}

/**
 * Scans and returns a report. Nothing is modified.
 * @param {object} [input] options, see ./options.js; `host: false` skips the
 *   host file system (Docker only); `env` injects the host environment
 *   adapter (tests).
 * @returns {Promise<object>} report
 */
function blockMountedHostItems(items, mounts, pathApi) {
  for (const item of items) {
    if (item.action?.type !== 'remove') {
      continue;
    }
    for (const mount of mounts) {
      if (
        item.paths.some(
          (target) =>
            isWithin(target, mount.source, pathApi) ||
            isWithin(mount.source, target, pathApi)
        )
      ) {
        block(item, `bind-mounted by running container ${mount.containerId}`);
      }
    }
  }
}

export async function scan(input = {}) {
  const env = input.env ?? new LocalEnv();
  try {
    return await environmentScope(env, input.signal, () =>
      scanScoped({ ...input, env })
    );
  } catch (error) {
    if (!input.signal?.aborted) {
      throw error;
    }
    env.scanStatus = 'aborted';
    const options = resolveOptions(input);
    return buildReport({
      options,
      env,
      items: [],
      environments: [envDescriptor(env, 0, [])],
      docker: null,
      errors: [{ env: env.id, scanner: 'context', message: error.message }],
      startedAt: options.now(),
    });
  }
}

async function scanScoped(input) {
  const options = resolveOptions(input);
  const env = input.env ?? new LocalEnv();
  const startedAt = options.now();
  const errors = [];
  env.scanMetrics = {
    filesSized: 0,
    directoriesSized: 0,
    indexHits: 0,
    sizeCacheHits: 0,
  };
  env.scanIndex = new ScanIndex(options.cacheDir);
  env.platformIndex = options.platformIndex;
  await env.scanIndex.load();
  resetWritableLayers(env.executor);
  env.writableLayer = null;
  env.scanPolicy = null;
  env.timings = new PhaseTimer();
  await configureScanPolicy(env, options);
  await configureContainerHost(
    env,
    options.docker === false ? [] : await selfContainerIds(env),
    options
  );
  const hostItems =
    options.host === false
      ? []
      : await scanEnvironment(env, options, { roots: options.roots, errors });
  const docker =
    env.scanStatus === 'goal-reached'
      ? null
      : await timed(env.timings, 'docker', () =>
          dockerSection(env, options, errors)
        );
  blockMountedHostItems(hostItems, docker?.bindMounts ?? [], env.path);
  const items = filterItems(
    [...hostItems, ...(docker?.items ?? [])],
    options,
    docker?.daemons ?? [],
    env.path
  );
  const shared = sharedItems(hostItems, options, env.path);
  const environments = [envDescriptor(env, 0, [])];
  for (const inner of docker?.environments ?? []) {
    environments.push(inner);
  }
  environments[0] = await timed(env.timings, 'disk', () =>
    withDisk(env, environments[0], options)
  );
  environments[0].timings = env.timings.toJSON();
  const report = buildReport({
    options,
    env,
    items,
    shared,
    environments,
    docker,
    errors,
    startedAt,
  });
  reportEnvironments.set(report, env);
  await env.scanIndex.save();
  await authenticateReport(report, options.cacheDir);
  sealReport(report);
  await saveScan(report, options.cacheDir);
  return report;
}

function reportOptions(options) {
  const serializable = { ...options };
  delete serializable.now;
  delete serializable.env;
  delete serializable.signal;
  delete serializable.onScanProgress;
  delete serializable.onScanPhase;
  return serializable;
}

/**
 * Assembles the JSON-serializable report.
 */
export function buildReport({
  options,
  env,
  items,
  shared = [],
  environments,
  docker,
  errors,
  startedAt,
}) {
  return sealReport({
    schema: REPORT_SCHEMA,
    tool: 'disk-space-saviour',
    createdAt: new Date(options.now()).toISOString(),
    durationMs: options.now() - startedAt,
    aborted: Boolean(options.signal?.aborted),
    host: { env: env.id, label: env.label, platform: env.platform },
    options: reportOptions(options),
    environments,
    items,
    shared,
    totals: tierTotals(items),
    docker: docker
      ? {
          daemons: docker.daemons,
          containers: docker.containers,
          hints: docker.hints,
          volumes: docker.volumes,
        }
      : null,
    errors,
  });
}
