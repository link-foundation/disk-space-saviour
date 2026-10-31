import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalEnv } from '../src/env/local.js';
import { resolveOptions } from '../src/options.js';
import { environmentContext } from '../src/scan.js';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-roots-repro-'));
try {
  const home = path.join(base, 'home');
  const tmp = path.join(base, 'tmp');
  const custom = path.join(base, 'custom-projects');
  for (const dir of [home, tmp, custom]) {
    await fs.mkdir(dir);
  }
  const makeEnv = () => {
    const env = new LocalEnv({ homes: [home], tmpDirs: [tmp] });
    env.kind = 'container';
    return env;
  };
  const options = resolveOptions({
    roots: [custom],
    docker: false,
    cacheDir: false,
  });
  const recursive = await environmentContext(makeEnv(), options);
  const overridden = await environmentContext(makeEnv(), options, {
    roots: [custom],
  });
  console.log({
    requestedRootMissing: !recursive.options.roots.includes(custom),
    explicitOverrideWorks: overridden.options.roots.includes(custom),
  });
} finally {
  await fs.rm(base, { recursive: true, force: true });
}
