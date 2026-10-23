/**
 * Project scanning against real fixture trees: one project per rule of
 * every ecosystem, activity window, marker requirements, sizes compared
 * with `du`, and a scan never deleting anything.
 */

import { describe, it, expect } from 'test-anywhere';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_RULES } from '../src/rules/ecosystems.js';
import { clean } from '../src/clean.js';
import { scan, selfContainerIds } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  projectFixture,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

let aged = null;

describe('self container detection', () => {
  it('ignores another container whose shm is mounted on the host', async () => {
    const other = 'a'.repeat(64);
    const own = 'b'.repeat(64);
    const env = {
      platform: 'linux',
      readText: async (file) =>
        file.endsWith('mountinfo')
          ? `1 2 0:1 /var/lib/docker/containers/${other}/mounts/shm /other/shm rw - tmpfs shm rw\n3 4 0:2 /var/lib/docker/containers/${own}/hostname /etc/hostname rw - ext4 /dev/root rw`
          : '',
    };
    expect(await selfContainerIds(env)).toEqual([own]);
  });
});

/**
 * One fixture project per rule, untouched for 40 days, scanned once.
 */
function agedScan() {
  aged ??= (async () => {
    const root = tempRoot('dss-projects-');
    const dirs = new Map(
      PROJECT_RULES.map((rule) => [rule.id, projectFixture(root, rule)])
    );
    age(root, 40 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
    );
    return { root, dirs, report };
  })();
  return aged;
}

describe('project rules find their fixture project', () => {
  for (const rule of PROJECT_RULES) {
    itUnless(sandboxed)(
      `${rule.ecosystem}: ${rule.id} (${rule.names[0]})`,
      async () => {
        const { dirs, report } = await agedScan();
        const item = report.items.find(
          (candidate) => candidate.rule === rule.id
        );
        expect(item?.path).toBe(dirs.get(rule.id));
        expect(item.ecosystem).toBe(rule.ecosystem);
        expect(item.tier).toBe('safe');
        expect(item.blockers).toEqual([]);
        expect(item.bytes >= 64 * 1024).toBe(true);
        expect(item.action).toEqual({ type: 'remove', paths: [item.path] });
      }
    );
  }

  itUnless(sandboxed)(
    'reports each fixture exactly once and deletes nothing',
    async () => {
      const { dirs, report, root } = await agedScan();
      expect(report.items.map((item) => item.rule).sort()).toEqual(
        PROJECT_RULES.map((rule) => rule.id).sort()
      );
      for (const dir of dirs.values()) {
        expect(
          existsSync(join(dir, 'payload.bin')) ||
            existsSync(join(dir, 'pkg', 'payload.bin'))
        ).toBe(true);
      }
      removeRoot(root);
    }
  );
});

describe('project activity and markers', () => {
  itUnless(sandboxed)(
    'does not hold dependencies back for recent writes in project sources',
    async () => {
      const root = tempRoot('dss-nested-activity-');
      try {
        const rule = PROJECT_RULES.find((entry) => entry.id === 'node-modules');
        projectFixture(root, rule);
        age(root, 40 * DAY_MS);
        writeBlob(join(root, rule.id, 'src', 'deep', 'active.js'));
        const report = await scan(
          scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
        );
        const item = report.items.find(
          (entry) => entry.rule === 'node-modules'
        );
        expect(item?.tier).toBe('safe');
        expect(item.blockers).toEqual([]);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'blocks a project written inside the activity window',
    async () => {
      const root = tempRoot('dss-fresh-');
      const rule = PROJECT_RULES.find((r) => r.id === 'node-modules');
      projectFixture(root, rule);
      const report = await scan(
        scanInput(fixtureEnv(root), [root], {
          scanners: ['projects'],
          staleAge: '1h',
        })
      );
      const [item] = report.items;
      expect(item.blockers.join()).toMatch(/inside the 1h activity window/);
      removeRoot(root);
    }
  );

  itUnless(sandboxed)(
    'cleans projects used days ago in the safe tier',
    async () => {
      const root = tempRoot('dss-active-');
      const rule = PROJECT_RULES.find((r) => r.id === 'node-modules');
      projectFixture(root, rule);
      age(root, 3 * DAY_MS);
      const report = await scan(
        scanInput(fixtureEnv(root), [root], {
          scanners: ['projects'],
          inactive: '30d',
        })
      );
      expect(report.items[0].tier).toBe('safe');
      expect(report.items[0].blockers).toEqual([]);
      removeRoot(root);
    }
  );

  itUnless(sandboxed)(
    'ignores same-named directories without the project marker',
    async () => {
      const root = tempRoot('dss-unmarked-');
      for (const name of ['target', 'build', 'vendor', 'lib', 'bin', 'obj']) {
        writeBlob(join(root, 'plain', name, 'data.bin'));
      }
      writeBlob(join(root, 'venv-like', '.venv', 'data.bin'));
      age(root, 40 * DAY_MS);
      const report = await scan(
        scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
      );
      expect(report.items).toEqual([]);
      removeRoot(root);
    }
  );

  itUnless(sandboxed)(
    'respects --exclude for a project directory',
    async () => {
      const root = tempRoot('dss-exclude-');
      const rule = PROJECT_RULES.find((r) => r.id === 'node-modules');
      const dir = projectFixture(root, rule);
      age(root, 40 * DAY_MS);
      const report = await scan(
        scanInput(fixtureEnv(root), [root], {
          scanners: ['projects'],
          exclude: [dir],
        })
      );
      expect(report.items).toEqual([]);
      removeRoot(root);
    }
  );

  itUnless(sandboxed)(
    'requires a lockfile before reporting installed dependencies and again at clean time',
    async () => {
      const root = tempRoot('dss-lockfile-');
      const rule = PROJECT_RULES.find((entry) => entry.id === 'node-modules');
      const modules = projectFixture(root, rule);
      const lock = join(root, rule.id, 'package-lock.json');
      age(root, 40 * DAY_MS);
      const env = fixtureEnv(root);
      const input = scanInput(env, [root], { scanners: ['projects'] });
      const report = await scan(input);
      expect(report.items.some((item) => item.path === modules)).toBe(true);
      rmSync(lock);
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        audit: false,
      });
      expect(audit.entries[0].reason).toMatch(/no lockfile remains/);
      expect(existsSync(modules)).toBe(true);
      expect(
        (await scan(input)).items.some((item) => item.path === modules)
      ).toBe(false);
      removeRoot(root);
    }
  );

  itUnless(sandboxed)(
    'does not scan global installs under hidden configuration directories',
    async () => {
      const root = tempRoot('dss-global-installs-');
      writeBlob(
        join(
          root,
          '.config',
          'yarn',
          'global',
          'node_modules',
          'cli',
          'index.js'
        )
      );
      writeFileSync(
        join(root, '.config', 'yarn', 'global', 'package.json'),
        '{}'
      );
      writeFileSync(
        join(root, '.config', 'yarn', 'global', 'package-lock.json'),
        '{}'
      );
      age(root, 40 * DAY_MS);
      const report = await scan(
        scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
      );
      expect(report.items).toEqual([]);
      removeRoot(root);
    }
  );
});

function duBytes(target) {
  const output = execFileSync('du', ['-sk', target]).toString();
  return Number(output.split(/\s+/)[0]) * 1024;
}

describe('sizes', () => {
  itUnless(
    sandboxed,
    process.platform === 'win32' && 'du is not available on Windows'
  )('match du within 5%', async () => {
    const root = tempRoot('dss-du-');
    const project = join(root, 'app');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'package-lock.json'), '{}');
    const modules = join(project, 'node_modules');
    for (let index = 0; index < 40; index++) {
      writeBlob(
        join(modules, `pkg-${index % 7}`, `file-${index}.js`),
        1 + index * 3001
      );
    }
    writeBlob(join(modules, 'big', 'bundle.js'), 3 * 1024 * 1024 + 17);
    age(root, 40 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
    );
    const expected = duBytes(modules);
    const measured = report.items[0].bytes;
    expect(Math.abs(measured - expected) / expected <= 0.05).toBe(true);
    removeRoot(root);
  });
});

describe('git worktree folders', () => {
  itUnless(sandboxed)(
    'searches below them with the full depth again',
    async () => {
      const root = tempRoot('dss-worktrees-');
      try {
        const nested = (...parts) => join(root, 'org', 'repo', ...parts, 'js');
        for (const project of [
          nested('.worktrees', 'issue-1'),
          nested('.claude', 'worktrees', 'agent-2'),
          nested('plain', 'deeper'),
        ]) {
          writeFileSync(join(mkdirp(project), 'package.json'), '{}');
          writeFileSync(join(project, 'package-lock.json'), '{}');
          writeBlob(join(project, 'node_modules', 'pkg', 'index.js'));
        }
        age(root, 40 * DAY_MS);
        const report = await scan(
          scanInput(fixtureEnv(root), [root], {
            scanners: ['projects'],
            maxDepth: 4,
          })
        );
        const found = report.items
          .filter((item) => item.rule === 'node-modules')
          .map((item) => item.path)
          .sort();
        expect(found).toEqual(
          [
            join(nested('.claude', 'worktrees', 'agent-2'), 'node_modules'),
            join(nested('.worktrees', 'issue-1'), 'node_modules'),
          ].sort()
        );
      } finally {
        removeRoot(root);
      }
    }
  );
});

describe('data kept inside node_modules', () => {
  async function modulesFixture(callback) {
    const root = tempRoot('dss-foreign-modules-');
    const project = join(root, 'app');
    const modules = join(project, 'node_modules');
    writeFileSync(join(mkdirp(project), 'package.json'), '{}');
    writeFileSync(join(project, 'package-lock.json'), '{}');
    writeBlob(join(modules, 'pkg', 'index.js'));
    writeFileSync(join(modules, 'pkg', 'package.json'), '{}');
    writeBlob(join(modules, '@scope', 'lib', 'index.js'));
    writeBlob(join(modules, '.bin', 'tool'));
    writeBlob(join(modules, '.cache', 'babel', 'entry.json'));
    writeFileSync(join(modules, '.package-lock.json'), '{}');
    mkdirp(join(modules, 'empty-leftover'));
    const env = fixtureEnv(root);
    const input = scanInput(env, [root], { scanners: ['projects'] });
    const itemOf = (report) =>
      report.items.find((item) => item.path === modules);
    try {
      await callback({ root, env, input, modules, itemOf });
    } finally {
      removeRoot(root);
    }
  }

  itUnless(sandboxed)(
    'offers node_modules holding only what package managers install',
    () =>
      modulesFixture(async ({ root, input, itemOf }) => {
        age(root, 40 * DAY_MS);
        expect(itemOf(await scan(input)).blockers).toEqual([]);
      })
  );

  itUnless(sandboxed)(
    'keeps node_modules holding data a reinstall does not re-create',
    () =>
      modulesFixture(async ({ root, input, modules, itemOf }) => {
        writeBlob(join(modules, '.issue-1-verification', 'run-1', 'log.json'));
        age(root, 40 * DAY_MS);
        const [blocker] = itemOf(await scan(input)).blockers;
        expect(blocker).toMatch(
          /^holds data no package manager installs: \.issue-1-verification \([\d.]+ KiB\); a reinstall does not re-create it/
        );
      })
  );

  itUnless(sandboxed)('checks for such data again before deleting', () =>
    modulesFixture(async ({ root, env, input, modules, itemOf }) => {
      age(root, 40 * DAY_MS);
      const report = await scan(input);
      expect(itemOf(report).blockers).toEqual([]);
      writeBlob(join(modules, 'evidence', 'capture.bin'));
      age(root, 40 * DAY_MS);
      const audit = await clean(report, { env, tier: 'safe', audit: false });
      const entry = audit.entries.find((e) => e.path === modules);
      expect(entry.status).toBe('skipped');
      expect(entry.reason).toMatch(/evidence \([\d.]+ KiB\)/);
      expect(existsSync(join(modules, 'evidence', 'capture.bin'))).toBe(true);
    })
  );
});

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
