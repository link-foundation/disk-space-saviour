import { performance } from 'node:perf_hooks';

import { scanItems } from '../env/scope.js';
/**
 * Per-project dependency, build and cache directories (node_modules, target,
 * .venv, ...) found by walking the scan roots.
 *
 * A directory matches a rule when its name matches and the rule's markers
 * are present. Generic names (`build`, `lib`, `target`, `bin`) that fail
 * every rule are searched again below, with the remaining depth, so a
 * non-matching `build` directory never hides real projects inside it.
 * Git worktree folders (`.worktrees`, `worktrees`, `.claude/worktrees`)
 * hold whole checkouts, so the search below them starts with the full
 * depth again: an agent's worktree deep in a project is a project too.
 *
 * Cargo `target` directories additionally yield `cargo-superseded` items:
 * older build hashes that a newer build of the same unit replaced (see
 * `rust.js`).
 */

import { ECOSYSTEMS, PROJECT_RULES } from '../rules/ecosystems.js';
import { block, makeItem } from '../items.js';
import { isWithin, matchesGlob } from '../paths.js';
import { listMany, scanTimeBusy } from './common.js';
import { analyzeRustProfile, findRustProfiles } from './rust.js';
import { foreignDataBlocker } from './node-modules.js';
import { timed } from '../timings.js';

const ECOSYSTEM_NAMES = new Map(ECOSYSTEMS.map((e) => [e.id, e.name]));
const WORKTREE_DIRS = ['.worktrees', 'worktrees'];

function anyMatch(entries, globs) {
  return (entries ?? []).some((entry) =>
    globs.some((glob) => matchesGlob(entry.name, glob))
  );
}

function depthBelow(env, roots, target) {
  const root = roots
    .filter((candidate) => isWithin(target, candidate, env.path))
    .sort((a, b) => b.length - a.length)[0];
  return env.path.relative(root, target).split(/[\\/]/).filter(Boolean).length;
}

/** Depth left below a directory no rule claims; worktrees start afresh. */
function remainingDepth(env, dirs, candidate, { depth, maxDepth }) {
  return WORKTREE_DIRS.includes(candidate.name)
    ? maxDepth
    : depth - depthBelow(env, dirs, candidate.path);
}

function ruleAccepts(env, rule, candidate, selfListing, grandListing) {
  if (rule.markers && !anyMatch(candidate.siblings, rule.markers)) {
    return false;
  }
  if (rule.selfMarkers && !anyMatch(selfListing, rule.selfMarkers)) {
    return false;
  }
  if (rule.parentName) {
    if (env.path.basename(candidate.parent) !== rule.parentName) {
      return false;
    }
    if (rule.parentMarkers && !anyMatch(grandListing, rule.parentMarkers)) {
      return false;
    }
  }
  if (
    rule.lockfiles &&
    !anyMatch(
      rule.parentName ? grandListing : candidate.siblings,
      rule.lockfiles
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Pairs every found directory with the first rule it satisfies (or null).
 */
async function matchRules(env, found, rules) {
  // Refresh markers and activity; the discovery index only supplies hints.
  const parents = await listMany(env, [
    ...new Set(found.map((candidate) => candidate.parent)),
  ]);
  found = found.map((candidate) => ({
    ...candidate,
    siblings: parents.get(candidate.parent) ?? [],
  }));
  const options = found.map((candidate) => ({
    candidate,
    rules: rules.filter((rule) =>
      rule.names.some((glob) => matchesGlob(candidate.name, glob))
    ),
  }));
  const selfDirs = options
    .filter((o) => o.rules.some((rule) => rule.selfMarkers))
    .map((o) => o.candidate.path);
  const grandDirs = options
    .filter((o) =>
      o.rules.some(
        (rule) => rule.parentName === env.path.basename(o.candidate.parent)
      )
    )
    .map((o) => env.path.dirname(o.candidate.parent));
  const selfListings = await listMany(env, selfDirs);
  const grandListings = await listMany(env, [...new Set(grandDirs)]);
  return options.map(({ candidate, rules: possible }) => ({
    candidate,
    rule:
      possible.find((rule) =>
        ruleAccepts(
          env,
          rule,
          candidate,
          selfListings.get(candidate.path),
          grandListings.get(env.path.dirname(candidate.parent))
        )
      ) ?? null,
  }));
}

async function rootCandidates(env, roots) {
  const candidates = [];
  for (const root of roots) {
    const parent = env.path.dirname(root);
    if (parent === root) {
      continue;
    }
    const siblings = await env.list(parent);
    candidates.push({
      path: root,
      name: env.path.basename(root),
      parent,
      siblings,
    });
  }
  return candidates;
}

async function indexedMatches(env, roots, globs, maxDepth, rules) {
  const candidates = (await env.indexedDirs?.(roots, globs, maxDepth)) ?? [];
  return matchRules(env, candidates, rules);
}

/**
 * Finds every rule match below the roots.
 * @returns {Promise<Array<{candidate: object, rule: object}>>}
 */
export async function findProjectDirs(env, roots, options = {}) {
  const rules = options.rules ?? PROJECT_RULES;
  const maxDepth = options.maxDepth ?? 6;
  const globs = [
    ...new Set([...rules.flatMap((rule) => rule.names), ...WORKTREE_DIRS]),
  ];
  const matches = [];
  const seen = new Set();
  const accept = (match) => {
    if (!match.rule || seen.has(match.candidate.path)) {
      return;
    }
    seen.add(match.candidate.path);
    matches.push(match);
    return match;
  };
  const indexed = await indexedMatches(env, roots, globs, maxDepth, rules);
  await options.onMatches?.(indexed.map(accept).filter(Boolean));
  if (options.includeRoots) {
    const self = await matchRules(env, await rootCandidates(env, roots), rules);
    const accepted = self.map(accept).filter(Boolean);
    await options.onMatches?.(accepted);
  }
  let frontier = new Map([[maxDepth, roots]]);
  while (frontier.size > 0) {
    const next = new Map();
    for (const [depth, dirs] of frontier) {
      const found = await env.findDirs(dirs, { globs, maxDepth: depth });
      const accepted = [];
      for (const match of await matchRules(env, found, rules)) {
        if (match.rule) {
          const fresh = accept(match);
          if (fresh) {
            accepted.push(fresh);
          }
          continue;
        }
        const remaining = remainingDepth(env, dirs, match.candidate, {
          depth,
          maxDepth,
        });
        if (remaining > 0) {
          next.set(remaining, [
            ...(next.get(remaining) ?? []),
            match.candidate.path,
          ]);
        }
      }
      await options.onMatches?.(accepted);
    }
    frontier = next;
  }
  return matches;
}

/**
 * Project caches, build outputs and dependencies are all regenerable, so how
 * recently the project was used does not matter: only liveness (a tool
 * running in the project, open files, recent writes) and Git safety block
 * them.
 */
function projectTier(rule) {
  return rule.kind === 'cache'
    ? { tier: 'safe', reason: 'cache, re-created on demand' }
    : { tier: 'safe', reason: 're-created by the build or install step' };
}

async function addBlockers(context, item, requireClean) {
  const reasons = await timed(context.timings, 'projects:git', () =>
    context.git.pathBlockers(item.path, { requireClean })
  );
  for (const reason of reasons) {
    block(item, reason);
  }
  const busy = await timed(context.timings, 'projects:busy', () =>
    scanTimeBusy(context, item)
  );
  if (busy) {
    block(item, `busy: ${busy}`);
  }
}

async function projectItem(context, { candidate, rule }, usage) {
  const { env } = context;
  const project = rule.parentName
    ? env.path.dirname(candidate.parent)
    : candidate.parent;
  const item = makeItem(env, {
    rule: rule.id,
    kind: rule.kind,
    ecosystem: rule.ecosystem,
    description: `${ECOSYSTEM_NAMES.get(rule.ecosystem)} ${rule.description}`,
    path: candidate.path,
    bytes: usage?.bytes ?? 0,
    sizeEstimated: Boolean(usage?.estimated),
    newestMtimeMs: usage?.newestMtimeMs ?? 0,
    project,
    lockfiles: rule.lockfiles ?? null,
    ...projectTier(rule),
    checks: { busy: rule.busy ?? [], cwd: project, mtime: true },
  });
  if (rule.id === 'node-modules') {
    block(
      item,
      await timed(context.timings, 'projects:contents', () =>
        foreignDataBlocker(env, candidate.path)
      )
    );
  }
  await addBlockers(context, item, false);
  return item;
}

const RUST_PARTS = {
  library: {
    rule: 'cargo-superseded',
    description: (part) =>
      `superseded cargo artifacts (${part.removed} old units, ${part.kept} kept)`,
    reason: 'older build hashes replaced by a newer build of the same unit',
  },
  leaf: {
    rule: 'cargo-superseded-leaf',
    description: (part) =>
      `idle cargo incremental caches and superseded test/example binaries (${part.removed} old, ${part.kept} kept)`,
    reason:
      'nothing links against them; removable while cargo runs, files in use are skipped',
  },
};

/**
 * One item per part and profile. The library part is busy while cargo or
 * rustc runs in the project. The leaf part ignores running tools and drops
 * only the paths that a process holds open (`checks.perPath`).
 */
async function rustItems(context, targetItem, rule) {
  const { env, liveness, options, now } = context;
  const items = scanItems(context);
  const semverPath = env.path.join(targetItem.path, 'semver-checks');
  const semverUsage = await env.usage(semverPath, { cache: true });
  if (semverUsage) {
    const semver = makeItem(env, {
      rule: 'cargo-semver-checks-cache',
      kind: 'cache',
      ecosystem: 'rust',
      description: 'cargo-semver-checks baseline builds',
      path: semverPath,
      bytes: semverUsage.bytes,
      sizeEstimated: Boolean(semverUsage.estimated),
      newestMtimeMs: semverUsage.newestMtimeMs,
      project: targetItem.project,
      parentId: targetItem.id,
      tier: 'safe',
      reason: 'baseline rustdoc and builds are regenerated on demand',
      checks: {
        busy: ['cargo-semver-checks', ...rule.busy],
        cwd: targetItem.project,
        mtime: true,
      },
    });
    await addBlockers(context, semver, false);
    items.push(semver);
  }
  for (const profile of await findRustProfiles(env, targetItem.path)) {
    const result = await analyzeRustProfile(env, profile, {
      staleAgeMs: options.staleAgeMs,
      now,
    });
    for (const [name, spec] of Object.entries(RUST_PARTS)) {
      const part = result[name];
      const leaf = name === 'leaf';
      const open = leaf
        ? (liveness?.openPathsOf(part.entries.map((e) => e.path)) ?? new Map())
        : new Map();
      const entries = part.entries.filter((entry) => !open.has(entry.path));
      if (entries.length === 0) {
        continue;
      }
      const item = makeItem(env, {
        rule: spec.rule,
        kind: 'build',
        ecosystem: 'rust',
        description: spec.description(part),
        path: profile,
        paths: entries.map((entry) => entry.path),
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        newestMtimeMs: Math.max(...entries.map((entry) => entry.mtimeMs)),
        project: targetItem.project,
        tier: 'safe',
        reason: spec.reason,
        parentId: targetItem.id,
        recheck: { type: 'rust', profile, part: name },
        checks: leaf
          ? { busy: [], cwd: targetItem.project, mtime: true, perPath: true }
          : { busy: rule.busy, cwd: targetItem.project, mtime: true },
      });
      await addBlockers(context, item, false);
      items.push(item);
    }
  }
  return items;
}

/**
 * Scans project trees below `context.options.roots`.
 * @returns {Promise<object[]>} report items
 */
export async function scanProjects(context, { rules = PROJECT_RULES } = {}) {
  const { env, options } = context;
  const items = scanItems(context);
  const started = performance.now();
  // Matches are measured while the walk continues; `projects:walk` excludes
  // that time, which `projects:measure`, `projects:git` and `projects:busy`
  // record.
  let streamedMs = 0;
  try {
    await findProjectDirs(env, options.roots, {
      rules,
      maxDepth: options.maxDepth,
      includeRoots: options.includeRoots,
      onMatches: async (matches) => {
        const streamStarted = performance.now();
        try {
          await projectMatches(context, matches, items);
        } finally {
          streamedMs += performance.now() - streamStarted;
        }
      },
    });
  } finally {
    context.timings?.record(
      'projects:walk',
      performance.now() - started - streamedMs
    );
  }
  return items;
}

async function projectMatches(context, matches, items) {
  const usages = await timed(context.timings, 'projects:measure', () =>
    context.env.usageMany(
      matches.map((match) => match.candidate.path),
      { cache: true }
    )
  );
  for (const match of matches) {
    const usage = usages.get(match.candidate.path);
    if (!usage) {
      continue;
    }
    const item = await projectItem(context, match, usage);
    items.push(item);
    if (match.rule.id === 'cargo-target') {
      items.push(...(await rustItems(context, item, match.rule)));
    }
  }
}
