/**
 * Application downloads and staging areas: every location is found, kept
 * while its application runs, and only superseded versions of versioned
 * downloads are offered.
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import {
  age,
  DAY_MS,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const support = 'Library/Application Support';
const homeLocations = [
  [
    'google-updater-downloads',
    `${support}/Google/GoogleUpdater/crx_cache/abc/x.crx`,
  ],
  [
    'openai-app-caches',
    'Library/Caches/com.openai.atlas/browser-data/host/Default/Cache/data_1',
  ],
  ['openai-app-caches', 'Library/Caches/Codex/Default/Code Cache/js/index'],
  [
    'electron-downloads',
    'Library/Caches/electron/abc/electron-v1-darwin-arm64.zip',
  ],
  ['electron-downloads', '.cache/electron-builder/nsis/nsis.7z'],
  ['bun-transpiler-cache', 'Library/Caches/bun/@t@/0004c3f6f98d2f0a.pile'],
  [
    'docker-desktop-update-downloads',
    `${support}/com.docker.install/in_progress/Docker.app/x`,
  ],
  [
    'warp-staged-updates',
    `${support}/dev.warp.Warp-Stable/autoupdate/abc/Warp.dmg`,
  ],
  ['zed-downloads', `${support}/Zed/languages/vtsls/server.js`],
  ['zed-downloads', '.local/share/zed/node/cache/x.tgz'],
  ['tree-sitter-downloads', '.cache/tree-sitter/wasi-sdk/bin/clang'],
  [
    'codex-plugin-staging',
    '.codex/plugins/..plugin-appserver.staging-abc/plugin.js',
  ],
  [
    'codex-plugin-staging',
    '.codex/.tmp/marketplaces/.staging/marketplace-upgrade-abc/x',
  ],
  ['crashpad-reports', `${support}/Codex/Crashpad/completed/report.dmp`],
  [
    'crashpad-reports',
    `${support}/Google/Chrome/Crashpad/completed/report.dmp`,
  ],
  ['chrome-http-caches', `${support}/Google/Chrome/extensions_crx_cache/x.crx`],
  ['vscode-caches', `${support}/Code/WebStorage/1/CacheStorage/x`],
];
const tmpLocations = [
  [
    'chromium-code-sign-clones',
    'X/com.google.Chrome.code_sign_clone/code_sign_clone.abc/Google Chrome.app/x',
  ],
  ['docker-desktop-update-images', 'T/DockerDesktopUpdates/Docker.dmg'],
  ['clang-module-cache', 'C/clang/ModuleCache/abc/Foundation.pcm'],
];

async function scanFixture(root, location, base) {
  writeBlob(join(base, location), 8192);
  age(root, 40 * DAY_MS);
  const env = fixtureEnv(root);
  env.options.tmpDirs = [join(root, 'user', 'T')];
  const options = scanInput(env, [], { scanners: ['global'] });
  return { env, options, report: await scan(options) };
}

describe('application download rules', () => {
  for (const [rule, location] of [...homeLocations, ...tmpLocations]) {
    it(`finds ${location} and honors its busy tools`, async () => {
      const root = tempRoot();
      const home = homeLocations.some(([, entry]) => entry === location);
      try {
        const { env, options, report } = await scanFixture(
          root,
          location,
          join(root, home ? 'home' : 'user')
        );
        const item = report.items.find((entry) => entry.rule === rule);
        expect(Boolean(item)).toBe(true);
        expect(item.blockers).toEqual([]);
        expect(item.tier).toBe(
          rule === 'crashpad-reports' ? 'moderate' : 'safe'
        );
        if (item.checks.busy.length === 0) {
          return;
        }
        env.processes = () =>
          Promise.resolve([
            { pid: 7, name: item.checks.busy[0], cwd: item.path },
          ]);
        const active = (await scan(options)).items.find((i) => i.rule === rule);
        expect(active.blockers.join('\n')).toMatch(/busy/);
      } finally {
        removeRoot(root);
      }
    });
  }

  it('offers every Chrome on-device model version', async () => {
    const root = tempRoot();
    const chrome = join(root, 'home', support, 'Google/Chrome');
    const models = [
      join(chrome, 'OptGuideOnDeviceModel', '2025.8.8.1141'),
      join(chrome, 'OptGuideOnDeviceClassifierModel', '2026.2.12.1554'),
    ];
    try {
      writeBlob(join(models[0], 'weights.bin'), 8192);
      const { report } = await scanFixture(root, 'model.tflite', models[1]);
      const items = report.items.filter(
        (i) => i.rule === 'chrome-on-device-models'
      );
      expect(items.map((i) => i.path).sort()).toEqual(models.sort());
      expect(items.every((i) => i.blockers.length === 0)).toBe(true);
    } finally {
      removeRoot(root);
    }
  });

  it('keeps a code-sign clone that a browser holds open', async () => {
    const root = tempRoot();
    const clone = join(
      root,
      'user',
      'X',
      'com.google.Chrome.code_sign_clone',
      'code_sign_clone.abc'
    );
    try {
      mkdirSync(clone, { recursive: true });
      const { env, options } = await scanFixture(root, 'Chrome', clone);
      env.openPaths = () => Promise.resolve(new Set([join(clone, 'Chrome')]));
      const item = (await scan(options)).items.find(
        (i) => i.rule === 'chromium-code-sign-clones'
      );
      expect(item.blockers.join('\n')).toMatch(/busy|open/);
    } finally {
      removeRoot(root);
    }
  });
});
