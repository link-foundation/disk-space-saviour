/**
 * Chromium code-sign clones hard-link the installed main executable: a clone
 * stays while any process runs that file under either path, and a clone of
 * the installed build frees nothing.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, linkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scan } from '../src/scan.js';
import { clean } from '../src/clean.js';
import { formatReport } from '../src/report.js';
import { scanItems, scanCoverage } from '../src/usage.js';
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

const exe = 'Google Chrome.app/Contents/MacOS/Google Chrome';

async function cloneFixture(callback, { installedBuild }) {
  const root = tempRoot();
  const installed = join(root, 'home', 'Applications', exe);
  const clone = join(
    root,
    'user/X/com.google.Chrome.code_sign_clone/code_sign_clone.abc'
  );
  const cloned = join(clone, exe.replace('.app/', '.app.bundle/'));
  writeBlob(installed, 8192);
  writeBlob(join(clone, 'Google Chrome.app.bundle/Contents/Info.plist'), 8192);
  if (installedBuild) {
    mkdirSync(dirname(cloned), { recursive: true });
    linkSync(installed, cloned);
  } else {
    writeBlob(cloned, 8192);
  }
  age(root, 40 * DAY_MS);
  const env = fixtureEnv(root);
  env.options.tmpDirs = [join(root, 'user', 'T')];
  env.openPaths = async () => new Set();
  const options = scanInput(env, [], { scanners: ['global'] });
  const itemOf = async () =>
    (await scan(options)).items.find(
      (item) => item.rule === 'chromium-code-sign-clones'
    );
  try {
    await callback({ env, clone, installed, cloned, options, itemOf });
  } finally {
    removeRoot(root);
  }
}

describe('Chromium code-sign clones', () => {
  it('keeps a clone whose executable runs from the installed app', () =>
    cloneFixture(
      async ({ env, installed, itemOf }) => {
        env.openPaths = async () => new Set([installed]);
        const item = await itemOf();
        expect(item.blockers.join('\n')).toMatch(/in use: .*Google Chrome is/);
        expect(item.bytes).toBe(0);
        expect(item.reason).toMatch(/shares its disk blocks/);
      },
      { installedBuild: true }
    ));

  it('explains a clone of the installed build it does not offer', () =>
    cloneFixture(
      async ({ clone, options }) => {
        const report = await scan({ ...options, minSize: '1K' });
        expect(
          report.items.some((item) => item.rule === 'chromium-code-sign-clones')
        ).toBe(false);
        const [shared] = report.shared;
        expect(shared.path).toBe(clone);
        expect(shared.sharedWith).toMatch(/Google Chrome\.app$/);
        expect(shared.apparentBytes > 0).toBe(true);
        expect(formatReport(report)).toMatch(
          /SHARED WITH INSTALLED APPS {2}1 item, .* about 0 B to free/
        );
        if (process.platform === 'win32') {
          // `dss usage` walks with du and compares POSIX paths.
          return;
        }
        const coverage = scanCoverage(
          dirname(clone),
          scanItems(report, 'linux')
        );
        expect(coverage.freeable).toBe(0);
        expect(coverage.shared.bytes).toBe(shared.apparentBytes);
      },
      { installedBuild: true }
    ));

  it('keeps a clone a browser started before an update runs', () =>
    cloneFixture(
      async ({ env, cloned, itemOf }) => {
        env.openPaths = async () => new Set([cloned]);
        expect((await itemOf()).blockers.join('\n')).toMatch(/in use/);
      },
      { installedBuild: false }
    ));

  it('offers the full size of an orphaned clone of an old build', () =>
    cloneFixture(
      async ({ itemOf }) => {
        const item = await itemOf();
        expect(item.blockers).toEqual([]);
        expect(item.bytes > 0).toBe(true);
      },
      { installedBuild: false }
    ));

  itUnless(sandboxed)(
    'skips a clone whose executable runs after the scan',
    () =>
      cloneFixture(
        async ({ env, clone, installed, options }) => {
          const report = await scan(options);
          env.openPaths = async () => new Set([installed]);
          const audit = await clean(report, {
            env,
            tier: 'safe',
            docker: false,
            audit: false,
          });
          const entry = audit.entries.find((e) => e.path === clone);
          expect(entry.status).toBe('skipped');
          expect(entry.reason).toMatch(/in use: .*Google Chrome is/);
          expect(existsSync(clone)).toBe(true);
        },
        { installedBuild: true }
      )
  );
});
