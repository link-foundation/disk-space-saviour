/**
 * Liveness checks: is anything using a path right now?
 *
 * Independent signals, any of which blocks deletion:
 * - recent writes: newest file mtime inside the stale-age window;
 * - a relevant tool is running (by process name), optionally only when its
 *   working directory is inside the project;
 * - a process holds a file, working directory, or executable inside the path
 *   (`/proc/<pid>/{fd,cwd,exe}` on Linux, `lsof` on macOS).
 * - a command argument names a path inside the item (including scripts
 *   whose interpreter has already closed its input descriptor);
 * - a directory inside the item is on a process's `PATH`, so the process
 *   may start a program from it at any time.
 *
 * The cleaner refreshes the probe right before acting on each item.
 */

import path from 'node:path';

import {
  bundleRoots,
  bundlesOwn,
  ownerBundleId,
  processBundles,
} from './app-owners.js';
import { isWithin } from './paths.js';
import { formatDuration } from './units.js';

const PROC_COMM_LIMIT = 15;

/** Bun subcommands that read or write the install cache. */
const BUN_PACKAGE_COMMANDS = new Set([
  'install',
  'i',
  'add',
  'a',
  'remove',
  'rm',
  'update',
  'upgrade',
  'outdated',
  'link',
  'unlink',
  'pm',
  'x',
  'create',
  'c',
  'init',
  'patch',
  'publish',
  'audit',
  'why',
  'info',
]);

function isBun(proc) {
  return Boolean(matchingName(proc, ['bun', 'bunx']));
}

function bunPackageCommand(proc) {
  const args = processArgs(proc);
  if (path.posix.basename(args[0] ?? '') === 'bunx' || proc.name === 'bunx') {
    return true;
  }
  const command = args.slice(1).find((arg) => !arg.startsWith('-'));
  return BUN_PACKAGE_COMMANDS.has(command);
}

function uncertaintyRoots(proc) {
  const roots = processArgs(proc).flatMap((arg) => {
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    return value.startsWith('/') ? [value] : [];
  });
  if (proc.name === 'dockerd') {
    roots.push('/var/lib/docker', '/run');
  }
  if (proc.name === 'containerd') {
    roots.push('/var/lib/containerd', '/run/containerd');
  }
  return roots;
}

function couldAccess(proc, stat) {
  return (
    proc.uid === 0 ||
    typeof proc.uid !== 'number' ||
    !stat ||
    stat.uid === undefined ||
    stat.uid === proc.uid ||
    stat.mode === undefined ||
    (stat.mode & 0o007) !== 0 ||
    // Group bits can also be an ACL mask granting another named identity.
    (stat.mode & 0o070) !== 0
  );
}

function ancestors(target, pathApi) {
  const result = [];
  for (
    let dir = pathApi.dirname(target);
    dir !== pathApi.dirname(dir);
    dir = pathApi.dirname(dir)
  ) {
    result.push(dir);
  }
  return result;
}

function nameMatches(name, candidate) {
  return (
    name === candidate ||
    (name.length === PROC_COMM_LIMIT &&
      candidate.startsWith(name) &&
      candidate.length > PROC_COMM_LIMIT)
  );
}

/** Arguments preserved by /proc; command titles are a fallback. */
export function processArgs(proc) {
  return (
    proc.argv ??
    (proc.command ?? '')
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((arg) => arg.replace(/^["']|["']$/g, '')) ??
    []
  );
}

function scriptIndex(args) {
  const first = path.posix.basename(args[0] ?? '');
  if (!/^(node|nodejs|bun|deno|python[\d.]*|bash|sh)$/.test(first)) {
    return 0;
  }
  // Only the interpreter's script operand; option values and arbitrary
  // arguments are not executable names.
  let index = 1;
  while (args[index]?.startsWith('-')) {
    if (['-e', '--eval', '-p', '--print', '-c'].includes(args[index])) {
      return -1;
    }
    index += ['-r', '--require', '--import', '--loader'].includes(args[index])
      ? 2
      : 1;
  }
  return index;
}

function commandNames(proc) {
  const args = processArgs(proc);
  const first = path.posix.basename(args[0] ?? '');
  const names = [first];
  if (/^npm(?: |$)/.test(proc.name ?? '') || /^npm(?: |$)/.test(first)) {
    names.push('npm');
  }
  const index = scriptIndex(args);
  if (index > 0) {
    const script = path.posix.basename(args[index] ?? '');
    names.push(
      script,
      ...(script === 'npm-cli.js' ? ['npm'] : []),
      ...(script === 'npx-cli.js' ? ['npx'] : [])
    );
  }
  // An explicit npm launcher package is also a tool (e.g. Playwright MCP).
  if (isNpmExec(proc)) {
    const packageArg = args.find((arg) => /^@[^/]+\/[^/]+$/.test(arg));
    if (packageArg) {
      names.push(packageArg.slice(1).split('/')[0]);
    }
  }
  return names;
}

export function isNpmExec(proc) {
  const args = processArgs(proc);
  const index = scriptIndex(args);
  const executable = path.posix.basename(args[Math.max(index, 0)] ?? '');
  return (
    /^npm (exec|x)(?: |$)|^npx(?: |$)/.test(proc.name ?? '') ||
    /^npm (exec|x)(?: |$)|^npx(?: |$)/.test(args[0] ?? '') ||
    (index >= 0 &&
      (['npx', 'npx-cli.js'].includes(executable) ||
        (['npm', 'npm-cli.js'].includes(executable) &&
          ['exec', 'x'].includes(args[index + 1]))))
  );
}

/**
 * Name of `proc` that matches one of `names`, or null. Besides the kernel
 * name (`comm`, which programs may rename: Node.js calls its main thread
 * `MainThread`), processes carry `aliases`: the executable and `argv[0]`
 * base names.
 */
export function matchingName(proc, names) {
  const own = [proc.name ?? '', ...(proc.aliases ?? []), ...commandNames(proc)];
  for (const name of own) {
    if (name && names.some((candidate) => nameMatches(name, candidate))) {
      return name;
    }
  }
  return null;
}

/** `matched`, prefixed with the app it runs from: `Warp (stable)`. */
function appLabel(proc, matched) {
  const app = proc.bundles?.[0]?.name;
  return app && app !== matched ? `${app} (${matched})` : matched;
}

export class LivenessProbe {
  /**
   * @param {object} env environment adapter
   * @param {{staleAgeMs: number, now?: () => number, refreshMs?: number}} options
   */
  constructor(env, { staleAgeMs, now = () => Date.now(), refreshMs = 2000 }) {
    this.env = env;
    this.staleAgeMs = staleAgeMs;
    this.now = now;
    this.refreshMs = refreshMs;
    this.refreshedAt = -Infinity;
    this.processes = [];
    this.openPaths = null;
    this.probeError = false;
    this.realPaths = new Map();
    this.pathOwners = new Map();
    this.pathStats = new Map();
    this.inodes = new Map();
    // Bundle identifiers never change, so they outlive refreshes.
    this.bundleIds = new Map();
  }

  async refresh(force = false) {
    if (!force && this.now() - this.refreshedAt < this.refreshMs) {
      return;
    }
    this.openPaths = await this.env.openPaths().catch(() => null);
    const processes = await this.env.processes().catch(() => null);
    this.listed = processes !== null;
    this.processes = processes ?? [];
    this.bunCacheUsers = await this.#bunCacheUsers();
    await this.#resolveBundles();
    this.probeError =
      (processes === null || this.openPaths === null) &&
      (this.env.platform === 'linux' || this.env.platform === 'darwin');
    this.refreshedAt = this.now();
    this.realPaths.clear();
    this.pathStats.clear();
    this.pathOwners.clear();
    this.inodes.clear();
  }

  /** Reads the identifiers of the app bundles running processes come from. */
  async #resolveBundles() {
    if (!this.env.bundleIdentifier) {
      return;
    }
    for (const proc of this.processes) {
      const roots = bundleRoots(proc.executable);
      for (const root of roots) {
        if (!this.bundleIds.has(root)) {
          this.bundleIds.set(
            root,
            await this.env.bundleIdentifier(root).catch(() => null)
          );
        }
      }
      proc.bundles = processBundles(roots, this.bundleIds);
    }
  }

  /** ` (pid N, name)` of the process holding `open`, when the probe knows it. */
  #holder(open) {
    const pid = this.env.openPathPids?.get(open);
    if (!pid) {
      return '';
    }
    const proc = this.processes.find((entry) => entry.pid === pid);
    return proc
      ? ` (pid ${pid}, ${appLabel(proc, proc.name)})`
      : ` (pid ${pid})`;
  }

  /** A running app that owns a per-app Library folder of `paths`. */
  appUsage(paths) {
    const owners = [...new Set(paths.map(ownerBundleId).filter(Boolean))];
    if (owners.length === 0) {
      return null;
    }
    for (const proc of this.processes) {
      const owner = owners.find((id) => bundlesOwn(proc.bundles ?? [], id));
      if (owner) {
        return `${appLabel(proc, proc.name)} is running (pid ${proc.pid}) and owns ${owner}`;
      }
    }
    return null;
  }

  /**
   * Inodes of `executables` and of the open files that share their names,
   * because a process running a hard link of an executable reports
   * whichever path it was started from.
   * @param {string[]} [executables]
   */
  async resolveExecutables(executables = []) {
    if (executables.length === 0) {
      return;
    }
    const names = new Set(
      executables.map((target) => this.env.path.basename(target))
    );
    const missing = [
      ...executables,
      ...[...(this.openPaths ?? [])].filter((open) =>
        names.has(this.env.path.basename(open))
      ),
    ].filter((target) => !this.inodes.has(target));
    const stats = await Promise.all(
      missing.map((target) => this.env.stat(target))
    );
    missing.forEach((target, index) =>
      this.inodes.set(target, stats[index]?.inode ?? null)
    );
  }

  /** A process running one of `executables` under any of its links. */
  executableUsage(executables = []) {
    for (const target of executables) {
      const inode = this.inodes.get(target);
      if (!inode) {
        continue;
      }
      for (const open of this.openPaths ?? []) {
        if (open !== target && this.inodes.get(open) === inode) {
          return `in use: ${open} is ${target}`;
        }
      }
    }
    return null;
  }

  /**
   * Pids of Bun processes that may use the install cache: package commands,
   * and anything else (scripts, tests, the REPL) without a `node_modules`
   * directory above its working directory, because Bun then auto-installs
   * from the cache. A long-running script of an installed project does not
   * read the cache, so it does not keep the cache busy.
   */
  async #bunCacheUsers() {
    const users = new Set();
    const installed = new Map();
    const hasModules = async (dir) => {
      if (!installed.has(dir)) {
        installed.set(
          dir,
          Boolean(
            await this.env.exists?.(this.env.path.join(dir, 'node_modules'))
          )
        );
      }
      return installed.get(dir);
    };
    for (const proc of this.processes) {
      if (!isBun(proc)) {
        continue;
      }
      if (bunPackageCommand(proc) || !proc.cwd || !this.env.exists) {
        users.add(proc.pid);
        continue;
      }
      let found = false;
      for (const dir of [proc.cwd, ...ancestors(proc.cwd, this.env.path)]) {
        if (await hasModules(dir)) {
          found = true;
          break;
        }
      }
      if (!found) {
        users.add(proc.pid);
      }
    }
    return users;
  }

  /** Processes of the last refresh, or null when they could not be listed. */
  processList() {
    return this.listed ? this.processes : null;
  }

  /**
   * Resolves symlinks in `paths` (cached), because processes report the
   * paths they hold open with symlinks resolved: a scan of `/var/folders`
   * on macOS must match `lsof` output under `/private/var/folders`.
   * @param {string[]} paths
   */
  async resolve(paths) {
    if (this.env.unreadableProcesses?.length) {
      const missing = [
        ...new Set(
          paths.flatMap((target) => [
            target,
            ...ancestors(target, this.env.path),
          ])
        ),
      ].filter((target) => !this.pathStats.has(target));
      const stats = this.env.statMany
        ? await this.env.statMany(missing)
        : new Map(
            await Promise.all(
              missing.map(async (target) => [
                target,
                await this.env.stat?.(target),
              ])
            )
          );
      for (const target of missing) {
        this.pathStats.set(target, stats.get(target));
        this.pathOwners.set(target, stats.get(target)?.uid);
      }
    }
    if (!this.env.realPath && !this.env.realPathMany) {
      return;
    }
    const missing = paths.filter((target) => !this.realPaths.has(target));
    const resolved = this.env.realPathMany
      ? await this.env.realPathMany(missing)
      : new Map(
          await Promise.all(
            missing.map(async (target) => [
              target,
              await this.env.realPath(target),
            ])
          )
        );
    for (const target of missing) {
      this.realPaths.set(target, resolved.get(target) ?? null);
    }
  }

  recentWrite(newestMtimeMs) {
    if (!newestMtimeMs || this.staleAgeMs <= 0) {
      return null;
    }
    const age = this.now() - newestMtimeMs;
    if (age < this.staleAgeMs) {
      return `modified ${formatDuration(Math.max(age, 0))} ago, inside the ${formatDuration(this.staleAgeMs)} activity window`;
    }
    return null;
  }

  runningTool(names, cwd, item = {}) {
    if (!names || names.length === 0) {
      return null;
    }
    const pathApi = this.env.path;
    for (const proc of this.processes) {
      if (
        ['npm-cache', 'node-gyp-cache', 'npx-cache'].includes(item.rule) &&
        isNpmExec(proc)
      ) {
        continue;
      }
      if (
        item.rule === 'bun-cache' &&
        isBun(proc) &&
        !this.bunCacheUsers?.has(proc.pid)
      ) {
        continue;
      }
      const matched = matchingName(proc, names);
      if (!matched) {
        continue;
      }
      const name = appLabel(proc, matched);
      if (!cwd) {
        return `${name} is running (pid ${proc.pid})`;
      }
      if (!proc.cwd) {
        return `${name} is running (pid ${proc.pid}, working directory unknown)`;
      }
      if (isWithin(proc.cwd, cwd, pathApi)) {
        return `${name} is running in ${proc.cwd} (pid ${proc.pid})`;
      }
    }
    return null;
  }

  openInside(paths) {
    if (!this.openPaths || paths.length === 0) {
      return null;
    }
    const pathApi = this.env.path;
    const targets = this.withRealPaths(paths);
    for (const open of this.openPaths) {
      for (const target of targets) {
        if (isWithin(open, target, pathApi)) {
          return `in use: ${open}${this.#holder(open)}`;
        }
      }
    }
    return null;
  }

  /**
   * Paths of `paths` that a process holds open, with the reason.
   * @param {string[]} paths
   * @returns {Map<string, string>}
   */
  openPathsOf(paths) {
    const open = new Map();
    for (const target of paths) {
      const reason = this.openInside([target]);
      if (reason) {
        open.set(target, reason);
      }
    }
    return open;
  }

  commandUsage(paths) {
    for (const proc of this.processes) {
      for (const arg of processArgs(proc)) {
        const candidate = arg.startsWith('/')
          ? arg
          : proc.cwd && !arg.startsWith('-')
            ? this.env.path.resolve(proc.cwd, arg)
            : null;
        if (
          candidate &&
          paths.some((target) => isWithin(candidate, target, this.env.path))
        ) {
          return `in use: ${candidate} (pid ${proc.pid})`;
        }
      }
    }
    return null;
  }

  /** `paths` plus their resolved forms, as processes report paths. */
  withRealPaths(paths) {
    return paths.flatMap((target) => {
      const real = this.realPaths.get(target);
      return real && real !== target ? [target, real] : [target];
    });
  }

  searchPathUsage(paths) {
    const targets = this.withRealPaths(paths);
    for (const proc of this.processes) {
      for (const dir of proc.searchPath ?? []) {
        if (targets.some((target) => isWithin(dir, target, this.env.path))) {
          return `on the PATH of ${proc.name || 'a process'} (pid ${proc.pid}): ${dir}`;
        }
      }
    }
    return null;
  }

  uncertainUsage(paths) {
    for (const proc of this.env.unreadableProcesses ?? []) {
      const args = processArgs(proc);
      const roots = uncertaintyRoots(proc);
      const scopedDaemon =
        proc.uid === 0 &&
        ['dockerd', 'containerd'].includes(proc.name) &&
        args.length > 0;
      for (const target of paths) {
        const intersects = roots.some(
          (root) =>
            isWithin(root, target, this.env.path) ||
            isWithin(target, root, this.env.path)
        );
        if (scopedDaemon && !intersects) {
          continue;
        }
        if (!intersects && this.inaccessible(proc, target)) {
          continue;
        }
        const stat = this.pathStats.get(target);
        if (intersects || couldAccess(proc, stat)) {
          return `unreadable process ${proc.name || 'unknown'} (pid ${proc.pid}, uid ${proc.uid ?? 'unknown'}) may use ${target}`;
        }
      }
    }
    return null;
  }

  inaccessible(proc, target) {
    if (proc.uid === 0 || typeof proc.uid !== 'number') {
      return false;
    }
    return ancestors(target, this.env.path).some((dir) => {
      const stat = this.pathStats.get(dir);
      if (
        !stat ||
        stat.mode === undefined ||
        stat.uid === proc.uid ||
        stat.mode & 0o001
      ) {
        return false;
      }
      const groupAccess = stat.mode & 0o010;
      return !groupAccess;
    });
  }

  /**
   * First reason the item is busy, or null when it is idle. Items with
   * `checks.perPath` leave open files to `openPathsOf`: the caller skips
   * those paths and keeps the item.
   * @param {object} item
   */
  busyReason(item) {
    const checks = item.checks ?? {};
    const paths = checks.perPath ? [] : (item.paths ?? []);
    return (
      this.installationBlocker(item.paths ?? []) ??
      this.probeBlocker() ??
      (checks.mtime === false ? null : this.recentWrite(item.newestMtimeMs)) ??
      this.runningTool(checks.busy, checks.cwd, item) ??
      this.appUsage(item.paths ?? []) ??
      this.processUsage(paths) ??
      this.executableUsage(checks.executables) ??
      this.uncertainUsage(item.paths ?? [])
    );
  }

  probeBlocker() {
    if (!this.probeError) {
      return null;
    }
    const diagnostic = this.env.probeDiagnostic;
    return `cannot verify process and open-file activity${diagnostic ? `: ${diagnostic}` : ''}`;
  }

  /** Open files, command arguments and PATH entries inside the paths. */
  processUsage(paths) {
    return (
      this.openInside(paths) ??
      this.commandUsage(paths) ??
      this.searchPathUsage(paths)
    );
  }

  installationBlocker(paths) {
    return paths.some((target) =>
      (this.env.protectedPaths ?? []).some(
        (root) =>
          isWithin(root, target, this.env.path) ||
          isWithin(target, root, this.env.path)
      )
    )
      ? 'dss current installation is protected'
      : null;
  }
}
