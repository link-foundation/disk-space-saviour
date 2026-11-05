/**
 * What a scan keeps or cannot read must still show in its report.
 */

import { describe, it, expect } from 'test-anywhere';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { formatReport } from '../src/report.js';
import { resolveOptions } from '../src/options.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
  writePackage,
} from './helpers/fixtures.js';

const projectsScan = (env, root) =>
  scan(scanInput(env, [root], { scanners: ['projects'] }));

describe('scan coverage gaps', () => {
  it('reports a node_modules without a manifest as blocked and keeps it', async () => {
    const root = tempRoot('dss-orphan-');
    try {
      const modules = join(root, 'worktree', 'packages', 'js', 'node_modules');
      writePackage(modules, 'left-behind');
      writeBlob(join(modules, '.verification', 'run.log'));
      age(root, 2 * DAY_MS);
      const env = fixtureEnv(root);
      const report = await projectsScan(env, root);
      const item = report.items.find((entry) => entry.path === modules);
      expect(item.blockers.join()).toMatch(/no package\.json beside it/);
      expect(report.totals.safe.bytes).toBe(0);
      await clean(report, { env, tier: 'moderate', yes: true, audit: false });
      expect((await env.stat(modules)) !== null).toBe(true);
    } finally {
      removeRoot(root);
    }
  });

  it('names a missing lockfile when the manifest is present', async () => {
    const root = tempRoot('dss-orphan-lock-');
    try {
      const project = join(root, 'app');
      const modules = join(project, 'node_modules');
      writePackage(modules, 'dep');
      writeFileSync(join(project, 'package.json'), '{}');
      age(root, 2 * DAY_MS);
      const report = await projectsScan(fixtureEnv(root), root);
      const item = report.items.find((entry) => entry.path === modules);
      expect(item.blockers.join()).toMatch(/no lockfile beside it/);
    } finally {
      removeRoot(root);
    }
  });

  it('does not count nested items twice in a tier heading', async () => {
    const root = tempRoot('dss-heading-');
    try {
      const report = await scan(scanInput(fixtureEnv(root), [root]));
      const entry = (id, path) => ({
        id,
        env: 'host',
        rule: 'r',
        path,
        paths: [path],
        bytes: 100,
        tier: 'safe',
        blockers: [],
        parentId: null,
        action: { type: 'remove', paths: [path] },
      });
      const text = formatReport({
        ...report,
        items: [entry('a', '/t/clone'), entry('b', '/t/clone/node_modules')],
      });
      expect(text).toMatch(/SAFE {2}2 items, 100 B/);
    } finally {
      removeRoot(root);
    }
  });

  it('explains which toolchain versions stay', async () => {
    const root = tempRoot('dss-kept-');
    try {
      const toolchains = join(root, 'home', '.rustup', 'toolchains');
      for (const name of ['1.70.0', '1.80.0', '1.90.0']) {
        writeBlob(join(toolchains, name, 'lib', 'blob'));
      }
      mkdirSync(join(root, 'home', '.rustup'), { recursive: true });
      writeFileSync(
        join(root, 'home', '.rustup', 'settings.toml'),
        'default_toolchain = "1.70.0"\n'
      );
      age(root, 40 * DAY_MS);
      const report = await scan(
        scanInput(fixtureEnv(root), [], { scanners: ['versions'] })
      );
      const note = report.notes.find((text) => text.startsWith('rustup:'));
      expect(note).toMatch(/default or pinned by a project: 1\.70\.0/);
      expect(note).toMatch(/newest: 1\.90\.0/);
      expect(formatReport(report)).toMatch(/NOTES\n {2}rustup: kept/);
    } finally {
      removeRoot(root);
    }
  });

  it('gives a scan ten minutes by default', () => {
    expect(resolveOptions({}).scanBudgetMs).toBe(10 * 60 * 1000);
  });
});
