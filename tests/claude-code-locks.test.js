/**
 * Claude Code writes `~/.local/state/claude/locks/<version>.lock` for every
 * running session: a version stays while its lock names a live process or
 * cannot be read, both at scan time and right before deletion.
 */

import { describe, expect } from 'test-anywhere';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import { clean } from '../src/clean.js';
import { itUnless, sandboxed } from './helpers/skip.js';
import {
  age,
  DAY_MS,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const SESSION_PID = 424242;

async function claudeFixture(callback) {
  const root = tempRoot();
  const home = join(root, 'home');
  const versions = join(home, '.local/share/claude/versions');
  const locks = join(home, '.local/state/claude/locks');
  for (const version of ['2.1.294', '2.1.301', '2.1.302']) {
    writeBlob(join(versions, version));
  }
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(locks, { recursive: true });
  symlinkSync(join(versions, '2.1.302'), join(home, '.local/bin/claude'));
  age(root, 3 * DAY_MS);
  const env = fixtureEnv(root);
  // The session runs elsewhere, so only its lock ties it to the version.
  env.processes = async () => [
    { pid: SESSION_PID, name: 'claude', command: 'claude', cwd: '/work' },
  ];
  env.openPaths = async () => new Set();
  const lock = (version, text) =>
    writeFileSync(join(locks, `${version}.lock`), text);
  const options = scanInput(env, [], { scanners: ['versions'] });
  const itemOf = async (version) =>
    (await scan(options)).items.find(
      (item) => item.path === join(versions, version)
    );
  try {
    await callback({ env, versions, lock, itemOf, options });
  } finally {
    removeRoot(root);
  }
}

const lockOf = (pid, version) =>
  JSON.stringify({ pid, version, execPath: `/x/${version}` });

describe('Claude Code version locks', () => {
  itUnless(sandboxed)('keeps a version locked by a live session', () =>
    claudeFixture(async ({ lock, itemOf }) => {
      lock('2.1.301', lockOf(SESSION_PID, '2.1.301'));
      expect((await itemOf('2.1.301')).blockers.join('\n')).toMatch(
        /locked by running Claude Code \(pid 424242/
      );
      expect((await itemOf('2.1.294')).blockers).toEqual([]);
    })
  );

  itUnless(sandboxed)('ignores the lock of an exited session', () =>
    claudeFixture(async ({ lock, itemOf }) => {
      lock('2.1.301', lockOf(SESSION_PID + 1, '2.1.301'));
      expect((await itemOf('2.1.301')).blockers).toEqual([]);
    })
  );

  itUnless(sandboxed)('keeps a version whose lock cannot be read', () =>
    claudeFixture(async ({ lock, itemOf }) => {
      lock('2.1.301', '{"pid":');
      expect((await itemOf('2.1.301')).blockers.join('\n')).toMatch(
        /lock .* cannot be read/
      );
    })
  );

  itUnless(sandboxed)('keeps every version when processes are unknown', () =>
    claudeFixture(async ({ env, lock, itemOf }) => {
      lock('2.1.301', lockOf(SESSION_PID, '2.1.301'));
      env.processes = async () => {
        throw new Error('ps failed');
      };
      expect((await itemOf('2.1.301')).blockers.join('\n')).toMatch(
        /cannot verify|cannot be|locked/
      );
    })
  );

  itUnless(sandboxed)('skips a version locked after the scan', () =>
    claudeFixture(async ({ env, versions, lock, options }) => {
      const report = await scan(options);
      const target = join(versions, '2.1.301');
      expect(
        report.items.some(
          (item) => item.path === target && item.blockers.length === 0
        )
      ).toBe(true);
      lock('2.1.301', lockOf(SESSION_PID, '2.1.301'));
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        docker: false,
        audit: false,
      });
      const entry = audit.entries.find((e) => e.path === target);
      expect(entry.status).toBe('skipped');
      expect(entry.reason).toMatch(/locked by running Claude Code/);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(join(versions, '2.1.294'))).toBe(false);
    })
  );
});
