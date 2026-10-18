/**
 * `--only` targets an ecosystem, rule, kind, single item id or path, and a
 * run limited to global rules scans nothing else.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scan, SCANNERS } from '../src/scan.js';
import { clean } from '../src/clean.js';
import { targetedRules } from '../src/scanners/global.js';
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

const atlas = 'Library/Caches/com.openai.atlas/browser-data/host';

function cacheFixture(root) {
  const home = join(root, 'home');
  const caches = [
    join(home, atlas, 'Default', 'Cache'),
    join(home, atlas, 'Default', 'Code Cache'),
    join(home, 'Library/Caches/Codex/Default/Cache'),
  ];
  for (const cache of caches) {
    writeBlob(join(cache, 'data_1'), 8192);
  }
  writeBlob(join(home, '.npm', '_cacache', 'blob'), 8192);
  age(root, 40 * DAY_MS);
  return caches;
}

async function cleanOnly(root, only) {
  const env = fixtureEnv(root);
  const options = scanInput(env, [], { only, docker: false });
  const report = await scan(options);
  await clean(report, { ...options, audit: false, noNative: true });
  return report;
}

describe('targeted cleanup', () => {
  it('limits global rules to the named rules and item ids', () => {
    expect(targetedRules(['openai-app-caches']).map((r) => r.id)).toEqual([
      'openai-app-caches',
    ]);
    expect(
      targetedRules(['host:npm-cache:/home/me/.npm/_cacache']).map((r) => r.id)
    ).toEqual(['npm-cache']);
    expect(targetedRules(['javascript'])).toBe(null);
    expect(targetedRules(['/home/me/.npm'])).toBe(null);
    expect(targetedRules([])).toBe(null);
  });

  itUnless(sandboxed)('runs only the global scanner for a rule', async () => {
    const root = tempRoot();
    const originals = { ...SCANNERS };
    const ran = [];
    try {
      for (const name of Object.keys(SCANNERS)) {
        SCANNERS[name] = async () => {
          ran.push(name);
          return [];
        };
      }
      const env = fixtureEnv(root);
      await scan(scanInput(env, [root], { only: ['openai-app-caches'] }));
      expect(ran).toEqual(['global']);
    } finally {
      Object.assign(SCANNERS, originals);
      removeRoot(root);
    }
  });

  itUnless(sandboxed)('removes every item of a rule only', async () => {
    const root = tempRoot();
    try {
      const caches = cacheFixture(root);
      const report = await cleanOnly(root, ['openai-app-caches']);
      expect(report.items.every((i) => i.rule === 'openai-app-caches')).toBe(
        true
      );
      expect(caches.some((cache) => existsSync(cache))).toBe(false);
      expect(existsSync(join(root, 'home', '.npm', '_cacache'))).toBe(true);
    } finally {
      removeRoot(root);
    }
  });

  itUnless(sandboxed)('removes a single item by id', async () => {
    const root = tempRoot();
    try {
      const caches = cacheFixture(root);
      const env = fixtureEnv(root);
      const full = await scan(scanInput(env, [], { scanners: ['global'] }));
      const target = full.items.find((i) => i.path === caches[0]);
      await cleanOnly(root, [target.id]);
      expect(caches.map((cache) => existsSync(cache))).toEqual([
        false,
        true,
        true,
      ]);
    } finally {
      removeRoot(root);
    }
  });

  itUnless(sandboxed)(
    'removes items inside a path or matching a glob',
    async () => {
      const root = tempRoot();
      try {
        const caches = cacheFixture(root);
        await cleanOnly(root, [join(root, 'home', atlas)]);
        expect(caches.map((cache) => existsSync(cache))).toEqual([
          false,
          false,
          true,
        ]);
        expect(existsSync(join(root, 'home', '.npm', '_cacache'))).toBe(true);
        await cleanOnly(root, ['**/Codex/*']);
        expect(existsSync(caches[2])).toBe(false);
        expect(existsSync(join(root, 'home', '.npm', '_cacache'))).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'never widens a path to the item holding it',
    async () => {
      const root = tempRoot();
      try {
        const caches = cacheFixture(root);
        await cleanOnly(root, [join(caches[0], 'data_1')]);
        expect(existsSync(caches[0])).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );
});
