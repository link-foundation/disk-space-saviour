/**
 * A node_modules directory is regenerable only as far as package managers
 * fill it. Other data kept there (verification runs, evidence, hand-made
 * fixtures) survives no reinstall, so it keeps the whole directory.
 */

import { formatBytes } from '../units.js';

/**
 * Top-level entries package managers and the tools they run create:
 * links, lockfile copies, store and workspace state, and caches that
 * re-create themselves.
 */
const MANAGED_ENTRIES = new Set([
  '.bin',
  '.package-lock.json',
  '.modules.yaml',
  '.pnpm',
  '.pnpm-workspace-state.json',
  '.pnpm-workspace-state-v1.json',
  '.yarn-state.yml',
  '.yarn-integrity',
  '.yarn-metadata.json',
  '.store',
  '.staging',
  '.ignored',
  '.cache',
  '.vite',
  '.vite-temp',
  '.vitest',
  '.vitest-cache',
  '.deno',
  '.prisma',
  '.astro',
  '.mf',
  '.tmp',
  '.DS_Store',
]);

/**
 * Entries of `dir` no package manager installs, with their size; empty
 * leftovers are left out.
 * @returns {Promise<Array<{name: string, bytes: number}>>}
 */
export async function foreignEntries(env, dir) {
  const candidates = [];
  for (const entry of await env.list(dir)) {
    if (
      MANAGED_ENTRIES.has(entry.name) ||
      entry.name.startsWith('@') ||
      entry.type === 'symlink'
    ) {
      continue;
    }
    if (
      entry.type === 'dir' &&
      (await env.stat(env.path.join(entry.path, 'package.json')))
    ) {
      continue;
    }
    candidates.push(entry);
  }
  if (candidates.length === 0) {
    return [];
  }
  const usages = await env.usageMany(
    candidates.map((entry) => entry.path),
    { cache: true }
  );
  return candidates
    .map((entry) => ({ name: entry.name, usage: usages.get(entry.path) }))
    .filter(({ usage }) => usage && (usage.files ?? 1) > 0)
    .map(({ name, usage }) => ({ name, bytes: usage.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Blocker naming the foreign data inside `dir`, or null. */
export async function foreignDataBlocker(env, dir) {
  const foreign = await foreignEntries(env, dir);
  if (foreign.length === 0) {
    return null;
  }
  const names = foreign
    .slice(0, 3)
    .map((entry) => `${entry.name} (${formatBytes(entry.bytes)})`)
    .join(', ');
  const more = foreign.length > 3 ? ` and ${foreign.length - 3} more` : '';
  return `holds data no package manager installs: ${names}${more}; a reinstall does not re-create it, so move it out of node_modules first`;
}
