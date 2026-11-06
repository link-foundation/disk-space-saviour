/**
 * Playwright MCP profiles persist logins, so only their cache leaves may go.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const scanRule = (env, rule) =>
  scan(scanInput(env, [], { scanners: ['global'], only: [rule] }));

describe('profile and metadata caches', () => {
  it('removes MCP profile caches and keeps cookies and logins', async () => {
    const root = tempRoot('dss-mcp-profile-');
    try {
      const base = join(root, 'home', 'Library', 'Caches', 'ms-playwright-mcp');
      const profile = join(base, 'mcp-chrome-abc', 'Default');
      writeBlob(join(profile, 'Cache', 'entry'));
      writeBlob(join(profile, 'Code Cache', 'entry'));
      const kept = ['Cookies', 'Login Data', join('Local Storage', 'db')].map(
        (name) => join(profile, name)
      );
      kept.forEach((file) => writeBlob(file));
      age(root, 2 * DAY_MS);
      const env = fixtureEnv(root);
      const report = await scanRule(env, 'playwright-mcp-profile-caches');
      expect(report.items.map((item) => item.path).sort()).toEqual([
        join(profile, 'Cache'),
        join(profile, 'Code Cache'),
      ]);
      await clean(report, { env, tier: 'safe', yes: true, audit: false });
      expect(existsSync(join(profile, 'Cache'))).toBe(false);
      expect(kept.every((file) => existsSync(file))).toBe(true);
    } finally {
      removeRoot(root);
    }
  });

  it('offers pnpm metadata but not other pnpm folders', async () => {
    const root = tempRoot('dss-pnpm-metadata-');
    try {
      const caches = join(root, 'home', 'Library', 'Caches', 'pnpm');
      writeBlob(join(caches, 'metadata-v1.3', 'registry.npmjs.org', 'a.json'));
      writeBlob(join(caches, 'other', 'keep'));
      age(root, 2 * DAY_MS);
      const report = await scanRule(fixtureEnv(root), 'pnpm-metadata-cache');
      expect(report.items.map((item) => item.path)).toEqual([
        join(caches, 'metadata-v1.3'),
      ]);
    } finally {
      removeRoot(root);
    }
  });
});
