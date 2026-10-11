/** Clean completed safe host findings while discovery continues. */
import { clean } from './clean.js';
import { scan } from './scan.js';

export async function cleanDuringScan(options) {
  const entries = [];
  const health = [];
  let failure;
  const report = await scan({
    ...options,
    onScanPhase: async (phase) => {
      try {
        const audit = await clean(phase, {
          ...options,
          tier: 'safe',
          priorEntries: entries,
          priorHealth: health,
        });
        entries.splice(0, entries.length, ...audit.entries);
        health.splice(0, health.length, ...audit.health);
      } catch (error) {
        failure = error;
        return false;
      }
    },
  });
  if (failure) {
    throw failure;
  }
  if (report.aborted) {
    return { report, audit: null };
  }
  const audit = await clean(report, {
    ...options,
    priorEntries: entries,
    priorHealth: health,
  });
  return { report, audit };
}
