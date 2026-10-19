import { checkSignal, scanItems } from '../env/scope.js';
/**
 * Global per-user caches (ecosystem download and compilation caches, IDE and
 * browser caches), system package caches, and leftovers in temporary
 * directories. See ../rules/ecosystems.js, ../rules/other.js and
 * ../rules/downloads.js.
 */

import { CACHE_RULES } from '../rules/ecosystems.js';
import { OTHER_RULES, TEMP_CLONE_RULES } from '../rules/other.js';
import { APP_RULES, expandChromiumCaches } from '../rules/apps.js';
import { VERSION_RULES, compareVersions } from '../rules/versions.js';
import { block, makeItem } from '../items.js';
import { expandGlobPaths, expandRulePath, isWithin } from '../paths.js';
import { olderThan, scanTimeBusy, resolvePaths } from './common.js';
import { configuredPattern } from '../env/cache-roots.js';
import { TOOLCHAIN_CACHE_RULES } from '../rules/toolchains.js';
import { DOWNLOAD_RULES } from '../rules/downloads.js';
import { timed } from '../timings.js';
import { appCloneDetails } from './app-clones.js';
import { gitDirectories } from '../git.js';
import { networkRemotes } from '../git-remote.js';

export const GLOBAL_RULES = [
  ...CACHE_RULES,
  ...expandChromiumCaches(OTHER_RULES),
  ...APP_RULES,
  ...TOOLCHAIN_CACHE_RULES,
  ...DOWNLOAD_RULES,
  ...TEMP_CLONE_RULES,
];

function scopeBases(rule, homes, tmpDirs) {
  const scope = rule.scope ?? 'home';
  if (scope === 'tmp') {
    return tmpDirs.map((tmp) => ({ home: null, tmp }));
  }
  if (scope === 'system') {
    return [{ home: null, tmp: null }];
  }
  return homes.map((home) => ({ home, tmp: null }));
}

function rulePatterns(env, rule, base) {
  const patterns = [];
  for (const pattern of rule.paths) {
    if (pattern.includes('{GEM_PATH}')) {
      if (base.home === env.currentHome) {
        for (const root of (env.vars.GEM_PATH ?? '').split(
          env.platform === 'win32' ? ';' : ':'
        )) {
          if (env.path.isAbsolute(root)) {
            patterns.push(pattern.replace('{GEM_PATH}', root));
          }
        }
      }
      continue;
    }
    const usesVars = /\{(?!TMP\})[A-Z_]+\}/.test(pattern);
    if (usesVars && base.home !== env.currentHome) {
      continue;
    }
    const expanded = expandRulePath(
      configuredPattern(env, base.home, pattern),
      {
        home: base.home ?? '/',
        vars: { ...env.vars, TMP: base.tmp ?? undefined },
        pathApi: env.path,
      }
    );
    if (expanded) {
      patterns.push(expanded);
    }
  }
  return patterns;
}

/**
 * The tool's own clean command, when it can run for this cache.
 * @returns {Promise<{action: object|null, blocker: string|null}>}
 */
async function nativeAction(context, rule, base, paths) {
  const { env, options } = context;
  const native = rule.native;
  const removal = { type: 'remove', paths };
  if (!native || options.noNative) {
    return { action: removal, blocker: null };
  }
  const init = native.init
    ? expandRulePath(configuredPattern(env, base.home, native.init), {
        home: base.home,
        pathApi: env.path,
      })
    : null;
  const nativeRoot = native.cacheRoot
    ? expandRulePath(configuredPattern(env, base.home, native.cacheRoot), {
        home: base.home,
        pathApi: env.path,
      })
    : null;
  const usable = await nativeUsable(env, rule, base, paths, nativeRoot, init);
  if (usable) {
    return {
      action: {
        type: 'command',
        argv: init
          ? [native.tool, '-c', `. "$1" && ${native.command}`, 'dss', init]
          : native.argv,
        measure: paths,
      },
      blocker: null,
    };
  }
  if (native.required) {
    return {
      action: null,
      blocker: `only \`${native.argv.join(' ')}\` can clean this safely, and it is unavailable`,
    };
  }
  return { action: removal, blocker: null };
}

async function nativeUsable(env, rule, base, paths, root, init) {
  return (
    (rule.scope === 'system' || base.home === env.currentHome) &&
    (await env.which(rule.native.tool)) &&
    (!rule.native.root || (await env.isRoot())) &&
    (!root || paths.every((target) => isWithin(target, root, env.path))) &&
    (!init || (await env.exists(init)))
  );
}

function ageFilter(context, rule) {
  const { options } = context;
  if (rule.minAge === 'stale') {
    return (usage) =>
      olderThan(context, usage.newestMtimeMs, options.staleAgeMs);
  }
  if (rule.minAge === 'inactive') {
    return (usage) =>
      olderThan(context, usage.newestMtimeMs, options.inactiveMs);
  }
  return () => true;
}

function requiresMtime(rule) {
  return rule.mtime ?? (rule.scope === 'tmp' || Boolean(rule.minAge));
}

/** Keep the latest installed revision of each browser and platform family. */
function olderVersions(env, rule, paths, stats) {
  if (!rule.versionPattern) {
    return paths;
  }
  const groups = new Map();
  for (const target of paths) {
    if (stats.get(target)?.type !== 'dir') {
      continue;
    }
    const match = rule.versionPattern.exec(env.path.basename(target));
    if (!match) {
      continue;
    }
    const family = `${env.path.dirname(target)}\0${match.groups.family ?? ''}`;
    groups.set(family, [
      ...(groups.get(family) ?? []),
      { target, version: match.groups.version },
    ]);
  }
  const old = new Set();
  for (const entries of groups.values()) {
    entries.sort((a, b) => compareVersions(b.version, a.version));
    for (const entry of entries.slice(1)) {
      old.add(entry.target);
    }
  }
  return paths.filter((target) => old.has(target));
}

/** What cleanup re-verifies right before deleting, by the rule's `git` mode. */
const GIT_RECHECKS = {
  ifPresent: { type: 'scratch' },
  clone: { type: 'clone' },
};

async function buildItem(context, rule, base, group, homes) {
  const { env } = context;
  const paths = group.map((entry) => entry.path);
  const appRoot = rule.markers
    ? env.path.dirname(paths[0].replace(/[/\\]Service Worker[/\\].*$/, ''))
    : null;
  const { action, blocker } = await nativeAction(context, rule, base, paths);
  const scope = rule.scope ?? 'home';
  const item = makeItem(env, {
    rule: rule.id,
    kind: scope === 'tmp' ? 'leftover' : 'cache',
    ecosystem: rule.ecosystem,
    description: rule.description,
    path: paths[0],
    paths,
    bytes: group.reduce((sum, entry) => sum + entry.usage.bytes, 0),
    sizeEstimated: group.some((entry) => entry.usage.estimated),
    newestMtimeMs: Math.max(...group.map((e) => e.usage.newestMtimeMs ?? 0)),
    tier: rule.tier ?? 'safe',
    reason: rule.minAge
      ? `untouched for longer than the ${rule.minAge === 'stale' ? 'activity' : 'inactivity'} window`
      : 're-downloaded or re-created on demand',
    recheck: GIT_RECHECKS[rule.git],
    action: action ?? { type: 'none' },
    checks: {
      busy: [
        ...(rule.busy ?? []),
        ...(appRoot ? [env.path.basename(appRoot)] : []),
      ],
      cwd: scope === 'tmp' ? paths[0] : null,
      mtime: rule.mtime ?? (scope === 'tmp' || Boolean(rule.minAge)),
    },
  });
  block(item, blocker);
  if (rule.appClone) {
    await describeAppClone(context, rule, item, homes);
  }
  await addBlockers(context, rule, item);
  return item;
}

async function describeAppClone(context, rule, item, homes) {
  const { env } = context;
  const appDirs = rule.appClone.installed
    .flatMap((dir) =>
      homes.map((home) => expandRulePath(dir, { home, pathApi: env.path }))
    )
    .filter(Boolean);
  const { executables, sharedWith } = await appCloneDetails(env, item.path, [
    ...new Set(appDirs),
  ]);
  item.checks.executables = executables;
  if (sharedWith) {
    // Every block is shared with the installed app: nothing to reclaim.
    item.bytes = 0;
    item.reason = `shares its disk blocks with ${sharedWith}`;
  }
}

async function addBlockers(context, rule, item) {
  const { env, git } = context;
  if (rule.scope === 'system' && !(await env.isRoot())) {
    block(item, 'system location, run as root to clean it');
  }
  if (rule.git) {
    for (const target of item.paths) {
      for (const reason of rule.git === 'clone'
        ? await git.cloneBlockers(target)
        : await git.treeBlockers(target, {
            allowNoRepo: rule.git === 'ifPresent',
          })) {
        block(item, reason);
      }
    }
  }
  const busy = await scanTimeBusy(context, item);
  if (busy) {
    block(item, `busy: ${busy}`);
  }
}

const namesRule = (entry, rule) =>
  entry === rule.id || entry.includes(`:${rule.id}:`);

/**
 * Rules of `rules` that `only` entries name directly or through an item id
 * (`env:rule:path`), when every entry names a global or version rule; null
 * when an entry may match anything else and every rule has to run.
 */
export function targetedRules(only = [], rules = GLOBAL_RULES) {
  const targetable = [...GLOBAL_RULES, ...VERSION_RULES];
  const covered =
    only.length > 0 &&
    only.every((entry) => targetable.some((rule) => namesRule(entry, rule)));
  return covered
    ? rules.filter((rule) => only.some((entry) => namesRule(entry, rule)))
    : null;
}

/**
 * Scans global cache and leftover locations.
 * @returns {Promise<object[]>} report items
 */
export async function scanGlobal(
  context,
  { rules = targetedRules(context.options.only) ?? GLOBAL_RULES } = {}
) {
  const { env, options } = context;
  const homes = options.homes ?? (await env.homeDirs());
  const tmpDirs = options.tmpDirs ?? (await env.tmpDirs());
  const planned = rules.flatMap((rule) =>
    scopeBases(rule, homes, tmpDirs).map((base) => ({
      rule,
      base,
      patterns: rulePatterns(env, rule, base),
    }))
  );
  const matches = await timed(context.timings, 'global:expand', () =>
    expandGlobPaths(
      env,
      planned.flatMap((entry) => entry.patterns)
    )
  );
  const typedPaths = planned
    .filter(
      ({ rule }) => rule.directoryOnly || rule.fileOnly || rule.versionPattern
    )
    .flatMap(({ patterns }) =>
      patterns.flatMap((pattern) => matches.get(pattern) ?? [])
    );
  const stats = await timed(context.timings, 'global:stat', () =>
    env.statMany([...new Set(typedPaths)])
  );
  const found = [];
  const seen = new Set();
  for (const { rule, base, patterns } of planned) {
    const candidates = [
      ...new Set(patterns.flatMap((pattern) => matches.get(pattern) ?? [])),
    ].filter((target) => !seen.has(target));

    const accepted = [];
    for (const target of candidates) {
      // Acceptance can read Git metadata of thousands of temporary entries
      // without passing through the environment, so honour the budget here.
      checkSignal(env.signal);
      if (
        !(await timed(context.timings, 'global:accept', () =>
          acceptedPath(env, rule, target, stats, seen)
        ))
      ) {
        continue;
      }
      accepted.push(target);
      seen.add(target);
    }
    const paths = olderVersions(env, rule, accepted, stats);
    if (paths.length > 0) {
      found.push({ rule, base, paths });
    }
  }
  await timed(context.timings, 'global:resolve', () =>
    resolvePaths(
      context,
      found.flatMap((entry) => entry.paths)
    )
  );
  const items = scanItems(context);
  // Deliver cheap native measurements before rules needing recursive activity
  // timestamps, so an emergency goal can avoid the expensive work entirely.
  found.sort(
    (a, b) => Number(requiresMtime(a.rule)) - Number(requiresMtime(b.rule))
  );
  // The report drops items below `minSize`; skipping them here saves their
  // liveness checks (Telegram media alone can hold 100k small files). In a
  // container the writable layer re-measures sizes later, so all are kept.
  const large = (entry) =>
    Boolean(env.writableLayer) ||
    entry.usage.bytes >= (options.minSizeBytes ?? 0);
  for (const { rule, base, paths } of found) {
    const usages = await timed(context.timings, 'global:measure', () =>
      env.usageMany(paths, { mtime: requiresMtime(rule), cache: true })
    );
    const accept = ageFilter(context, rule);
    const measured = paths
      .map((target) => ({ path: target, usage: usages.get(target) }))
      .filter((entry) => entry.usage && accept(entry.usage));
    const groups = rule.aggregate
      ? [measured]
      : measured.filter(large).map((entry) => [entry]);
    for (const group of groups.filter((g) => g.length > 0)) {
      const item = await timed(context.timings, 'global:item', () =>
        buildItem(context, rule, base, group, homes)
      );
      items.push(item);
      if ((await context.ready?.([item])) === false) {
        return items;
      }
    }
  }
  return items;
}

/**
 * Whether `target` or one of its ancestors is in `claimed`. Both come from
 * the same glob expansion, so ancestors compare as plain strings and the
 * cost is the path depth, not the number of claimed paths.
 */
function claimedAbove(env, target, claimed) {
  for (let dir = target; ; dir = env.path.dirname(dir)) {
    if (claimed.has(dir)) {
      return true;
    }
    if (env.path.dirname(dir) === dir) {
      return false;
    }
  }
}

/**
 * A temporary directory holding a Git work tree with a network remote,
 * outside every path another rule (or a parent clone) already claimed.
 */
async function tempClone(env, target, seen) {
  if (env.kind !== 'host' || claimedAbove(env, target, seen)) {
    return false;
  }
  try {
    // Other users' temporary directories are unreadable; that is no error.
    const { commonDir } = await gitDirectories(target);
    return (await networkRemotes(commonDir)).length > 0;
  } catch {
    return false;
  }
}

async function acceptedPath(env, rule, target, stats, seen = new Set()) {
  const name = env.path.basename(target);
  if (rule.excludeNames?.includes(name)) {
    return false;
  }
  if (rule.directoryOnly && stats.get(target)?.type !== 'dir') {
    return false;
  }
  if (rule.git === 'clone' && !(await tempClone(env, target, seen))) {
    return false;
  }
  if (rule.fileOnly && stats.get(target)?.type !== 'file') {
    return false;
  }
  if (
    rule.protectProfiles &&
    /(?:mcp|profile|userdata|user-data)/i.test(name)
  ) {
    return false;
  }
  if (!rule.markers) {
    return true;
  }
  const parent = env.path.dirname(
    target.replace(/[/\\]Service Worker[/\\].*$/, '')
  );
  return (
    await Promise.all(
      rule.markers.map((marker) => env.exists(env.path.join(parent, marker)))
    )
  ).some(Boolean);
}
