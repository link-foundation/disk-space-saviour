/**
 * Runtime caches are blocked by actual use, not by a related tool merely
 * running somewhere: a long-running Bun script or Codex daemon does not keep
 * the Bun install cache or abandoned Codex staging directories busy.
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdirSync, symlinkSync } from 'node:fs';
import path, { join } from 'node:path';

import { LivenessProbe } from '../src/liveness.js';
import { parsePsSearchPaths } from '../src/env/local.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const NOW = 1_000_000_000_000;
const BUN_CACHE = {
  rule: 'bun-cache',
  paths: ['/home/me/.bun/install/cache'],
  newestMtimeMs: NOW - DAY_MS,
  checks: { busy: ['bun', 'bunx'], cwd: null, mtime: false },
};

async function bunProbe(processes, installed = ['/work/app/node_modules']) {
  const env = {
    path: path.posix,
    processes: () => Promise.resolve(processes),
    openPaths: () => Promise.resolve(new Set()),
    exists: (target) => Promise.resolve(installed.includes(target)),
  };
  const probe = new LivenessProbe(env, { staleAgeMs: 3600e3, now: () => NOW });
  await probe.refresh();
  return probe;
}

describe('Bun install cache liveness', () => {
  it('ignores a script of an installed project', async () => {
    const probe = await bunProbe([
      {
        pid: 5,
        name: 'bun',
        command: 'bun /work/app/src/watchdog.mjs',
        cwd: '/work/app',
      },
    ]);
    expect(probe.busyReason(BUN_CACHE)).toBe(null);
  });

  it('is busy while a package command runs', async () => {
    const probe = await bunProbe([
      { pid: 6, name: 'bun', command: 'bun install', cwd: '/work/app' },
    ]);
    expect(probe.busyReason(BUN_CACHE)).toBe('bun is running (pid 6)');
  });

  it('is busy while bunx runs', async () => {
    const probe = await bunProbe([
      { pid: 7, name: 'bunx', command: 'bunx cowsay hi', cwd: '/work/app' },
    ]);
    expect(probe.busyReason(BUN_CACHE)).toBe('bunx is running (pid 7)');
  });

  it('is busy while a script auto-installs without node_modules', async () => {
    const probe = await bunProbe([
      { pid: 8, name: 'bun', command: 'bun run x.ts', cwd: '/work/loose' },
    ]);
    expect(probe.busyReason(BUN_CACHE)).toBe('bun is running (pid 8)');
  });

  it('is busy when the working directory is unknown', async () => {
    const probe = await bunProbe([
      { pid: 9, name: 'bun', command: 'bun x.ts' },
    ]);
    expect(probe.busyReason(BUN_CACHE)).toBe('bun is running (pid 9)');
  });

  it('still blocks the cache for files a process holds open', async () => {
    const env = {
      path: path.posix,
      processes: () => Promise.resolve([]),
      openPaths: () =>
        Promise.resolve(new Set(['/home/me/.bun/install/cache/pkg/index.js'])),
    };
    const probe = new LivenessProbe(env, {
      staleAgeMs: 3600e3,
      now: () => NOW,
    });
    await probe.refresh();
    expect(probe.busyReason(BUN_CACHE)).toBe(
      'in use: /home/me/.bun/install/cache/pkg/index.js'
    );
  });
});

async function fixture(callback) {
  if (readOnlyRuntime()) {
    return;
  }
  const root = tempRoot('dss-runtime-caches-');
  try {
    const env = fixtureEnv(root);
    env.currentHome = join(root, 'home');
    await callback(root, join(root, 'home'), env);
  } finally {
    removeRoot(root);
  }
}

describe('Codex runtime files', () => {
  it('keeps the current and newest daemon releases', async () =>
    fixture(async (root, home, env) => {
      const daemon = join(home, '.codex/packages/app-server-daemon');
      for (const version of ['0.161.0', '0.162.1', '0.163.0']) {
        writeBlob(join(daemon, 'releases', `${version}-aarch64`, 'bin/codex'));
      }
      symlinkSync(
        join(daemon, 'releases/0.162.1-aarch64'),
        join(daemon, 'current')
      );
      age(root, 3 * DAY_MS);
      const report = await scan(scanInput(env, [], { scanners: ['versions'] }));
      expect(
        report.items
          .filter((item) => item.rule === 'codex-daemon-releases')
          .map((item) => item.path)
      ).toEqual([join(daemon, 'releases/0.161.0-aarch64')]);
    }));

  it('reports abandoned staging while the Codex daemon runs', async () =>
    fixture(async (root, home, env) => {
      const staging = join(
        home,
        '.cache/codex-runtimes/codex-runtime-install-AbC123'
      );
      writeBlob(join(staging, 'node-runtime.tar.xz'));
      mkdirSync(join(home, '.cache/codex-runtimes/codex-primary-runtime'));
      age(root, 3 * DAY_MS);
      env.processes = async () => [
        {
          pid: 41,
          name: 'codex',
          command: 'codex app-server daemon',
          cwd: home,
        },
      ];
      const report = await scan(scanInput(env, [], { scanners: ['global'] }));
      const item = report.items.find(
        (entry) => entry.rule === 'codex-runtime-staging'
      );
      expect(item?.path).toBe(staging);
      expect(item.blockers).toEqual([]);
    }));
});

describe('PATH directories of running processes', () => {
  const release = '/home/me/.codex/packages/daemon/releases/0.162.1';
  const item = {
    rule: 'codex-daemon-releases',
    paths: [release],
    newestMtimeMs: NOW - DAY_MS,
    checks: { busy: ['codex'], cwd: release, mtime: true },
  };

  async function pathProbe(processes, realPaths = new Map()) {
    const env = {
      path: path.posix,
      processes: () => Promise.resolve(processes),
      openPaths: () => Promise.resolve(new Set()),
      realPathMany: (targets) =>
        Promise.resolve(new Map(targets.map((t) => [t, realPaths.get(t)]))),
    };
    const probe = new LivenessProbe(env, {
      staleAgeMs: 3600e3,
      now: () => NOW,
    });
    await probe.refresh();
    await probe.resolve(item.paths);
    return probe;
  }

  it('keeps a release a process may still start programs from', async () => {
    const probe = await pathProbe([
      {
        pid: 12,
        name: 'node',
        command: 'node mcp.js',
        searchPath: ['/usr/bin', `${release}/codex-path`],
      },
    ]);
    expect(probe.busyReason(item)).toBe(
      `on the PATH of node (pid 12): ${release}/codex-path`
    );
  });

  it('compares resolved paths', async () => {
    const probe = await pathProbe(
      [{ pid: 13, name: 'sh', searchPath: [`/private${release}/bin`] }],
      new Map([[release, `/private${release}`]])
    );
    expect(probe.busyReason(item)).toBe(
      `on the PATH of sh (pid 13): /private${release}/bin`
    );
  });

  it('ignores PATH entries outside the item', async () => {
    const probe = await pathProbe([
      { pid: 14, name: 'sh', searchPath: ['/usr/bin', '/home/me/.local/bin'] },
    ]);
    expect(probe.busyReason(item)).toBe(null);
  });

  it('reads PATH from ps -E output', () => {
    const output = [
      '  12 node mcp.js TERM=xterm PATH=/a/bin:/b/codex-path:relative HOME=/h',
      '  13 /bin/sleep 9',
      '  14 env PATH=/x/bin tool PATH=/y/bin',
    ].join('\n');
    expect([...parsePsSearchPaths(output)]).toEqual([
      [12, ['/a/bin', '/b/codex-path']],
      [14, ['/x/bin', '/y/bin']],
    ]);
  });
});
