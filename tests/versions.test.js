import { describe, it, expect } from 'test-anywhere';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersions } from '../src/rules/versions.js';
import { formatReport } from '../src/report.js';
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
import { itUnless, sandboxed } from './helpers/skip.js';

describe('version manager pruning', () => {
  it('compares SDKMAN numeric segments', () => {
    expect(compareVersions('java=21.0.1-tem', 'java=8') > 0).toBe(true);
  });

  itUnless(sandboxed)(
    'keeps the newest version in each family and all opam switches',
    async () => {
      const root = tempRoot('dss-versions-');
      try {
        const home = join(root, 'home');
        for (const version of ['3.11.4', '3.12.0', 'anaconda3-2024']) {
          writeBlob(join(home, '.pyenv', 'versions', version, 'bin', 'python'));
        }
        for (const version of ['8', '21.0.1-tem']) {
          writeBlob(
            join(home, '.sdkman', 'candidates', 'java', version, 'bin', 'java')
          );
        }
        for (const name of ['local', 'release']) {
          writeBlob(join(home, '.opam', name, '.opam-switch', 'config'));
        }
        age(root, 40 * DAY_MS);
        const report = await scan(
          scanInput(fixtureEnv(root), [], { scanners: ['versions'] })
        );
        const paths = report.items.map((item) => item.path);
        expect(paths).toContain(join(home, '.pyenv', 'versions', '3.11.4'));
        expect(paths).not.toContain(join(home, '.pyenv', 'versions', '3.12.0'));
        expect(paths).not.toContain(
          join(home, '.pyenv', 'versions', 'anaconda3-2024')
        );
        expect(paths).toContain(
          join(home, '.sdkman', 'candidates', 'java', '8')
        );
        expect(paths).not.toContain(
          join(home, '.sdkman', 'candidates', 'java', '21.0.1-tem')
        );
        expect(
          paths.some((target) => target.startsWith(join(home, '.opam')))
        ).toBe(false);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'resolves nvm refs to the newest match and names the globals it removes',
    async () => {
      const root = tempRoot('dss-versions-nvm-');
      try {
        const home = join(root, 'home');
        const nvm = join(home, '.nvm');
        const node = (version, ...globals) => {
          const dir = join(nvm, 'versions', 'node', version);
          writeBlob(join(dir, 'bin', 'node'));
          for (const name of ['npm', 'corepack', ...globals]) {
            writeBlob(join(dir, 'lib', 'node_modules', name, 'package.json'));
          }
          return dir;
        };
        const old20 = node('v20.15.1', 'lodash-v-4.17.21');
        const new20 = node('v20.19.4', 'yarn');
        const tool = node('v18.20.3', 'yarn', '@openapitools/generator');
        const lts = node('v16.20.1');
        const newest = node('v24.18.0');
        mkdirSync(join(nvm, 'alias', 'lts'), { recursive: true });
        writeFileSync(join(nvm, 'alias', 'default'), '20\n');
        writeFileSync(join(nvm, 'alias', 'lts', 'gallium'), 'v16.20.2\n');
        mkdirSync(join(root, 'app'));
        writeFileSync(join(root, 'app', '.nvmrc'), 'lts/gallium\n');
        age(root, 40 * DAY_MS);
        const report = await scan(
          scanInput(fixtureEnv(root), [join(root, 'app')], {
            scanners: ['versions'],
          })
        );
        const items = new Map(report.items.map((item) => [item.path, item]));
        expect(items.has(new20)).toBe(false);
        expect(items.has(newest)).toBe(false);
        expect(items.has(lts)).toBe(false);
        expect(items.get(old20)?.blockers).toEqual([]);
        expect(items.get(old20)?.globalPackages).toBe(undefined);
        expect(items.get(tool)?.blockers).toEqual([]);
        expect(items.get(tool)?.tier).toBe('moderate');
        expect(items.get(tool)?.globalPackages).toEqual([
          '@openapitools/generator',
          'yarn',
        ]);
        expect(formatReport(report)).toMatch(
          /also removes global packages: @openapitools\/generator, yarn/
        );
        expect(items.get(tool)?.reason).toMatch(
          /also removes its global packages: @openapitools\/generator, yarn$/
        );
      } finally {
        removeRoot(root);
      }
    }
  );
});
