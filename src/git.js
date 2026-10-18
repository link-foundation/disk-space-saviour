/**
 * Git safety checks. Deleting inside a work tree is only allowed when it
 * cannot lose work:
 * - regenerable directories must not contain tracked files;
 * - removing a whole work tree (abandoned solver checkouts, containers)
 *   additionally requires no uncommitted changes, no commits missing from
 *   every remote (`git log --branches --not --remotes`), and no stashes.
 *
 * When Git itself is unavailable but a `.git` exists, the check fails
 * closed: the item is blocked.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trace } from './exec.js';
import { preservedWork } from './git-preserved.js';
import {
  advertisedCommits,
  attachedWorktrees,
  lsRemote,
  networkRemotes,
} from './git-remote.js';

const GIT_FLAGS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

const SAFE_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  // Git for Windows understands this MSYS path; Node's \\.\nul does not.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_PARAMETERS: '',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * The checkout's own Git directory (HEAD, index) and the common directory
 * holding refs and objects. Both are `<root>/.git` in a plain repository;
 * a linked worktree or a submodule has a `.git` file naming its directory,
 * and a linked worktree names the common directory in `commondir`.
 */
export async function gitDirectories(root) {
  const dotGit = path.join(root, '.git');
  const stat = await fsp.lstat(dotGit);
  let gitDir = dotGit;
  if (stat.isFile()) {
    const named = /^gitdir: (.+)$/m.exec(await fsp.readFile(dotGit, 'utf8'));
    if (!named) {
      throw new Error(`${dotGit} does not name a Git directory`);
    }
    gitDir = path.resolve(root, named[1].trim());
  } else if (!stat.isDirectory()) {
    throw new Error(`${dotGit} is neither a directory nor a gitdir file`);
  }
  const commonDir = await fsp
    .readFile(path.join(gitDir, 'commondir'), 'utf8')
    .then(
      (text) => path.resolve(gitDir, text.trim()),
      (error) => {
        if (error.code === 'ENOENT') {
          return gitDir;
        }
        throw error;
      }
    );
  if (!(await fsp.stat(path.join(commonDir, 'objects'))).isDirectory()) {
    throw new Error(`${commonDir} has no object database`);
  }
  return { gitDir, commonDir };
}

async function copyGitMetadata(source, dir, names, force) {
  for (const name of names) {
    await fsp
      .cp(path.join(source, name), path.join(dir, name), {
        recursive: true,
        force,
        errorOnExist: !force,
      })
      .catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
  }
}

/**
 * A metadata-only Git directory, with no repository-supplied config or hooks.
 * With `indexOnly`, refs and reflogs are left out: enough for `ls-files`,
 * which reads only HEAD, the index and the work tree.
 */
async function safeGitDirectory(root, callback, { indexOnly = false } = {}) {
  const { gitDir, commonDir } = await gitDirectories(root);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dss-safe-git-'));
  try {
    if (indexOnly) {
      await copyGitMetadata(gitDir, dir, ['HEAD', 'index'], false);
      await fsp.mkdir(path.join(dir, 'refs'));
    } else {
      await copyIndexAndRefs(gitDir, commonDir, dir);
    }
    await fsp.symlink(
      path.join(commonDir, 'objects'),
      path.join(dir, 'objects')
    );
    await fsp.writeFile(
      path.join(dir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'
    );
    return await callback(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function copyIndexAndRefs(gitDir, commonDir, dir) {
  await copyGitMetadata(
    commonDir,
    dir,
    ['packed-refs', 'shallow', 'refs', 'logs'],
    false
  );
  // Per-worktree state overrides the shared refs and reflogs.
  await copyGitMetadata(
    gitDir,
    dir,
    gitDir === commonDir
      ? ['HEAD', 'index']
      : ['HEAD', 'index', 'refs', 'logs'],
    true
  );
}

function countLines(text) {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

/**
 * Reasons a repository with `state` (see `GitInspector#repoState`) must not
 * be deleted, naming it `label`.
 * @returns {string[]}
 */
export function stateBlockers(label, state) {
  if (state.error) {
    return [`${label}: ${state.error}`];
  }
  const problems = [];
  if (state.dirty > 0 && !state.preservedOn) {
    problems.push(plural(state.dirty, 'uncommitted change'));
  }
  if (state.unpushed > 0) {
    problems.push(plural(state.unpushed, 'unpushed commit'));
  }
  if (state.stashes > 0) {
    problems.push(plural(state.stashes, 'stash entry', 'stash entries'));
  }
  return problems.length > 0
    ? [`Git repository ${label} has ${problems.join(', ')}`]
    : [];
}

export class GitInspector {
  /**
   * @param {object} env environment adapter
   */
  constructor(env, options = {}) {
    this.env = env;
    this.options = options;
    this.states = new Map();
    this.roots = new Map();
    this.remoteRefs = new Map();
    this.available = null;
  }

  async #git(root, args, safeDir = null, input = undefined) {
    const result = await this.env.run(
      [
        'git',
        ...GIT_FLAGS,
        '-C',
        root,
        ...(safeDir ? ['--git-dir', safeDir, '--work-tree', root] : []),
        ...args,
      ],
      { env: SAFE_GIT_ENV, input }
    );
    trace('git', root, args.join(' '), '->', result.code);
    return result;
  }

  async isAvailable() {
    this.available ??= await this.env.which('git');
    return this.available;
  }

  /**
   * Closest directory at or above `target` that contains `.git`, or null.
   * @param {string} target
   * @param {string} [stopAt] do not look above this directory
   */
  async findRepoRoot(target, stopAt) {
    const pathApi = this.env.path;
    let dir = target;
    const visited = [];
    for (;;) {
      if (this.roots.has(dir)) {
        const root = this.roots.get(dir);
        visited.forEach((entry) => this.roots.set(entry, root));
        return root;
      }
      visited.push(dir);
      if (await this.env.exists(pathApi.join(dir, '.git'))) {
        visited.forEach((entry) => this.roots.set(entry, dir));
        return dir;
      }
      const parent = pathApi.dirname(dir);
      if (parent === dir || dir === stopAt) {
        visited.forEach((entry) => this.roots.set(entry, null));
        return null;
      }
      dir = parent;
    }
  }

  /**
   * Uncommitted, unpushed and stashed work of a repository (cached).
   * @param {string} root
   * @returns {Promise<{root: string, error: string|null, dirty: number,
   *   unpushed: number, stashes: number, lastCommitMs: number}>}
   */
  repoState(root) {
    if (!this.states.has(root)) {
      this.states.set(root, this.#loadState(root));
    }
    return this.states.get(root);
  }

  /** Discard scan-time Git state before a deletion decision. */
  invalidate() {
    this.states.clear();
    this.roots.clear();
    this.remoteRefs.clear();
  }

  async #loadState(root) {
    const state = {
      root,
      error: null,
      dirty: 0,
      unpushed: 0,
      stashes: 0,
      lastCommitMs: 0,
    };
    if (!(await this.isAvailable())) {
      state.error = 'git is not installed, cannot verify the repository';
      return state;
    }
    try {
      return this.env.kind === 'host'
        ? await safeGitDirectory(root, (safeDir) =>
            this.#inspectState(root, state, safeDir)
          )
        : await this.#inspectState(root, state);
    } catch (error) {
      state.error = `cannot safely inspect Git repository: ${error.message}`;
      return state;
    }
  }

  async #inspectState(root, state, safeDir = null) {
    const git = (args) => this.#git(root, args, safeDir);
    const status = await git([
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    if (status.code !== 0) {
      state.error = `git status failed: ${status.stderr.trim() || `exit ${status.code}`}`;
      return state;
    }
    state.dirty = countLines(status.stdout);
    if (this.options.recognizePreserved && state.dirty > 0) {
      Object.assign(state, await preservedWork(root, git));
    }
    const unpushed = await git([
      'log',
      'HEAD',
      '--branches',
      '--not',
      '--remotes',
      '--oneline',
    ]);
    if (unpushed.code !== 0) {
      state.error = `git log failed: ${unpushed.stderr.trim() || `exit ${unpushed.code}`}`;
      return state;
    }
    state.unpushed = countLines(unpushed.stdout);
    const stashes = await git(['stash', 'list']);
    if (stashes.code !== 0) {
      state.error = `git stash list failed: ${stashes.stderr.trim() || `exit ${stashes.code}`}`;
      return state;
    }
    state.stashes = countLines(stashes.stdout);
    const last = await git(['log', '-1', '--format=%ct']);
    const seconds = Number(last.stdout.trim());
    state.lastCommitMs = Number.isFinite(seconds) ? seconds * 1000 : 0;
    return state;
  }

  /**
   * Reasons a whole repository must not be deleted.
   * @param {string} root
   * @returns {Promise<string[]>}
   */
  async repoBlockers(root) {
    return stateBlockers(root, await this.repoState(root));
  }

  /** Repositories at or below `target`. */
  async #repoRoots(target) {
    const dirs = await this.env.findDirs([target], {
      globs: ['.git'],
      maxDepth: 32,
      skipNames: [],
    });
    const files = await this.env.findFiles([target], {
      names: ['.git'],
      maxDepth: 32,
      skipNames: [],
    });
    return new Set([
      ...((await this.env.exists(this.env.path.join(target, '.git')))
        ? [target]
        : []),
      ...dirs.map((entry) => entry.parent),
      ...files.map((file) => this.env.path.dirname(file)),
    ]);
  }

  /** Protect an entire temporary work directory, including nested clones. */
  async treeBlockers(target, { allowNoRepo = false } = {}) {
    const roots = await this.#repoRoots(target);
    if (roots.size === 0) {
      if (allowNoRepo) {
        return [];
      }
      return [`${target}: no Git repository found; cannot verify work`];
    }
    if (roots.size > 50) {
      return [`${target}: too many repositories to verify safely`];
    }
    const blockers = [];
    for (const root of roots) {
      blockers.push(...(await this.repoBlockers(root)));
    }
    return blockers;
  }

  /**
   * Reasons a temporary clone must not be deleted. Every repository inside
   * `target` must have no uncommitted, unpushed or stashed work in any of
   * its worktrees, no linked worktree outside `target`, and every local
   * commit must be advertised by one of its https or ssh remotes.
   */
  async cloneBlockers(target) {
    if (this.env.kind !== 'host') {
      return [`${target}: remote copies are only verified on the host`];
    }
    if (!(await this.isAvailable())) {
      return [`${target}: git is not installed, cannot verify the repository`];
    }
    const roots = await this.#repoRoots(target);
    if (roots.size === 0) {
      return [`${target}: no Git repository found; cannot verify work`];
    }
    if (roots.size > 50) {
      return [`${target}: too many repositories to verify safely`];
    }
    const blockers = [];
    for (const root of roots) {
      blockers.push(...(await this.#cloneRootBlockers(root, target)));
    }
    return blockers;
  }

  async #cloneRootBlockers(root, target) {
    let commonDir;
    try {
      ({ commonDir } = await gitDirectories(root));
    } catch (error) {
      return [`${root}: ${error.message}`];
    }
    const inside = (dir) => {
      const relative = path.relative(target, dir);
      return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      );
    };
    const { trees, detached } = await attachedWorktrees(commonDir);
    // Deleting the repository strands every worktree that shares it.
    const affected = inside(commonDir) ? [root, ...trees] : [root];
    const blockers = [];
    for (const tree of new Set(affected)) {
      if (!inside(tree)) {
        blockers.push(`linked worktree ${tree} uses the repository in ${root}`);
      } else if (await this.env.exists(path.join(tree, '.git'))) {
        blockers.push(...(await this.repoBlockers(tree)));
      }
    }
    if (blockers.length > 0) {
      return blockers;
    }
    return this.#remoteBlockers(root, commonDir, detached);
  }

  async #remoteBlockers(root, commonDir, detached) {
    const remotes = await networkRemotes(commonDir);
    if (remotes.length === 0) {
      return [`Git repository ${root} has no https or ssh remote holding it`];
    }
    const advertised = [];
    const unreachable = [];
    for (const remote of remotes) {
      if (!this.remoteRefs.has(remote.url)) {
        this.remoteRefs.set(
          remote.url,
          lsRemote((argv, options) => this.env.run(argv, options), remote.url)
        );
      }
      const result = await this.remoteRefs.get(remote.url);
      if (result.code === 0) {
        advertised.push(...advertisedCommits(result.stdout));
      } else {
        unreachable.push(`${remote.name} (${remote.host})`);
      }
    }
    if (advertised.length === 0) {
      return [
        `cannot confirm Git repository ${root} on a remote: ${unreachable.length > 0 ? `${unreachable.join(', ')} unreachable` : 'its remotes advertise nothing'}`,
      ];
    }
    try {
      const missing = await safeGitDirectory(root, (safeDir) =>
        this.#commitsMissingFrom(root, safeDir, advertised, detached)
      );
      if (missing === 0) {
        return [];
      }
      const hosts = [...new Set(remotes.map((remote) => remote.host))];
      return [
        `Git repository ${root} has ${plural(missing, 'commit')} no branch, tag or pull request on ${hosts.join(', ')} contains`,
      ];
    } catch (error) {
      return [`cannot compare ${root} with its remote: ${error.message}`];
    }
  }

  /** Local commits reachable from HEAD, branches or `detached` but no advertised commit. */
  async #commitsMissingFrom(root, safeDir, advertised, detached) {
    const known = await this.#git(
      root,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      safeDir,
      `${advertised.join('\n')}\n`
    );
    if (known.code !== 0) {
      throw new Error(known.stderr.trim() || `exit ${known.code}`);
    }
    const commits = known.stdout
      .split('\n')
      .map((line) => /^([0-9a-f]+) commit$/.exec(line)?.[1])
      .filter(Boolean);
    const tips = ['HEAD', '--branches', ...detached];
    const count = await this.#git(
      root,
      ['rev-list', '--count', '--stdin', ...tips],
      safeDir,
      commits.map((commit) => `^${commit}\n`).join('')
    );
    if (count.code !== 0) {
      throw new Error(count.stderr.trim() || `exit ${count.code}`);
    }
    return Number(count.stdout.trim());
  }

  /**
   * Number of tracked files inside `target` (a path within `root`).
   * Returns -1 when Git cannot answer.
   */
  async trackedCount(root, target) {
    if (!(await this.isAvailable())) {
      return -1;
    }
    const relative = this.env.path.relative(root, target) || '.';
    try {
      const result =
        this.env.kind === 'host'
          ? await safeGitDirectory(
              root,
              (safeDir) =>
                this.#git(
                  root,
                  [
                    'ls-files',
                    '--cached',
                    '--others',
                    '--exclude-standard',
                    '--',
                    relative,
                  ],
                  safeDir
                ),
              { indexOnly: true }
            )
          : await this.#git(root, [
              'ls-files',
              '--cached',
              '--others',
              '--exclude-standard',
              '--',
              relative,
            ]);
      return result.code === 0 ? countLines(result.stdout) : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Reasons a regenerable directory inside a work tree must be kept:
   * tracked files inside it, or (with `requireClean`) repository state.
   * @param {string} target
   * @param {{requireClean?: boolean, stopAt?: string}} [options]
   */
  async pathBlockers(target, { requireClean = false, stopAt } = {}) {
    const root = await this.findRepoRoot(target, stopAt);
    if (!root) {
      return [];
    }
    if (root === target) {
      return this.repoBlockers(root);
    }
    const tracked = await this.trackedCount(root, target);
    if (tracked === -1) {
      return [`cannot verify Git tracking of ${target}`];
    }
    if (tracked > 0) {
      return [
        `${plural(tracked, 'file')} inside ${target} tracked by Git or not ignored`,
      ];
    }
    return requireClean ? this.repoBlockers(root) : [];
  }
}
