/**
 * Old Playwright browser revisions go unless a Playwright package recorded
 * in the registry's `.links` still launches them; Playwright installs left
 * in temporary directories go once untouched.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import { browserDirName, requiredDirs } from '../src/playwright-registry.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

function link(registry, name, pkg, browsers) {
  mkdirSync(join(registry, '.links'), { recursive: true });
  writeFileSync(join(registry, '.links', name), pkg);
  if (browsers) {
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'browsers.json'), JSON.stringify({ browsers }));
  }
}

async function registryFixture(callback) {
  const root = tempRoot('dss-playwright-');
  const registry = join(root, 'home', '.cache', 'ms-playwright');
  for (const dir of [
    'chromium-100',
    'chromium-200',
    'webkit-10',
    'webkit-20',
  ]) {
    writeBlob(join(registry, dir, 'browser'), 64 * 1024);
  }
  link(registry, 'live', join(root, 'app', 'node_modules', 'playwright-core'), [
    { name: 'webkit', revision: '10' },
  ]);
  link(registry, 'gone', join(root, 'removed', 'playwright-core'));
  age(root, 40 * DAY_MS);
  const options = scanInput(fixtureEnv(root), [], {
    scanners: ['global'],
    only: ['playwright-browsers'],
  });
  const items = async () =>
    new Map(
      (await scan(options)).items.map((item) => [
        item.path.slice(registry.length + 1),
        item,
      ])
    );
  try {
    await callback({ root, registry, options, items });
  } finally {
    removeRoot(root);
  }
}

describe('Playwright registry', () => {
  it('names revision directories as Playwright installs them', () => {
    expect(browserDirName('chromium-headless-shell', '1248')).toBe(
      'chromium_headless_shell-1248'
    );
    expect(
      requiredDirs(
        JSON.stringify({
          browsers: [
            { name: 'chromium', revision: '1248' },
            {
              name: 'webkit',
              revision: '2370',
              revisionOverrides: { mac14: '2251' },
            },
          ],
        })
      )
    ).toEqual(['chromium-1248', 'webkit-2370', 'webkit-2251']);
  });

  itUnless(sandboxed)(
    'keeps revisions an installed package launches, not stale links',
    () =>
      registryFixture(async ({ items }) => {
        const found = await items();
        expect([...found.keys()].sort()).toEqual(['chromium-100', 'webkit-10']);
        expect(found.get('chromium-100').blockers).toEqual([]);
        expect(found.get('webkit-10').blockers.join('\n')).toMatch(
          /Playwright in .*app.node_modules.playwright-core still uses webkit-10/
        );
      })
  );

  itUnless(sandboxed)('rechecks the registry right before deleting', () =>
    registryFixture(async ({ root, registry, options, items }) => {
      const report = await scan(options);
      expect((await items()).get('chromium-100').blockers).toEqual([]);
      link(registry, 'new', join(root, 'next', 'playwright-core'), [
        { name: 'chromium', revision: '100' },
      ]);
      const audit = await clean(report, {
        env: options.env,
        tier: 'safe',
        audit: false,
        docker: false,
      });
      const entry = audit.entries.find(
        (e) => e.path === join(registry, 'chromium-100')
      );
      expect(entry.status).toBe('skipped');
      expect(entry.reason).toMatch(/still uses chromium-100/);
      expect(existsSync(join(registry, 'chromium-100'))).toBe(true);
    })
  );

  itUnless(sandboxed)(
    'offers Playwright installs left in temporary directories',
    async () => {
      const root = tempRoot('dss-playwright-tmp-');
      try {
        const tmp = join(root, 'T');
        const sandboxHome = join(tmp, 'agent-home', '.cache', 'ms-playwright');
        const download = join(tmp, 'playwright-download-chromium-mac-1248.zip');
        writeBlob(join(sandboxHome, 'chromium-1248', 'browser'), 64 * 1024);
        writeBlob(download, 64 * 1024);
        age(root, 40 * DAY_MS);
        const env = fixtureEnv(root);
        env.options.tmpDirs = [tmp];
        const report = await scan(
          scanInput(env, [], {
            scanners: ['global'],
            only: ['tmp-playwright-browsers'],
          })
        );
        const items = report.items.filter(
          (item) => item.rule === 'tmp-playwright-browsers'
        );
        expect(items.map((item) => item.path).sort()).toEqual(
          [download, sandboxHome].sort()
        );
        expect(items.every((item) => item.blockers.length === 0)).toBe(true);
        expect(items.every((item) => item.tier === 'safe')).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );
});
