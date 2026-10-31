/**
 * Issue 48: requested roots must reach recursive container project
 * discovery (every Docker level) and every environment must report its
 * effective roots, so "complete" is visibly complete within a scope.
 */
import { describe, expect, it } from 'test-anywhere';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseCli, toOptions } from '../src/cli.js';
import { scanDocker } from '../src/docker/scan.js';
import { LocalEnv } from '../src/env/local.js';
import { resolveOptions } from '../src/options.js';
import { formatReport } from '../src/report.js';
import { tierTotals } from '../src/items.js';
import { PROJECT_RULES } from '../src/rules/ecosystems.js';
import { containerScanner, environmentContext } from '../src/scan.js';
import {
  FakeDockerWorld,
  daemonInfo,
  fakeHostEnv,
} from './helpers/fake-docker.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  projectFixture,
  tempRoot,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const rule = PROJECT_RULES.find((entry) => entry.id === 'node-modules');

function containerEnv(root) {
  const env = fixtureEnv(root);
  env.kind = 'container';
  return env;
}

/** Host daemon -> `outer` (runs a daemon) -> `inner`: two Docker levels. */
function dindWorld() {
  return new FakeDockerWorld({
    host: {
      info: daemonInfo('HOST', 'host-daemon'),
      containers: [
        { id: 'o1', name: 'outer', state: 'running', daemon: 'outer' },
      ],
    },
    outer: {
      info: daemonInfo('OUTER', 'outer-daemon'),
      containers: [{ id: 'i1', name: 'inner', state: 'running' }],
    },
  });
}

/**
 * Each container's file system is a real fixture tree with a lockfile
 * project at <root>/<name>/opt/projects, outside every container default.
 */
async function scanContainers(input) {
  const base = tempRoot('dss-issue-48-');
  const trees = new Map();
  for (const name of ['outer', 'inner']) {
    const root = join(base, name);
    mkdirSync(join(root, 'home'), { recursive: true });
    trees.set(name, {
      root,
      projects: join(root, 'opt', 'projects'),
      project: projectFixture(join(root, 'opt', 'projects'), rule),
    });
  }
  age(base, 40 * DAY_MS);
  const world = dindWorld();
  const host = fakeHostEnv(world);
  const resolve = typeof input === 'function' ? input(trees) : input;
  const options = resolveOptions({
    docker: true,
    dockerDepth: 3,
    minSize: 0,
    noNative: true,
    scanners: ['projects'],
    ...resolve,
  });
  const errors = [];
  const scanned = [];
  const result = await scanDocker(
    { env: host, executor: host.executor, chain: [] },
    options,
    async (inner) => {
      const name = inner.id.split('/').at(-1);
      const env = containerEnv(trees.get(name).root);
      env.id = inner.id;
      env.label = inner.label;
      const items = await containerScanner(options, errors)(env);
      scanned.push(name);
      inner.scanScope = env.scanScope;
      inner.scanStatus = env.scanStatus;
      return items;
    }
  );
  return { trees, result, scanned, errors };
}

/** Fixture containers share one real file system: attribute by environment. */
const projectItems = (result, tree, name) =>
  result.items.filter(
    (item) => item.path === tree.project && item.env.endsWith(`/${name}`)
  );

describe('issue 48: recursive container roots', () => {
  itUnless(sandboxed)(
    'containerRoots reaches project discovery at two Docker levels',
    async () => {
      const missing = '/nonexistent-dss-issue-48-root';
      const { trees, result, scanned } = await scanContainers((map) => ({
        containerRoots: [
          map.get('outer').projects,
          map.get('inner').projects,
          missing,
        ],
      }));
      expect(scanned).toEqual(['outer', 'inner']);
      for (const name of ['outer', 'inner']) {
        const tree = trees.get(name);
        expect(projectItems(result, tree, name).length).toBe(1);
        const descriptor = result.environments.find((env) =>
          env.id.endsWith(`/${name}`)
        );
        const own = descriptor.scope.roots.find(
          (root) => root.path === tree.projects
        );
        const other = descriptor.scope.roots.find(
          (root) => root.path === missing
        );
        expect(own).toEqual({
          path: tree.projects,
          source: 'container-roots',
          status: 'searched',
        });
        // A requested path missing in the container: reported, never searched.
        expect(other.status).toBe('absent');
        expect(descriptor.scope.maxDepth).toBe(6);
        expect(descriptor.scanStatus).toBe('complete');
      }
      expect(result.environments.map((env) => env.depth)).toEqual([1, 2]);
    }
  );

  itUnless(sandboxed)(
    'without requested roots the custom location stays outside the scope',
    async () => {
      const { trees, result } = await scanContainers({});
      for (const [name, tree] of trees) {
        expect(projectItems(result, tree, name)).toEqual([]);
      }
      const descriptor = result.environments[0];
      expect(descriptor.scope.roots.map((root) => root.source)).toEqual([
        'home',
      ]);
      expect(descriptor.scope.note).toMatch(/complete within these roots/);
    }
  );

  itUnless(sandboxed)(
    'exclusions still win over requested container roots',
    async () => {
      const { trees, result } = await scanContainers((map) => ({
        containerRoots: [map.get('inner').projects],
        exclude: [map.get('inner').projects],
      }));
      expect(projectItems(result, trees.get('inner'), 'inner')).toEqual([]);
      const inner = result.environments.find((env) => env.depth === 2);
      expect(inner.scope.roots[0].status).toBe('excluded');
      const text = formatReport({
        environments: [{ label: 'host', disk: null }, ...result.environments],
        items: [],
        totals: tierTotals([]),
        durationMs: 1,
        errors: [],
      });
      expect(text).toContain(`root ${trees.get('inner').projects} excluded`);
    }
  );

  itUnless(sandboxed)(
    'host roots that exist inside a container join its defaults',
    async () => {
      const missing = '/nonexistent-dss-issue-48-host-root';
      const { trees, result } = await scanContainers((map) => ({
        roots: [map.get('outer').projects, missing],
      }));
      expect(projectItems(result, trees.get('outer'), 'outer').length).toBe(1);
      for (const env of result.environments) {
        const requested = env.scope.roots.filter(
          (root) => root.source === 'roots'
        );
        expect(requested.map((root) => root.status)).toEqual([
          'searched',
          'absent',
        ]);
        // Defaults are kept next to the host roots.
        expect(env.scope.roots[0].source).toBe('home');
      }
    }
  );

  itUnless(sandboxed)(
    'environmentContext keeps requested roots in a recursive call',
    async () => {
      const base = tempRoot('dss-issue-48-context-');
      const home = join(base, 'home'),
        tmp = join(base, 'tmp'),
        custom = join(base, 'custom-projects');
      for (const dir of [home, tmp, custom]) {
        mkdirSync(dir, { recursive: true });
      }
      const env = new LocalEnv({ homes: [home], tmpDirs: [tmp] });
      env.kind = 'container';
      const options = resolveOptions({
        roots: [custom],
        docker: false,
        cacheDir: false,
      });
      const context = await environmentContext(env, options);
      expect(context.options.roots).toContain(custom);
      expect(env.scanPolicy.roots).toEqual([custom]);
    }
  );
});

describe('issue 48: options', () => {
  it('parses repeated --container-root flags', () => {
    const { values, paths } = parseCli([
      'scan',
      '/w',
      '--container-root',
      '/srv/a',
      '--container-root',
      '/srv/b',
    ]);
    const options = toOptions(values, paths);
    expect(options.roots).toEqual(['/w']);
    expect(options.containerRoots).toEqual(['/srv/a', '/srv/b']);
  });

  it('normalizes containerRoots like roots', () => {
    expect(resolveOptions({ containerRoots: '/a,/b' }).containerRoots).toEqual([
      '/a',
      '/b',
    ]);
    expect(resolveOptions({}).containerRoots).toBe(null);
  });
});
