import { describe, it, expect } from 'test-anywhere';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean } from '../src/clean.js';
import { cleanDuringScan } from '../src/fast-clean.js';
import { emergency } from '../src/emergency.js';
import { runCli, scanAudit } from '../src/cli.js';
import { scan, SCANNERS } from '../src/scan.js';
import { ScanIndex, loadScan } from '../src/scan-state.js';
import { resolveOptions } from '../src/options.js';
import { readSwap, parseSwapUsage, parseMemoryHolders } from '../src/swap.js';
import { indexedDirectories } from '../src/env/platform-index.js';
import { itUnless, sandboxed } from './helpers/skip.js';
import {
  age,
  DAY_MS,
  fixtureEnv,
  projectFixture,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { PROJECT_RULES } from '../src/rules/ecosystems.js';

function fixture() {
  const root = tempRoot();
  const env = fixtureEnv(root);
  env.processes = async () => [];
  env.openPaths = async () => new Set();
  const file = writeBlob(join(root, 'home', '.npm', '_cacache', 'blob'));
  age(root, 40 * DAY_MS);
  const input = scanInput(env, [root], {
    scanners: ['global', 'projects'],
    cacheDir: join(root, 'state'),
    platformIndex: false,
  });
  return { root, env, file, input };
}

describe('issue 42 reusable scan state', () => {
  itUnless(sandboxed)(
    'reuses CLI scans and accepts full audit JSON with --from',
    async () => {
      const { root, env, input } = fixture();
      const options = { ...input, scanners: ['global'] };
      const report = await scan(options);
      const file = join(root, 'audit.json');
      writeFileSync(file, JSON.stringify(scanAudit(report)));
      let discovery = 0;
      const out = [],
        err = [];
      const api = {
        scan: async () => {
          discovery++;
          throw new Error('unexpected discovery');
        },
        clean: (saved, extra) => clean(saved, { ...extra, env, audit: false }),
      };
      const args = [
        'clean',
        root,
        '--scanner',
        'global',
        '--no-docker',
        '--no-native',
        '--min-size',
        '0',
        '--cache-dir',
        input.cacheDir,
        '--json',
      ];
      try {
        for (const extra of [[], ['--from', file]]) {
          expect(
            await runCli([...args, ...extra], {
              api,
              io: {
                stdout: (value) => out.push(value),
                stderr: (value) => err.push(value),
                interactive: false,
              },
            })
          ).toBe(0);
          expect(JSON.parse(out.at(-1)).entries[0].status).toBe('planned');
        }
        expect(discovery).toBe(0);
        expect(err.join('\n')).toMatch(/Reusing scan/);
        expect(
          await loadScan(resolveOptions({ ...options, minSize: 1000000 }))
        ).toBe(null);
        const expired = await loadScan(
          resolveOptions({ ...options, now: () => Date.now() + 31 * 60 * 1000 })
        );
        expect(expired).toBe(null);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'rejects edited signed actions and protects arbitrary files',
    async () => {
      const { root, input } = fixture();
      const keep = writeBlob(join(root, 'keep', 'notes'));
      age(root, 40 * DAY_MS);
      try {
        const saved = JSON.parse(JSON.stringify(await scan(input)));
        const item = saved.items.find((entry) => entry.rule === 'npm-cache');
        item.action = { type: 'remove', paths: [join(root, 'keep')] };
        item.paths = item.action.paths;
        await clean(saved, { ...input, audit: false });
        expect(existsSync(keep)).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'checks each descendant directory mtime and finds newly created nested projects',
    async () => {
      const { root, env, input } = fixture();
      writeBlob(join(root, 'code', 'nested', 'readme'));
      age(root, 40 * DAY_MS);
      try {
        await scan(input);
        const second = await scan(input);
        expect(env.scanMetrics.indexHits > 0).toBe(true);
        expect(second.items.some((item) => item.rule === 'node-modules')).toBe(
          false
        );
        const project = join(root, 'code', 'nested', 'app');
        writeBlob(join(project, 'node_modules', 'payload'));
        writeFileSync(join(project, 'package.json'), '{}');
        writeFileSync(join(project, 'package-lock.json'), '{}');
        const third = await scan(input);
        expect(
          third.items.some(
            (item) => item.path === join(project, 'node_modules')
          )
        ).toBe(true);
        const index = new ScanIndex(input.cacheDir);
        writeFileSync(
          join(input.cacheDir, 'index', 'directories.json'),
          '{broken'
        );
        await index.load();
        expect(index.entries.size).toBe(0);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'labels cached sizes and freshly measures changed descendants before cleanup',
    async () => {
      const { root, env, input } = fixture();
      const file = writeBlob(join(root, 'home', '.cache', 'pip', 'blob'));
      age(root, 40 * DAY_MS);
      try {
        const cold = await scan(input);
        writeBlob(file, 128 * 1024);
        const warm = await scan(input);
        const cache = warm.items.find((item) => item.rule === 'pip-cache');
        if (process.platform !== 'win32') {
          expect(cache.sizeEstimated).toBe(true);
          expect(env.scanMetrics.sizeCacheHits > 0).toBe(true);
          expect(cache.bytes).toBe(
            cold.items.find((item) => item.rule === 'pip-cache').bytes
          );
        }
        const audit = await clean(warm, {
          ...input,
          dryRun: true,
          audit: false,
        });
        expect(
          audit.entries.find((entry) => entry.rule === 'pip-cache')
            .plannedBytes >=
            128 * 1024
        ).toBe(true);
        expect(existsSync(file)).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );
});

describe('issue 42 streaming cleanup', () => {
  itUnless(sandboxed)(
    'preserves a task health stop across cleanup phases',
    async () => {
      const { root, env, input } = fixture();
      writeBlob(join(root, 'home', '.cache', 'pip', 'blob'));
      let removed = false;
      env.processes = async () =>
        removed
          ? []
          : [
              {
                pid: 777,
                name: 'cargo',
                cwd: '/unrelated',
                startTime: 'first',
              },
            ];
      const remove = env.remove.bind(env);
      env.remove = async (paths) => {
        await remove(paths);
        removed = true;
      };
      try {
        const { audit } = await cleanDuringScan({ ...input, audit: false });
        expect(
          audit.entries.find((entry) => entry.rule === 'npm-cache').reason
        ).toMatch(/cleaning stopped/);
        expect(existsSync(join(root, 'home', '.npm', '_cacache', 'blob'))).toBe(
          true
        );
        expect(audit.health.length).toBe(1);
        expect(audit.health[0].lost[0].name).toBe('cargo');
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'cleans global caches before starting the project phase',
    async () => {
      const { root, file, input } = fixture();
      const original = SCANNERS.projects;
      let walked = false;
      SCANNERS.projects = async () => {
        walked = true;
        expect(existsSync(file)).toBe(false);
        return [];
      };
      try {
        const result = await cleanDuringScan({ ...input, audit: false });
        expect(walked).toBe(true);
        expect(
          result.audit.entries.map((entry) => [entry.rule, entry.status])
        ).toEqual([['npm-cache', 'removed']]);
        expect(result.audit.health.length >= 1).toBe(true);
      } finally {
        SCANNERS.projects = original;
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'stops emergency discovery as soon as global caches meet the goal',
    async () => {
      const { root, env, file, input } = fixture();
      const quick = writeBlob(join(root, 'home', '.cache', 'pip', 'blob'));
      age(root, 40 * DAY_MS);
      const measured = [];
      const usage = env.rawUsage.bind(env);
      env.rawUsage = (target) => {
        measured.push(target);
        return usage(target);
      };
      const original = SCANNERS.projects;
      let walks = 0;
      SCANNERS.projects = async () => {
        walks++;
        return [];
      };
      env.diskUsage = async () => ({
        total: 1024 * 1024,
        used: existsSync(quick) ? 1024 * 1024 : 512 * 1024,
        free: existsSync(quick) ? 0 : 512 * 1024,
      });
      try {
        const audit = await emergency({
          ...input,
          path: root,
          free: 1024,
          audit: false,
        });
        expect(audit.goalMet).toBe(true);
        expect(walks).toBe(0);
        expect(existsSync(file)).toBe(true);
        expect(measured.some((target) => target.includes('_cacache'))).toBe(
          false
        );
        expect(audit.report.environments[0].scanStatus).toBe('goal-reached');
      } finally {
        SCANNERS.projects = original;
        removeRoot(root);
      }
    }
  );
});

describe('issue 42 fresh filesystem safeguards', () => {
  itUnless(sandboxed)(
    'honors action-changing options when reusing authenticated JSON',
    async () => {
      const { root, env, input } = fixture();
      env.currentHome = join(root, 'home');
      env.which = async (name) => name === 'bun';
      writeBlob(join(root, 'home', '.bun', 'install', 'cache', 'blob'));
      age(root, 40 * DAY_MS);
      try {
        const saved = JSON.parse(
          JSON.stringify(await scan({ ...input, noNative: false }))
        );
        expect(
          saved.items.find((item) => item.rule === 'bun-cache').action.type
        ).toBe('command');
        const audit = await clean(saved, {
          ...input,
          noNative: true,
          dryRun: true,
          audit: false,
        });
        expect(
          audit.entries.find((entry) => entry.rule === 'bun-cache').action
        ).toBe('remove');
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'protects dependencies written after the saved scan',
    async () => {
      const { root, input } = fixture();
      const rule = PROJECT_RULES.find((entry) => entry.id === 'node-modules');
      const candidate = projectFixture(root, rule);
      age(root, 40 * DAY_MS);
      try {
        const saved = JSON.parse(JSON.stringify(await scan(input)));
        expect(saved.items.find((item) => item.path === candidate).tier).toBe(
          'safe'
        );
        writeBlob(join(candidate, 'fresh', 'index.js'));
        const audit = await clean(saved, { ...input, audit: false });
        expect(
          audit.entries.find((entry) => entry.path === candidate).reason
        ).toMatch(/modified/);
        expect(existsSync(candidate)).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'skips home media while discovering projects in explicitly selected media roots',
    async () => {
      const { root, env, input } = fixture();
      const media = join(root, 'home', 'Music');
      const candidate = writeBlob(join(media, 'app', 'node_modules', 'blob'));
      try {
        const report = await scan(input);
        expect(
          report.items.some(
            (item) => item.path === join(media, 'app', 'node_modules')
          )
        ).toBe(false);
        const explicit = await env.findDirs([media], {
          globs: ['node_modules'],
        });
        expect(explicit.length).toBe(1);
        expect(existsSync(candidate)).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed || process.platform === 'win32')(
    'follows explicit root aliases but rejects indexed hits through child symlinks',
    async () => {
      const { root, env, input } = fixture();
      const real = join(root, 'real');
      writeBlob(join(real, 'app', 'node_modules', 'blob'));
      const alias = join(root, 'alias');
      symlinkSync(real, alias);
      try {
        expect(
          (await env.findDirs([alias], { globs: ['node_modules'] })).length
        ).toBe(1);
        env.platform = 'darwin';
        env.scanIndex = new ScanIndex(input.cacheDir);
        env.which = async () => true;
        env.run = async () => ({
          code: 0,
          stdout: `${join(alias, 'app', 'node_modules')}\0`,
        });
        expect(
          await indexedDirectories(env, [root], ['node_modules'], 6)
        ).toEqual([]);
      } finally {
        removeRoot(root);
      }
    }
  );
});

describe('issue 42 platform diagnostics', () => {
  it('reports macOS swap and memory consumers without inventing per-process swap ownership', async () => {
    const text =
      'vm.swapusage: total = 32768.00M used = 31744.00M free = 1024.00M (encrypted)';
    const top =
      'PID COMMAND MEM CMPRS\n100 Docker Desktop 22G+ 4G\n101 browser 300M 40M\n';
    expect(parseSwapUsage(text).used).toBe(31 * 1024 ** 3);
    expect(parseMemoryHolders(top)[0].command).toBe('Docker Desktop');
    const env = {
      kind: 'host',
      platform: 'darwin',
      run: async (argv) => ({
        code: 0,
        stdout: argv[0] === 'sysctl' ? text : top,
      }),
    };
    const swap = await readSwap(env);
    expect(swap.holders[0].memoryBytes).toBe(22 * 1024 ** 3);
    expect(swap.attribution).toMatch(/does not expose per-process swap/);
    expect(swap.advice).toMatch(/lower its VM memory limit/);
    expect(await readSwap({ ...env, platform: 'win32' })).toBe(null);
    expect(
      await readSwap(
        { ...env, platform: 'linux' },
        { procRoot: '/dss-missing-proc' }
      )
    ).toBe(null);
    expect(parseSwapUsage('unavailable')).toBe(null);
  });

  itUnless(sandboxed)(
    'verifies platform index hits and falls back for stale hits',
    async () => {
      const { root, env, input } = fixture();
      const project = join(root, 'app');
      writeBlob(join(project, 'node_modules', 'payload'));
      env.platform = 'darwin';
      env.scanIndex = new ScanIndex(input.cacheDir);
      env.which = async (name) => name === 'mdfind';
      env.run = async () => ({
        code: 0,
        stdout: `${join(project, 'node_modules')}\0${join(root, 'missing', 'node_modules')}\0/etc/node_modules\0`,
      });
      try {
        const hits = await indexedDirectories(env, [root], ['node_modules'], 6);
        expect(hits.map((hit) => hit.path)).toEqual([
          join(project, 'node_modules'),
        ]);
        expect(
          readFileSync(join(project, 'node_modules', 'payload')).length
        ).toBe(65536);
      } finally {
        removeRoot(root);
      }
    }
  );
});
