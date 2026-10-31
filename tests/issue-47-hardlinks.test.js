/**
 * Issue 47: hard-linked files are reclaimable only when every link is in
 * the selected deletion set; allocated, shared and reclaimable bytes are
 * reported separately.
 */
import { describe, expect, it } from 'test-anywhere';
import { linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  accountLinks,
  parseLinks,
  selectionBytes,
  withLinkAccounting,
} from '../src/env/hardlinks.js';
import { LocalEnv } from '../src/env/local.js';
import { ShellEnv } from '../src/env/shell.js';
import { hostExecutor } from '../src/exec.js';
import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  scanInput,
  tempRoot,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const MiB = 1024 * 1024;
const expectFields = (actual, fields) =>
  expect(
    Object.fromEntries(Object.keys(fields).map((key) => [key, actual[key]]))
  ).toEqual(fields);
const link = (path, id, nlink, bytes = MiB) => ({ path, id, nlink, bytes });

describe('issue 47: link accounting', () => {
  it('external link: 0 reclaimable, all shared', () => {
    const usage = withLinkAccounting({ bytes: 8 * MiB }, [
      link('/cache/a', '1:1', 2, 8 * MiB),
    ]);
    expectFields(usage, {
      allocatedBytes: 8 * MiB,
      sharedBytes: 8 * MiB,
      bytes: 0,
    });
  });

  it('internal links: counted once and reclaimable', () => {
    const usage = withLinkAccounting({ bytes: MiB }, [
      link('/c/a', '1:1', 2),
      link('/c/b', '1:1', 2),
    ]);
    expectFields(usage, { bytes: MiB, sharedBytes: 0 });
  });

  it('single-link files keep their bytes', () => {
    expectFields(withLinkAccounting({ bytes: 5 }, []), {
      bytes: 5,
      allocatedBytes: 5,
      sharedBytes: 0,
    });
  });

  it('links across two selected items are reclaimable once', () => {
    const usages = new Map([
      ['/a', withLinkAccounting({ bytes: MiB }, [link('/a/f', '1:1', 2)])],
      ['/b', withLinkAccounting({ bytes: MiB }, [link('/b/f', '1:1', 2)])],
    ]);
    expect(usages.get('/a').bytes).toBe(0);
    expect(selectionBytes(usages, ['/a', '/b'])).toEqual({
      allocatedBytes: MiB,
      sharedBytes: 0,
      bytes: MiB,
    });
    expect(selectionBytes(usages, ['/a']).bytes).toBe(0);
  });

  it('accountLinks never reports negative bytes', () => {
    expect(
      accountLinks([['/x', { allocated: 0, links: [link('/x/f', '1:1', 3)] }]])
        .bytes
    ).toBe(0);
  });

  it('parses the shell link listing', () => {
    expect(parseLinks('64:12 2 16 512 /a b\nnoise')).toEqual([
      { id: '64:12', nlink: 2, bytes: 8192, path: '/a b' },
    ]);
  });
});

describe('issue 47: real file system', () => {
  function fixture() {
    const root = tempRoot('dss-issue-47-');
    const cache = join(root, 'cache');
    const installed = join(root, 'installed');
    mkdirSync(cache);
    mkdirSync(installed);
    writeFileSync(join(cache, 'blob'), Buffer.alloc(8 * MiB, 1));
    linkSync(join(cache, 'blob'), join(installed, 'blob'));
    writeFileSync(join(cache, 'own'), Buffer.alloc(MiB, 2));
    return { root, cache, installed };
  }

  for (const mode of ['rawUsage', 'quickUsage']) {
    it(`${mode} reports the externally linked blob as shared`, async () => {
      const { cache } = fixture();
      const env = new LocalEnv({});
      const usage = await env[mode](cache);
      expect(usage.sharedBytes).toBeGreaterThanOrEqual(8 * MiB);
      expect(usage.bytes).toBeLessThan(2 * MiB);
      expect(usage.allocatedBytes).toBeGreaterThanOrEqual(9 * MiB);
    });
  }

  itUnless(sandboxed)('ShellEnv (container transport) agrees', async () => {
    const { cache } = fixture();
    const env = new ShellEnv(hostExecutor());
    const usage = (await env.rawUsageMany([cache])).get(cache);
    expect(usage.sharedBytes).toBeGreaterThanOrEqual(8 * MiB);
    expect(usage.bytes).toBeLessThan(2 * MiB);
  });

  it('selecting both link holders makes the blob reclaimable', async () => {
    const { cache, installed } = fixture();
    const env = new LocalEnv({});
    const usages = new Map([
      [cache, await env.rawUsage(cache)],
      [installed, await env.rawUsage(installed)],
    ]);
    const both = selectionBytes(usages, [cache, installed]);
    expect(both.sharedBytes).toBe(0);
    expect(both.bytes).toBeGreaterThanOrEqual(9 * MiB);
    expect(both.bytes).toBeLessThan(10 * MiB);
  });
});

describe('issue 47: clean audit', () => {
  itUnless(sandboxed)(
    'node_modules hard-linked to an outside store frees only its own blocks',
    async () => {
      const root = tempRoot('dss-issue-47-clean-');
      const project = join(root, 'app');
      const modules = join(project, 'node_modules', 'pkg');
      const store = join(root, 'store');
      mkdirSync(modules, { recursive: true });
      mkdirSync(store);
      writeFileSync(join(store, 'blob'), Buffer.alloc(8 * MiB, 1));
      linkSync(join(store, 'blob'), join(modules, 'blob'));
      writeFileSync(join(modules, 'own'), Buffer.alloc(2 * MiB, 3));
      writeFileSync(join(modules, 'package.json'), '{}');
      writeFileSync(join(project, 'package.json'), '{}');
      writeFileSync(join(project, 'package-lock.json'), '{}');
      age(root, 40 * DAY_MS);
      const env = fixtureEnv(root);
      const report = await scan(
        scanInput(env, [root], { scanners: ['projects'], minSize: 0 })
      );
      const item = report.items.find((entry) =>
        entry.paths?.[0]?.endsWith('node_modules')
      );
      expect(item.bytes < 3 * MiB).toBe(true);
      const audit = await clean(report, {
        env,
        tier: 'safe',
        auditDir: join(root, 'audit'),
      });
      const entry = audit.entries.find((e) => e.id === item.id);
      expect(entry.status).toBe('removed');
      expect(entry.sharedBytes >= 8 * MiB).toBe(true);
      expect(entry.freedBytes >= 2 * MiB).toBe(true);
      expect(entry.freedBytes < 3 * MiB).toBe(true);
      expect(entry.freedAccounting).toBe('hardlink-aware-estimate');
    }
  );
});
