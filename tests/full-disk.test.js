/**
 * A full disk is when dss is needed most: deleting goes on when the audit
 * log cannot be written for lack of space, and the log is written as soon
 * as deletions free room. Other audit failures still stop a clean.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, promises, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { recordAudit, startAudit, writeAudit } from '../src/audit.js';
import { clean } from '../src/clean.js';
import { formatAudit } from '../src/report.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writePackage,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

/**
 * Runs `callback` while writes inside `dir` fail with ENOSPC as long as
 * `full()` says the disk is full.
 */
async function withFullDisk(dir, full, callback) {
  const writeFile = promises.writeFile;
  promises.writeFile = (file, ...rest) => {
    if (String(file).startsWith(dir) && full()) {
      return Promise.reject(
        Object.assign(new Error(`ENOSPC: no space left on device`), {
          code: 'ENOSPC',
        })
      );
    }
    return writeFile(file, ...rest);
  };
  try {
    return await callback();
  } finally {
    promises.writeFile = writeFile;
  }
}

describe('audit log on a full disk', () => {
  it('records the failure and writes when space is free', async () => {
    const root = tempRoot('dss-full-audit-');
    let full = true;
    try {
      const audit = startAudit('clean');
      const options = { auditDir: join(root, 'audit') };
      await withFullDisk(
        root,
        () => full,
        async () => {
          expect(await recordAudit(audit, options)).toBe(null);
          expect(audit.auditError.code).toBe('ENOSPC');
          full = false;
          const file = await recordAudit(audit, options);
          expect(existsSync(file)).toBe(true);
          expect(audit.auditError).toBe(undefined);
        }
      );
      expect(readdirSync(join(root, 'audit'))).toEqual([
        `dss-clean-${audit.startedAt.replace(/[:.]/g, '-')}-${audit.pid}.json`,
      ]);
    } finally {
      removeRoot(root);
    }
  });

  it('still stops on an unusable audit location', async () => {
    const root = tempRoot('dss-full-audit-');
    const file = join(root, 'file');
    writeFileSync(file, 'not a directory');
    try {
      let failure = null;
      await recordAudit(startAudit('clean'), {
        auditDir: join(file, 'audit'),
      }).catch((error) => {
        failure = error;
      });
      expect(failure?.code).toBe('ENOTDIR');
    } finally {
      removeRoot(root);
    }
  });

  it('keeps the previous record when a write fails half way', async () => {
    const root = tempRoot('dss-full-audit-');
    try {
      const audit = startAudit('clean');
      const options = { auditDir: join(root, 'audit') };
      const file = await writeAudit(audit, options);
      audit.entries.push({ id: 'x' });
      await withFullDisk(
        root,
        () => true,
        () => recordAudit(audit, options)
      );
      expect(readdirSync(join(root, 'audit'))).toEqual([
        file.split(/[\\/]/).pop(),
      ]);
    } finally {
      removeRoot(root);
    }
  });
});

describe('clean on a full disk', () => {
  async function fullProject(callback) {
    const root = tempRoot('dss-full-clean-');
    const project = join(root, 'app');
    const modules = join(project, 'node_modules');
    writePackage(modules, 'dep');
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'package-lock.json'), '{}');
    age(root, 40 * DAY_MS);
    const env = fixtureEnv(root);
    const report = await scan(
      scanInput(env, [root], { scanners: ['projects'] })
    );
    try {
      await callback({ root, env, report, modules });
    } finally {
      removeRoot(root);
    }
  }

  itUnless(sandboxed)(
    'deletes and writes the audit log after freeing space',
    () =>
      fullProject(async ({ root, env, report, modules }) => {
        const auditDir = join(root, 'audit');
        const audit = await withFullDisk(
          auditDir,
          () => existsSync(modules),
          () => clean(report, { env, tier: 'safe', auditDir })
        );
        expect(existsSync(modules)).toBe(false);
        expect(audit.entries[0].status).toBe('removed');
        expect(audit.auditError).toBe(undefined);
        expect(existsSync(audit.file)).toBe(true);
      })
  );

  itUnless(sandboxed)('deletes and says so when the log never fits', () =>
    fullProject(async ({ root, env, report, modules }) => {
      const auditDir = join(root, 'audit');
      const audit = await withFullDisk(
        auditDir,
        () => true,
        () => clean(report, { env, tier: 'safe', auditDir })
      );
      expect(existsSync(modules)).toBe(false);
      expect(audit.freedBytes > 0).toBe(true);
      expect(formatAudit(audit)).toMatch(
        /Audit log: not written \(ENOSPC: no space left on device\)/
      );
    })
  );
});
