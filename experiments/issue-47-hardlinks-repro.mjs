import { linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  scanInput,
  tempRoot,
} from '../tests/helpers/fixtures.js';
const MiB = 1 << 20;
const root = tempRoot('dss-issue-47-dbg-');
const project = join(root, 'app'),
  modules = join(project, 'node_modules', 'pkg'),
  store = join(root, 'store');
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
const report = await scan(scanInput(env, [root], { scanners: ['projects'] }));
console.log(
  report.items.map((i) => [
    i.id,
    i.tier,
    i.bytes,
    i.allocatedBytes,
    i.sharedBytes,
  ])
);
const audit = await clean(report, {
  env,
  tier: 'safe',
  auditDir: join(root, 'audit'),
});
console.log(
  JSON.stringify(
    { entries: audit.entries, error: audit.error, freed: audit.freedBytes },
    null,
    1
  )
);
