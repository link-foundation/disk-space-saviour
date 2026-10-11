/** Bounded synthetic scan/reuse benchmark. Run with Node, optionally --baseline REF. */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'dss-42-benchmark-'));
const baseline = process.argv[2];
const source = baseline ? join(root, 'baseline') : resolve('.');

function write(file, content = Buffer.alloc(1024, 7)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function age(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      age(file);
    }
    utimesSync(file, old, old);
  }
  utimesSync(dir, old, old);
}

const old = new Date(Date.now() - 40 * 86400000);
const home = join(root, 'fixture', 'home');
const projects = join(root, 'fixture', 'projects');
for (let project = 0; project < 32; project++) {
  const dir = join(projects, String(project));
  write(join(dir, 'package.json'), '{}');
  write(join(dir, 'package-lock.json'), '{}');
  for (let file = 0; file < 64; file++) {
    write(join(dir, 'node_modules', 'dependency', String(file)));
    write(join(dir, 'src', 'nested', String(file)));
  }
}
for (let file = 0; file < 128; file++) {
  write(join(home, '.npm', '_cacache', String(file)));
  write(join(home, '.cache', 'pip', String(file)));
}
age(join(root, 'fixture'));

async function measure(label, operation) {
  const start = performance.now();
  const value = await operation();
  results.push({ label, milliseconds: Math.round(performance.now() - start) });
  return value;
}

const results = [];
try {
  if (baseline) {
    mkdirSync(source);
    const archive = join(root, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '-o', archive, baseline]);
    execFileSync('tar', ['-xf', archive, '-C', source]);
  }
  const module = (name) => import(pathToFileURL(join(source, 'src', name)));
  const { scan } = await module('scan.js');
  const { clean } = await module('clean.js');
  const { LocalEnv } = await module('env/local.js');
  const env = new LocalEnv({ homes: [home], tmpDirs: [], vars: {} });
  env.processes = () => Promise.resolve([]);
  env.openPaths = () => Promise.resolve(new Set());
  const readText = env.readText.bind(env);
  env.readText = (target, ...args) =>
    target.startsWith('/proc/self/')
      ? Promise.resolve(null)
      : readText(target, ...args);
  let wholeProjectSizes = 0;
  const rawUsage = env.rawUsage.bind(env);
  env.rawUsage = (target) => {
    if (/projects[/\\]\d+$/.test(target)) {
      wholeProjectSizes++;
    }
    return rawUsage(target);
  };
  const options = {
    env,
    roots: [projects],
    scanners: ['global', 'projects'],
    docker: false,
    noNative: true,
    minSize: 0,
    cacheDir: join(root, 'state'),
    platformIndex: false,
  };
  const cold = await measure('cold scan', () => scan(options));
  const warm = await measure('warm scan', () => scan(options));
  const warmMetrics = env.scanMetrics ? { ...env.scanMetrics } : null;
  const audit = await measure('dry clean serialized plan', () =>
    clean(JSON.parse(JSON.stringify(warm)), {
      ...options,
      dryRun: true,
      audit: false,
    })
  );
  console.log(
    JSON.stringify(
      {
        source: baseline ?? 'working tree',
        runtime: process.version,
        platform: process.platform,
        fixture: '32 projects, 4416 regular files, 4.25 MiB logical payload',
        results,
        candidates: cold.items.length,
        planned: audit.entries.filter((entry) => entry.status === 'planned')
          .length,
        wholeProjectSizes,
        warmMetrics,
      },
      null,
      2
    )
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
