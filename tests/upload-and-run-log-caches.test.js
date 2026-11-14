import { describe, expect } from 'test-anywhere';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { scan, scanEnvironment } from '../src/scan.js';
import { clean } from '../src/clean.js';
import { ShellEnv } from '../src/env/shell.js';
import { hostExecutor } from '../src/exec.js';
import { resolveOptions } from '../src/options.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, sandboxed, notLinux } from './helpers/skip.js';

const UPLOAD = 'sanitized-upload-staging';
const RUN_LOG = 'gh-run-log-cache';
const test = itUnless(sandboxed);

async function fixture(callback) {
  const root = tempRoot('dss-upload-caches-');
  try {
    const env = fixtureEnv(root);
    env.currentHome = join(root, 'home');
    env.which = async () => false;
    env.processes = async () => [];
    env.openPaths = async () => new Set();
    await callback(root, env);
  } finally {
    removeRoot(root);
  }
}

function input(env, rule, { homes, tmpDirs, ...overrides } = {}) {
  if (homes) {
    env.options.homes = homes;
  }
  if (tmpDirs) {
    env.options.tmpDirs = tmpDirs;
  }
  return scanInput(env, [], {
    scanners: ['global'],
    only: [rule],
    ...overrides,
  });
}

const cleanup = (report, env, tier = 'safe') =>
  clean(report, { env, tier, docker: false, audit: false, noNative: true });

itUnless(sandboxed, notLinux)(
  'discovers both layouts through the container shell adapter',
  async () =>
    fixture(async (root) => {
      const home = join(root, 'home');
      const tmp = join(root, 'tmp');
      const staging = join(tmp, 'hive-mind-log-upload-container');
      const archive = join(home, '.cache/gh/run-log-1.zip');
      writeBlob(join(staging, 'sanitized.log'), 4096);
      writeBlob(archive, 4096);
      age(root, 2 * DAY_MS);
      const env = new ShellEnv(hostExecutor(), {
        homes: [home],
        tmpDirs: [tmp],
      });
      env.variables = async () => ({});
      env.processes = async () => [];
      env.openPaths = async () => new Set();
      const errors = [];
      const items = await scanEnvironment(
        env,
        resolveOptions(input(env, UPLOAD, { only: [UPLOAD, RUN_LOG] })),
        { errors }
      );
      expect(errors).toEqual([]);
      expect(items.map((item) => item.path).sort()).toEqual(
        [archive, staging].sort()
      );
      expect(items.find((item) => item.rule === UPLOAD).tier).toBe('moderate');
      expect(items.find((item) => item.rule === RUN_LOG).tier).toBe('safe');
      expect(items.every((item) => item.blockers.length === 0)).toBe(true);
    })
);

describe('sanitized log upload staging', () => {
  test('finds old and current layouts in every temporary root and keeps moderate consent', async () =>
    fixture(async (root, env) => {
      const tmpDirs = [join(root, 'tmp'), join(root, 'custom-tmp')];
      const targets = tmpDirs.flatMap((tmp) =>
        [
          'hive-mind-log-upload-DToMlY',
          'log-tmp-hive-mind-log-upload-123-sanitized-456',
          'log-home-box-hive-telegram-bot-456',
        ].map((name) => join(tmp, name))
      );
      targets.forEach((target) =>
        writeBlob(join(target, 'sanitized.log'), 4096)
      );
      age(root, 2 * DAY_MS);
      const report = await scan(input(env, UPLOAD, { tmpDirs }));
      expect(report.items.map((item) => item.path).sort()).toEqual(
        targets.sort()
      );
      expect(report.items.every((item) => item.tier === 'moderate')).toBe(true);
      expect(report.items.every((item) => item.blockers.length === 0)).toBe(
        true
      );
      await cleanup(report, env);
      expect(targets.every((target) => existsSync(target))).toBe(true);
      await cleanup(report, env, 'moderate');
      expect(targets.some((target) => existsSync(target))).toBe(false);
    }));

  test('ignores fresh staging and recently written logs inside old staging', async () =>
    fixture(async (root, env) => {
      const tmp = join(root, 'tmp');
      const old = join(tmp, 'hive-mind-log-upload-old');
      const writing = join(tmp, 'hive-mind-log-upload-writing');
      writeBlob(join(old, 'sanitized.log'), 4096);
      writeBlob(join(writing, 'sanitized.log'), 4096);
      age(root, 2 * DAY_MS);
      writeBlob(join(writing, 'sanitized.log'), 4096);
      writeBlob(join(tmp, 'hive-mind-log-upload-fresh', 'sanitized.log'), 4096);
      const report = await scan(input(env, UPLOAD, { tmpDirs: [tmp] }));
      expect(report.items.map((item) => item.path)).toEqual([old]);
    }));
});

describe('GitHub CLI run log archives', () => {
  test('aggregates stale archives per home and removes only archive files at safe tier', async () =>
    fixture(async (root, env) => {
      const homes = [join(root, 'home'), join(root, 'other-home')];
      const archives = homes.map((home) =>
        [
          'run-log-42780345216-1794298407.zip',
          'run-log-42770414315-1794293001.zip',
        ].map((name) => writeBlob(join(home, '.cache', 'gh', name), 4096))
      );
      const kept = homes.flatMap((home) =>
        [
          '.cache/gh/hosts.yml',
          '.cache/gh/config.yml',
          '.cache/gh/unrelated.zip',
          '.cache/gh/run-log-incomplete.tmp',
          '.cache/gh/nested/run-log-1.zip',
          '.cache/gh/run-log-directory.zip/keep',
          '.config/gh/hosts.yml',
          '.config/gh/config.yml',
        ].map((name) => writeBlob(join(home, name), 4096))
      );
      age(root, 2 * DAY_MS);
      const fresh = homes.map((home) =>
        writeBlob(join(home, '.cache/gh/run-log-fresh.zip'), 4096)
      );
      const report = await scan(input(env, RUN_LOG, { homes }));
      expect(report.items.length).toBe(2);
      for (const paths of archives) {
        const item = report.items.find((entry) =>
          entry.paths.includes(paths[0])
        );
        expect([...item.paths].sort()).toEqual([...paths].sort());
        expect(item.tier).toBe('safe');
        expect(item.blockers).toEqual([]);
        expect([...item.action.paths].sort()).toEqual([...paths].sort());
      }
      const audit = await cleanup(report, env);
      expect(
        audit.entries.map(({ status, reason }) => ({ status, reason }))
      ).toEqual(homes.map(() => ({ status: 'removed', reason: null })));
      expect(archives.flat().some((file) => existsSync(file))).toBe(false);
      expect([...kept, ...fresh].every((file) => existsSync(file))).toBe(true);
    }));

  test('honors XDG_CACHE_HOME only for its owner and keeps other homes separate', async () =>
    fixture(async (root, env) => {
      const other = join(root, 'other-home');
      const configured = join(root, 'custom-cache');
      env.vars.XDG_CACHE_HOME = configured;
      const archive = writeBlob(join(configured, 'gh/run-log-1.zip'), 4096);
      const otherArchive = writeBlob(
        join(other, '.cache/gh/run-log-2.zip'),
        4096
      );
      const defaultArchive = writeBlob(
        join(root, 'home/.cache/gh/run-log-3.zip'),
        4096
      );
      age(root, 2 * DAY_MS);
      const report = await scan(
        input(env, RUN_LOG, { homes: [env.currentHome, other] })
      );
      expect(report.items.map((item) => item.paths)).toEqual([
        [archive],
        [otherArchive],
      ]);
      await cleanup(report, env);
      expect(existsSync(archive)).toBe(false);
      expect(existsSync(otherArchive)).toBe(false);
      expect(existsSync(defaultArchive)).toBe(true);
    }));

  test('finds the Windows LocalAppData layout without matching its configuration', async () =>
    fixture(async (root, env) => {
      env.vars.LOCALAPPDATA = join(root, 'home/AppData/Local');
      const cache = join(env.vars.LOCALAPPDATA, 'GitHub CLI');
      const archive = writeBlob(join(cache, 'run-log-1.zip'), 4096);
      const config = writeBlob(join(cache, 'config.yml'), 4096);
      age(root, 2 * DAY_MS);
      const report = await scan(input(env, RUN_LOG));
      expect(report.items.map((item) => item.paths)).toEqual([[archive]]);
      await cleanup(report, env);
      expect(existsSync(archive)).toBe(false);
      expect(existsSync(config)).toBe(true);
    }));

  test('blocks archives when gh runs outside the cache', async () =>
    fixture(async (root, env) => {
      writeBlob(join(root, 'home/.cache/gh/run-log-1.zip'), 4096);
      age(root, 2 * DAY_MS);
      env.processes = async () => [{ pid: 7, name: 'gh', cwd: root }];
      const report = await scan(input(env, RUN_LOG));
      expect(report.items.length).toBe(1);
      expect(report.items[0].blockers.join()).toMatch(/gh is running/);
    }));
});

for (const rule of [UPLOAD, RUN_LOG]) {
  const tier = rule === UPLOAD ? 'moderate' : 'safe';
  const makeTarget = (root) =>
    rule === UPLOAD
      ? join(root, 'tmp/hive-mind-log-upload-example/sanitized.log')
      : join(root, 'home/.cache/gh/run-log-1.zip');

  describe(`${rule} liveness`, () => {
    test('keeps an old log held open at scan time', async () =>
      fixture(async (root, env) => {
        const file = writeBlob(makeTarget(root), 4096);
        age(root, 2 * DAY_MS);
        env.openPaths = async () => new Set([file]);
        const report = await scan(
          input(env, rule, { tmpDirs: [join(root, 'tmp')] })
        );
        expect(report.items.length).toBe(1);
        expect(report.items[0].blockers.join()).toMatch(/in use/);
        await cleanup(report, env, tier);
        expect(existsSync(file)).toBe(true);
      }));

    for (const activity of [
      'open',
      'write',
      ...(rule === RUN_LOG ? ['gh'] : []),
    ]) {
      test(`rechecks ${activity} activity after scanning and before deletion`, async () =>
        fixture(async (root, env) => {
          const file = writeBlob(makeTarget(root), 4096);
          age(root, 2 * DAY_MS);
          const report = await scan(
            input(env, rule, { tmpDirs: [join(root, 'tmp')] })
          );
          expect(report.items.length).toBe(1);
          expect(report.items[0].blockers).toEqual([]);
          if (activity === 'open') {
            env.openPaths = async () => new Set([file]);
          } else if (activity === 'write') {
            writeBlob(file, 4096);
          } else {
            env.processes = async () => [{ pid: 7, name: 'gh', cwd: root }];
          }
          const audit = await cleanup(report, env, tier);
          expect(existsSync(file)).toBe(true);
          expect(audit.entries.length).toBe(1);
          expect(audit.entries[0].status).toBe('skipped');
          expect(audit.entries[0].reason).toMatch(/busy|modified|in use/);
        }));
    }
  });
}
