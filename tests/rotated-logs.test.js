/**
 * Apps that rotate their logs in ~/Library/Logs write only the current
 * one; the rotated copies (warp.log.old.2, app.log.1) only grow the disk.
 */

import { describe, it, expect } from 'test-anywhere';
import { join } from 'node:path';

import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

describe('rotated app logs', () => {
  it('offers rotated copies and keeps the current log', async () => {
    const root = tempRoot('dss-rotated-logs-');
    try {
      const logs = join(root, 'home', 'Library', 'Logs');
      writeBlob(join(logs, 'warp.log'));
      writeBlob(join(logs, 'warp.log.old.2'));
      writeBlob(join(logs, 'Tool', 'tool.log.1'));
      age(root, 2 * DAY_MS);
      const env = fixtureEnv(root);
      const report = await scan(
        scanInput(env, [], {
          scanners: ['global'],
          only: ['rotated-app-logs'],
        })
      );
      const items = report.items.filter(
        (item) => item.rule === 'rotated-app-logs'
      );
      expect(items.map((item) => item.path).sort()).toEqual([
        join(logs, 'Tool', 'tool.log.1'),
        join(logs, 'warp.log.old.2'),
      ]);
      expect(items.every((item) => item.tier === 'moderate')).toBe(true);
    } finally {
      removeRoot(root);
    }
  });
});
