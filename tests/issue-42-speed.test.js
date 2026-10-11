import { describe, expect } from 'test-anywhere';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan, SCANNERS } from '../src/scan.js';
import { clean } from '../src/clean.js';
import { makeItem } from '../src/items.js';
import { checkSignal } from '../src/env/scope.js';
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

describe('issue 42 scan latency', () => {
  itUnless(sandboxed)(
    'runs global caches before project discovery by default',
    async () => {
      const root = tempRoot();
      const originals = { ...SCANNERS };
      const order = [];
      try {
        for (const name of Object.keys(SCANNERS)) {
          SCANNERS[name] = async () => {
            order.push(name);
            return [];
          };
        }
        await scan(scanInput(fixtureEnv(root), [root]));
        expect(order[0]).toBe('global');
      } finally {
        Object.assign(SCANNERS, originals);
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'retains eligible completed phases when a later phase exhausts its budget',
    async () => {
      const root = tempRoot();
      const env = fixtureEnv(root);
      env.processes = async () => [];
      env.openPaths = async () => new Set();
      const originals = { ...SCANNERS };
      const cache = writeBlob(join(root, 'cache', 'blob'));
      age(root, 40 * DAY_MS);
      try {
        SCANNERS.global = async () => [
          makeItem(env, { rule: 'fixture-cache', path: cache, bytes: 65536 }),
        ];
        SCANNERS.projects = async (context) => {
          context.emit(
            makeItem(env, { rule: 'partial-project', path: root, bytes: 65536 })
          );
          await new Promise((resolve) => setTimeout(resolve, 80));
          checkSignal(context.env.signal);
        };
        const report = await scan(
          scanInput(env, [root], {
            scanners: ['global', 'projects'],
            scanBudget: 50,
          })
        );
        expect(report.environments[0].scanStatus).toBe('budget-exceeded');
        expect(
          report.items.find((item) => item.rule === 'fixture-cache').blockers
        ).toEqual([]);
        expect(
          report.items
            .find((item) => item.rule === 'partial-project')
            .blockers.join(' ')
        ).toMatch(/incomplete/);
      } finally {
        Object.assign(SCANNERS, originals);
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'never sizes a whole project again to derive activity',
    async () => {
      const root = tempRoot();
      try {
        const rule = PROJECT_RULES.find((entry) => entry.id === 'node-modules');
        const candidate = projectFixture(root, rule);
        age(root, 40 * DAY_MS);
        writeBlob(join(root, rule.id, 'src', 'deep', 'active.js'));
        const env = fixtureEnv(root);
        const measured = [];
        const usage = env.rawUsage.bind(env);
        env.rawUsage = (target) => {
          measured.push(target);
          return usage(target);
        };
        const report = await scan(
          scanInput(env, [root], { scanners: ['projects'] })
        );
        expect(report.items[0].tier).toBe('aggressive');
        expect(measured).toEqual([candidate]);
      } finally {
        removeRoot(root);
      }
    }
  );
});

describe('issue 42 discovery and reuse', () => {
  itUnless(sandboxed)(
    'walks directories with bounded concurrent workers and prunes matches',
    async () => {
      const root = tempRoot();
      const env = fixtureEnv(root);
      let active = 0,
        peak = 0;
      const visited = [];
      for (let index = 0; index < 16; index++) {
        mkdirSync(join(root, String(index), 'node_modules', 'nested'), {
          recursive: true,
        });
        writeFileSync(join(root, String(index), '.nvmrc'), '20');
      }
      const list = env.list.bind(env);
      env.list = async (dir) => {
        active++;
        peak = Math.max(peak, active);
        visited.push(dir);
        try {
          await new Promise((resolve) => setTimeout(resolve, 3));
          return await list(dir);
        } finally {
          active--;
        }
      };
      try {
        const matches = await env.findDirs([root], { globs: ['node_modules'] });
        expect(matches.length).toBe(16);
        expect(peak > 1 && peak <= 8).toBe(true);
        expect(visited.some((dir) => dir.includes('node_modules'))).toBe(false);
        visited.length = 0;
        await env.findFiles([root], { names: ['.nvmrc'] });
        expect(visited.some((dir) => dir.includes('node_modules'))).toBe(false);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'reuses a recent authenticated JSON report without discovery',
    async () => {
      const root = tempRoot();
      const env = fixtureEnv(root);
      const cacheDir = join(root, 'state');
      writeBlob(join(root, 'home', '.npm', '_cacache', 'blob'));
      age(root, 40 * DAY_MS);
      try {
        const report = await scan(
          scanInput(env, [root], { scanners: ['global'], cacheDir })
        );
        const original = SCANNERS.global;
        let calls = 0;
        SCANNERS.global = async (...args) => {
          calls++;
          return original(...args);
        };
        try {
          const audit = await clean(JSON.parse(JSON.stringify(report)), {
            env,
            cacheDir,
            docker: false,
            noNative: true,
            dryRun: true,
            audit: false,
          });
          expect(
            audit.entries.some(
              (entry) =>
                entry.rule === 'npm-cache' && entry.status === 'planned'
            )
          ).toBe(true);
          expect(calls).toBe(0);
        } finally {
          SCANNERS.global = original;
        }
      } finally {
        removeRoot(root);
      }
    }
  );
});
