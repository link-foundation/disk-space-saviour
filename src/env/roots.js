/**
 * Effective scan roots of one environment and the scope report that makes
 * them visible.
 *
 * Root semantics (also documented in README "Scan roots"):
 * - host: `roots` (positional paths) or, when none, the homes and temporary
 *   directories;
 * - container (every Docker level): `containerRoots` replaces the defaults
 *   when given; otherwise the defaults (homes, temporary directories and
 *   the common workspace paths in CONTAINER_ROOTS that exist) plus every
 *   host `roots` path that also exists inside that container. Host and
 *   container namespaces differ, so a host root absent from a container is
 *   reported as `absent`; paths are never guessed or remapped.
 * The same requested roots reach the traversal policy (mount selection)
 * and project discovery, so both always agree.
 */
import { existingPaths, matchesExcluded } from '../paths.js';

/** Common project locations inside containers, scanned when present. */
export const CONTAINER_ROOTS = [
  '/workspace',
  '/workspaces',
  '/app',
  '/src',
  '/code',
  '/project',
  '/usr/src/app',
];

/** Roots explicitly requested for `env` (null when only defaults apply). */
export function requestedRoots(env, options, overrides = {}) {
  if (overrides.roots) {
    return overrides.roots;
  }
  if (env.kind === 'container') {
    return options.containerRoots ?? options.roots ?? null;
  }
  return options.roots ?? null;
}

const unique = (list) => [...new Set(list)];

/**
 * Resolves the roots project discovery walks plus one scope entry per
 * considered root.
 * @returns {Promise<{roots: string[], entries: object[]}>}
 */
export async function resolveRoots(env, options, overrides, homes, tmpDirs) {
  const entries = [];
  const add = (path, source) => {
    if (!entries.some((entry) => entry.path === path)) {
      entries.push({ path, source });
    }
  };
  if (overrides.roots) {
    overrides.roots.forEach((root) => add(root, 'roots'));
  } else if (env.kind === 'container' && options.containerRoots) {
    options.containerRoots.forEach((root) => add(root, 'container-roots'));
  } else if (env.kind !== 'container' && options.roots) {
    options.roots.forEach((root) => add(root, 'roots'));
  } else {
    homes.forEach((root) => add(root, 'home'));
    tmpDirs.forEach((root) => add(root, 'tmp'));
    if (env.kind === 'container') {
      const present = await existingPaths(env, CONTAINER_ROOTS);
      CONTAINER_ROOTS.filter((root) => present.has(root)).forEach((root) =>
        add(root, 'container-default')
      );
      (options.roots ?? []).forEach((root) => add(root, 'roots'));
    }
  }
  await classify(env, options, entries);
  return {
    roots: unique(
      entries.filter((entry) => entry.status === 'pending').map((e) => e.path)
    ),
    entries,
  };
}

async function classify(env, options, entries) {
  const policy = env.scanPolicy;
  const allowed = entries.filter((entry) => {
    if (matchesExcluded(entry.path, options.exclude ?? [], env.path)) {
      entry.status = 'excluded';
      return false;
    }
    if (policy && !policy.allows(entry.path)) {
      entry.status = 'pruned';
      return false;
    }
    return true;
  });
  const present = allowed.length
    ? await existingPaths(
        env,
        allowed.map((entry) => entry.path)
      )
    : new Set();
  for (const entry of allowed) {
    entry.status = present.has(entry.path) ? 'pending' : 'absent';
  }
}

/** Scope descriptor stored on the environment and copied into reports. */
export function scanScope(env, options, entries) {
  return {
    roots: entries.map((entry) => ({ ...entry })),
    maxDepth: options.maxDepth,
    exclude: [...(options.exclude ?? [])],
    prunedMounts: [...(env.scanPolicy?.pruned ?? [])],
    note:
      'scanStatus "complete" means complete within these roots, maxDepth, ' +
      'exclusions and mount boundaries; fixed cache, toolchain and agent ' +
      'locations are checked independently of roots',
  };
}

/** Final per-root status when the scanners of the environment finish. */
export function finishScope(env, ranProjects) {
  const scope = env.scanScope;
  if (!scope) {
    return;
  }
  const denied = new Set(env.accessErrors?.keys() ?? []);
  for (const root of scope.roots) {
    if (root.status !== 'pending') {
      continue;
    }
    if (denied.has(root.path)) {
      root.status = 'inaccessible';
    } else if (!ranProjects) {
      root.status = 'not-searched';
    } else {
      root.status = env.scanStatus === 'complete' ? 'searched' : 'partial';
    }
  }
}
