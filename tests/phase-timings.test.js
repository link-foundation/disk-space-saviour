/**
 * Phase timings are recorded on every scan and cleanup, so slow phases show
 * up in reports and audit logs without debug flags.
 */

import { describe, it, expect } from 'test-anywhere';

import { PROJECT_RULES } from '../src/rules/ecosystems.js';
import { clean } from '../src/clean.js';
import { formatAudit, formatReport } from '../src/report.js';
import { scan } from '../src/scan.js';
import { PhaseTimer } from '../src/timings.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  projectFixture,
  removeRoot,
  scanInput,
  tempRoot,
} from './helpers/fixtures.js';

const NODE_MODULES = PROJECT_RULES.find((rule) => rule.id === 'node-modules');

describe('PhaseTimer', () => {
  it('sums repeated phases and lists the slowest first', async () => {
    const timer = new PhaseTimer();
    timer.record('fast', 1);
    timer.record('slow', 30);
    timer.record('fast', 2);
    expect(timer.toJSON()).toEqual([
      { phase: 'slow', ms: 30, count: 1 },
      { phase: 'fast', ms: 3, count: 2 },
    ]);
  });

  it('records a phase that throws, such as an exceeded scan budget', async () => {
    const timer = new PhaseTimer();
    let error = null;
    try {
      await timer.measure('aborted', () => Promise.reject(new Error('budget')));
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toBe('budget');
    expect(timer.toJSON().map((phase) => phase.phase)).toEqual(['aborted']);
  });
});

describe('scan timings', () => {
  it('reports per-environment phases in JSON and in the text report', async () => {
    const root = tempRoot('dss-timings-');
    try {
      projectFixture(root, NODE_MODULES);
      age(root, 40 * DAY_MS);
      const report = await scan(
        scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
      );
      const phases = report.environments[0].timings.map((p) => p.phase);
      for (const phase of [
        'context',
        'scanner:projects',
        'projects:walk',
        'projects:measure',
      ]) {
        expect(phases).toContain(phase);
      }
      expect(formatReport(report)).toContain('slowest phases: ');

      const audit = await clean(report, { dryRun: true, audit: false });
      expect(audit.timings.toJSON().map((p) => p.phase)).toContain('recheck');
      const reloaded = JSON.parse(JSON.stringify(audit));
      expect(reloaded.timings.map((p) => p.phase)).toContain('revalidate');
      expect(formatAudit(reloaded)).toContain('slowest phases: ');
    } finally {
      removeRoot(root);
    }
  });
});
