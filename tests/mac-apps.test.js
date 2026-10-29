import { describe, it, expect } from 'test-anywhere';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appIdentity, leftoverCategory } from '../src/mac-apps.js';

async function rejection(fn) {
  try {
    await fn();
    return '';
  } catch (error) {
    return error.message;
  }
}

describe('explicit app removal safety', () => {
  it('requires an app inside a permitted application directory', async () => {
    expect(
      await rejection(() => appIdentity('/System/Applications/Notes.app'))
    ).toMatch(/explicit/);
    expect(
      await rejection(() => appIdentity('/Applications/../Library/Data.app'))
    ).toMatch(/explicit/);
    expect(await rejection(() => appIdentity('/Applications'))).toMatch(
      /explicit/
    );
  });

  it('refuses symbolic links to apps or their parents', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-app-test-'));
    try {
      await fs.mkdir(path.join(home, 'Applications'));
      await fs.mkdir(path.join(home, 'elsewhere.app'));
      await fs.symlink(
        path.join(home, 'elsewhere.app'),
        path.join(home, 'Applications', 'Alias.app'),
        'dir'
      );
      expect(
        await rejection(() =>
          appIdentity(path.join(home, 'Applications', 'Alias.app'), home)
        )
      ).toMatch(/Symlinked/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('requires a user decision for databases, settings and shared containers', () => {
    for (const kind of [
      'Application Support',
      'Preferences',
      'Containers',
      'Group Containers',
      'Saved Application State',
    ]) {
      expect(leftoverCategory(kind)).toBe('user-decision');
    }
    expect(leftoverCategory('Caches')).toBe('disposable-after-activity-check');
    expect(leftoverCategory('Logs')).toBe('disposable-after-activity-check');
  });
});
