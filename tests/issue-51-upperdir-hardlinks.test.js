/**
 * Issue 51: the upperdir cleanup audit credits as freed only blocks whose
 * every hard link is inside the deletion set.
 */
import { describe, expect } from 'test-anywhere';
import { linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { hostExecutor } from '../src/exec.js';
import { WritableLayer } from '../src/docker/writable.js';
import { Cleaner } from '../src/clean.js';
import { makeItem } from '../src/items.js';
import { resolveOptions } from '../src/options.js';
import { fixtureEnv, removeRoot, tempRoot } from './helpers/fixtures.js';
import { itUnless, notLinux, sandboxed } from './helpers/skip.js';

const MiB = 1024 * 1024;
// Directory entries and metadata may be released; file data may not.
const OVERHEAD = 256 * 1024;

function layerFixture() {
  const root = tempRoot('dss-issue-51-');
  const upper = join(root, 'upper');
  mkdirSync(upper);
  const layer = new WritableLayer(hostExecutor(), 'synthetic-fixture');
  layer.snapshot = async () => ({
    container: { Mounts: [] },
    upperdir: upper,
  });
  const file = (target, bytes = 8 * MiB) => {
    mkdirSync(join(upper, posix.dirname(target)), { recursive: true });
    writeFileSync(join(upper, target), Buffer.alloc(bytes, 1));
  };
  const link = (from, to) => {
    mkdirSync(join(upper, posix.dirname(to)), { recursive: true });
    linkSync(join(upper, from), join(upper, to));
  };
  const remove = (targets) => {
    for (const target of targets) {
      rmSync(join(upper, target), { recursive: true, force: true });
    }
  };
  const freed = async (targets) => {
    const before = await layer.allocatedBytes(targets, posix);
    remove(targets);
    const after = await layer.allocatedBytes(targets, posix);
    return { before, after, freed: before.bytes - after.bytes };
  };
  return { root, upper, layer, file, link, freed };
}

describe('issue 51: link-aware upperdir measurement', () => {
  itUnless(sandboxed, notLinux)(
    'external surviving link: retained blocks are shared, not freed',
    async () => {
      const f = layerFixture();
      try {
        f.file('cache/blob');
        f.link('cache/blob', 'installed/blob');
        const { before, freed } = await f.freed(['/cache']);
        expect(before.allocatedBytes).toBeGreaterThanOrEqual(8 * MiB);
        expect(before.sharedBytes).toBeGreaterThanOrEqual(8 * MiB);
        expect(freed).toBeLessThan(OVERHEAD);
      } finally {
        removeRoot(f.root);
      }
    }
  );

  itUnless(sandboxed, notLinux)(
    'internal links and links split across selected paths count once',
    async () => {
      const f = layerFixture();
      try {
        f.file('cache/a');
        f.link('cache/a', 'cache/b');
        f.file('one/x');
        f.link('one/x', 'two/x');
        const result = await f.freed(['/cache', '/one', '/two']);
        expect(result.before.sharedBytes).toBe(0);
        expect(result.freed).toBeGreaterThanOrEqual(16 * MiB);
        expect(result.freed).toBeLessThan(16 * MiB + OVERHEAD);
      } finally {
        removeRoot(f.root);
      }
    }
  );

  itUnless(sandboxed, notLinux)(
    'links split across batches are freed once, by the last batch',
    async () => {
      const f = layerFixture();
      try {
        f.file('one/x');
        f.link('one/x', 'two/x');
        const first = await f.freed(['/one']);
        const second = await f.freed(['/two']);
        expect(first.freed).toBeLessThan(OVERHEAD);
        expect(second.freed).toBeGreaterThanOrEqual(8 * MiB);
        expect(first.freed + second.freed).toBeLessThan(8 * MiB + OVERHEAD);
      } finally {
        removeRoot(f.root);
      }
    }
  );

  itUnless(sandboxed, notLinux)(
    'single-link files keep their bytes',
    async () => {
      const f = layerFixture();
      try {
        f.file('cache/plain', 4 * MiB);
        const result = await f.freed(['/cache']);
        expect(result.before.sharedBytes).toBe(0);
        expect(result.freed).toBeGreaterThanOrEqual(4 * MiB);
        expect(result.freed).toBeLessThan(4 * MiB + OVERHEAD);
      } finally {
        removeRoot(f.root);
      }
    }
  );
});

describe('issue 51: cleanup audit', () => {
  itUnless(sandboxed, notLinux)(
    'audit freedBytes excludes blocks retained by an outside link',
    async () => {
      const root = tempRoot('dss-issue-51-audit-');
      const upper = join(root, 'upper');
      const env = fixtureEnv(root);
      env.kind = 'container';
      const cache = join(root, 'cache');
      const upperPath = (target) => `${upper}/${target.replace(/^\/+/, '')}`;
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, 'blob'), Buffer.alloc(8 * MiB, 1));
      mkdirSync(upperPath(cache), { recursive: true });
      mkdirSync(join(upper, 'installed'), { recursive: true });
      writeFileSync(join(upperPath(cache), 'blob'), Buffer.alloc(8 * MiB, 1));
      linkSync(
        join(upperPath(cache), 'blob'),
        join(upper, 'installed', 'blob')
      );
      const host = hostExecutor();
      const layer = new WritableLayer(
        {
          label: 'daemon',
          run: (argv, options) =>
            argv[0] === 'cat'
              ? Promise.resolve({
                  code: 0,
                  stdout: `1 0 0:1 / / rw - overlay overlay rw,upperdir=${upper},workdir=/work\n`,
                  stderr: '',
                })
              : host.run(argv, options),
        },
        'synthetic-fixture'
      );
      layer.inspected = {
        Id: 'synthetic-fixture',
        State: { Pid: 42 },
        GraphDriver: null,
        Mounts: [],
      };
      env.writableLayer = layer;
      env.processes = async () => [];
      env.openPaths = async () => new Set();
      env.remove = async (selected) => {
        for (const target of selected) {
          rmSync(target, { recursive: true, force: true });
          rmSync(upperPath(target), { recursive: true, force: true });
        }
      };
      const item = makeItem(env, {
        rule: 'fixture',
        paths: [cache],
        path: cache,
        bytes: 8 * MiB,
        checks: { perPath: true, mtime: false },
      });
      const cleaner = new Cleaner(
        { environments: [{ id: env.id, chain: [] }], options: {} },
        resolveOptions({ env, docker: false, audit: false, staleAge: 0 })
      );
      try {
        const entry = await cleaner.process(item);
        expect(entry.status).toBe('removed');
        expect(entry.deletedPaths).toEqual([cache]);
        expect(entry.freedAccounting).toBe('hardlink-aware-measurement');
        expect(entry.freedBytes).toBeLessThan(OVERHEAD);
      } finally {
        removeRoot(root);
      }
    }
  );
});
