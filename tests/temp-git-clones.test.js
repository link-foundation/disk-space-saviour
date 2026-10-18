/**
 * Git clones in temporary directories are offered only when every worktree
 * is clean and `git ls-remote` shows the remote advertising every local
 * commit; cached remote-tracking refs prove nothing.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import {
  advertisedCommits,
  networkRemote,
  parseRemoteUrls,
} from '../src/git-remote.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  git,
  pushedRepo,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const URL = 'https://git.example.test/owner/repo.git';

/**
 * A clone of a pushed repository in a temporary directory whose origin is
 * an https URL; `git ls-remote` of that URL lists the local bare remote,
 * or fails when `reachable` is false.
 */
async function cloneFixture(callback, { prepare = () => {} } = {}) {
  const root = tempRoot();
  const source = pushedRepo(join(root, 'source'));
  const remote = `${source}-remote.git`;
  const tmp = join(root, 'user', 'T');
  const clone = join(tmp, 'checkout');
  mkdirSync(tmp, { recursive: true });
  git(tmp, 'clone', '-q', remote, clone);
  git(clone, 'remote', 'set-url', 'origin', URL);
  writeBlob(join(clone, '.git', 'pad'), 64 * 1024);
  const state = { reachable: true };
  const env = fixtureEnv(root);
  env.options.tmpDirs = [tmp];
  const run = env.executor.run;
  env.executor.run = (argv, options) => {
    const at = argv.indexOf('ls-remote');
    if (at === -1 || argv[at + 1] !== URL) {
      return run(argv, options);
    }
    // The local stand-in needs the file transport the real call refuses.
    return state.reachable
      ? run(['git', 'ls-remote', remote, ...argv.slice(at + 2)], options)
      : Promise.resolve({ code: 128, stdout: '', stderr: 'unreachable' });
  };
  prepare({ root, clone, remote, tmp });
  age(root, 40 * DAY_MS);
  const options = scanInput(env, [], {
    scanners: ['global'],
    only: ['temp-git-clones'],
  });
  const itemOf = async () =>
    (await scan(options)).items.find((item) => item.rule === 'temp-git-clones');
  try {
    await callback({ root, env, clone, remote, state, options, itemOf });
  } finally {
    removeRoot(root);
  }
}

describe('temporary Git clones', () => {
  it('accepts only https and ssh remotes', () => {
    expect(networkRemote('https://github.com/o/r.git').host).toBe('github.com');
    expect(networkRemote('git@github.com:o/r.git').host).toBe('github.com');
    expect(networkRemote('ssh://git@host.test:22/o/r').host).toBe('host.test');
    expect(networkRemote('/srv/git/r.git')).toBe(null);
    expect(networkRemote('file:///srv/git/r.git')).toBe(null);
    expect(networkRemote('../r.git')).toBe(null);
    expect(networkRemote('C:/repos/r.git')).toBe(null);
    expect(networkRemote('-uhttps://x/y')).toBe(null);
    expect(networkRemote('ext::sh -c touch% /tmp/pwned')).toBe(null);
  });

  it('reads remote URLs and advertised commits', () => {
    expect(
      parseRemoteUrls(
        '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://h/o/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n'
      )
    ).toEqual([{ name: 'origin', url: 'https://h/o/r.git' }]);
    const sha = 'a'.repeat(40);
    const peeled = 'b'.repeat(40);
    expect(
      advertisedCommits(
        `${sha}\trefs/heads/main\n${sha}\trefs/pull/1/head\n${peeled}\trefs/tags/v1^{}\n`
      )
    ).toEqual([sha, peeled]);
  });

  itUnless(sandboxed)('offers a clean clone its remote still holds', () =>
    cloneFixture(async ({ itemOf }) => {
      const item = await itemOf();
      expect(item.blockers).toEqual([]);
      expect(item.tier).toBe('safe');
    })
  );

  itUnless(sandboxed)(
    'keeps a commit only a stale remote-tracking ref contains',
    () =>
      cloneFixture(
        async ({ itemOf }) => {
          expect((await itemOf()).blockers.join('\n')).toMatch(
            /1 commit no branch, tag or pull request on git\.example\.test contains/
          );
        },
        {
          prepare: ({ clone }) => {
            git(clone, 'commit', '-q', '--allow-empty', '-m', 'local');
            git(clone, 'update-ref', 'refs/remotes/origin/gone', 'HEAD');
          },
        }
      )
  );

  itUnless(sandboxed)('keeps a clone whose remote cannot be reached', () =>
    cloneFixture(async ({ itemOf, state }) => {
      state.reachable = false;
      expect((await itemOf()).blockers.join('\n')).toMatch(
        /cannot confirm .* origin \(git\.example\.test\) unreachable/
      );
    })
  );

  itUnless(sandboxed)(
    'keeps a clone with uncommitted work in a linked worktree',
    () =>
      cloneFixture(
        async ({ itemOf }) => {
          expect((await itemOf()).blockers.join('\n')).toMatch(
            /uncommitted change/
          );
        },
        {
          prepare: ({ clone }) => {
            const tree = join(clone, 'trees', 'feature');
            git(clone, 'worktree', 'add', '-q', '-b', 'feature', tree);
            writeFileSync(join(clone, '.git', 'info', 'exclude'), 'trees/\n');
            writeFileSync(join(tree, 'draft.txt'), 'unsaved\n');
          },
        }
      )
  );

  itUnless(sandboxed)(
    'keeps a repository a worktree outside the clone still uses',
    () =>
      cloneFixture(
        async ({ itemOf }) => {
          expect((await itemOf()).blockers.join('\n')).toMatch(
            /linked worktree .*elsewhere uses the repository/
          );
        },
        {
          prepare: ({ root, clone }) => {
            git(clone, 'worktree', 'add', '-q', join(root, 'elsewhere'));
          },
        }
      )
  );

  itUnless(sandboxed)('ignores clones of a local path', () =>
    cloneFixture(
      async ({ itemOf }) => {
        expect(await itemOf()).toBe(undefined);
      },
      {
        prepare: ({ clone, remote }) => {
          git(clone, 'remote', 'set-url', 'origin', remote);
        },
      }
    )
  );

  itUnless(sandboxed)('rechecks the remote right before deleting', () =>
    cloneFixture(async ({ root, env, clone, options }) => {
      const report = await scan(options);
      git(clone, 'commit', '-q', '--allow-empty', '-m', 'after the scan');
      git(clone, 'update-ref', 'refs/remotes/origin/gone', 'HEAD');
      age(root, 40 * DAY_MS);
      const audit = await clean(report, {
        env,
        tier: 'safe',
        docker: false,
        audit: false,
      });
      const entry = audit.entries.find((e) => e.path === clone);
      expect(entry.status).toBe('skipped');
      expect(entry.reason).toMatch(/no branch, tag or pull request/);
      expect(existsSync(clone)).toBe(true);
    })
  );
});
