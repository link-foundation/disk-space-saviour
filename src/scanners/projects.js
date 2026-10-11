import { scanItems } from '../env/scope.js';
/**
 * Per-project dependency, build and cache directories (node_modules, target,
 * .venv, ...) found by walking the scan roots.
 *
 * A directory matches a rule when its name matches and the rule's markers
 * are present. Generic names (`build`, `lib`, `target`, `bin`) that fail
 * every rule are searched again below, with the remaining depth, so a
 * non-matching `build` directory never hides real projects inside it.
 *
 * Cargo `target` directories additionally yield `cargo-superseded` items:
 * older build hashes that a newer build of the same unit replaced (see
 * `rust.js`).
 */

import { ECOSYSTEMS, PROJECT_RULES } from '../rules/ecosystems.js';
import { block, makeItem } from '../items.js';
import { isWithin, matchesGlob } from '../paths.js';
import { listMany, olderThan, scanTimeBusy } from './common.js';
import { analyzeRustProfile, findRustProfiles } from './rust.js';

const ECOSYSTEM_NAMES = new Map(ECOSYSTEMS.map((e) => [e.id, e.name]));

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
  const globs = [...new Set(rules.flatMap((rule) => rule.names))];
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
        const remaining = depth - depthBelow(env, dirs, match.candidate.path);
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

function siblingActivity(candidate, globs) {
  return (candidate.siblings ?? [])
    .filter(
      (entry) =>
        entry.name !== candidate.name &&
        !globs.some((glob) => matchesGlob(entry.name, glob))
    )
    .reduce((newest, entry) => Math.max(newest, entry.mtimeMs ?? 0), 0);
}

function projectTier(context, rule, lastActivityMs) {
  if (rule.kind === 'cache') {
    return { tier: 'safe', reason: 'cache, re-created on demand' };
  }
  const { inactiveMs } = context.options;
  if (olderThan(context, lastActivityMs, inactiveMs)) {
    return {
      tier: rule.id === 'node-modules' ? 'safe' : 'moderate',
      reason: 'project inactive, re-created by the build or install step',
    };
  }
  return {
    tier: 'aggressive',
    reason: 'project recently active, re-created by the build or install step',
  };
}

/** Re-evaluate activity before cleaning a reused project plan. */
export async function currentProjectTier(context, item) {
  const rule = PROJECT_RULES.find((entry) => entry.id === item.rule);
  if (!rule || rule.kind === 'cache') {
    return item.tier;
  }
  const globs = [...new Set(PROJECT_RULES.flatMap((entry) => entry.names))];
  const parent = context.env.path.dirname(item.path);
  const candidate = {
    name: context.env.path.basename(item.path),
    siblings: await context.env.list(parent),
  };
  context.git.invalidate();
  const activity = await projectActivity(
    context,
    item.project,
    candidate,
    { newestMtimeMs: item.newestMtimeMs },
    globs
  );
  return projectTier(context, rule, activity).tier;
}

async function addBlockers(context, item, requireClean) {
  for (const reason of await context.git.pathBlockers(item.path, {
    requireClean,
  })) {
    block(item, reason);
  }
  const busy = await scanTimeBusy(context, item);
  if (busy) {
    block(item, `busy: ${busy}`);
  }
}

async function projectActivity(context, project, candidate, usage, globs) {
  const { env, git } = context;
  const repo = await git.findRepoRoot(project);
  const lastCommitMs = repo ? (await git.repoState(repo)).lastCommitMs : 0;
  context.projectUsage ??= new Map();
  if (!context.projectUsage.has(project)) {
    context.projectUsage.set(
      project,
      env.projectActivity
        ? await env.projectActivity(
            project,
            globs,
            context.now - context.options.inactiveMs
          )
        : (await env.usage(project))?.newestMtimeMs
    );
  }
  const projectUsage = context.projectUsage.get(project);
  return Math.max(
    usage?.newestMtimeMs ?? 0,
    projectUsage ?? 0,
    siblingActivity(candidate, globs),
    lastCommitMs
  );
}

async function projectItem(context, { candidate, rule }, usage, globs) {
  const { env } = context;
  const project = rule.parentName
    ? env.path.dirname(candidate.parent)
    : candidate.parent;
  const lastActivityMs = await projectActivity(
    context,
    project,
    candidate,
    usage,
    globs
  );
  const item = makeItem(env, {
    rule: rule.id,
    kind: rule.kind,
    ecosystem: rule.ecosystem,
    description: `${ECOSYSTEM_NAMES.get(rule.ecosystem)} ${rule.description}`,
    path: candidate.path,
    bytes: usage?.bytes ?? 0,
    sizeEstimated: Boolean(usage?.estimated),
    newestMtimeMs: usage?.newestMtimeMs ?? 0,
    lastActivityMs,
    project,
    lockfiles: rule.lockfiles ?? null,
    ...projectTier(context, rule, lastActivityMs),
    checks: { busy: rule.busy ?? [], cwd: project, mtime: true },
  });
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
  const globs = [...new Set(rules.flatMap((rule) => rule.names))];
  const items = scanItems(context);
  await findProjectDirs(env, options.roots, {
    rules,
    maxDepth: options.maxDepth,
    includeRoots: options.includeRoots,
    onMatches: async (matches) => {
      const usages = await env.usageMany(
        matches.map((match) => match.candidate.path),
        { cache: true }
      );
      for (const match of matches) {
        const usage = usages.get(match.candidate.path);
        if (!usage) {
          continue;
        }
        const item = await projectItem(context, match, usage, globs);
        items.push(item);
        if (match.rule.id === 'cargo-target') {
          items.push(...(await rustItems(context, item, match.rule)));
        }
      }
    },
  });
  return items;
}
