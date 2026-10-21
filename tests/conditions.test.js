/**
 * Blocked space is reported by the condition that frees it: quitting an
 * app, a session ending, files closing or the activity window passing.
 */

import { describe, it, expect } from 'test-anywhere';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { blockedConditions, blockerCondition } from '../src/conditions.js';
import { LocalEnv } from '../src/env/local.js';
import { LivenessProbe } from '../src/liveness.js';
import { conditionsSection, conditionsWarning } from '../src/report.js';
import { removeRoot, tempRoot } from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const MiB = 1024 * 1024;
const blocked = (bytes, tier, ...blockers) => ({ bytes, tier, blockers });

describe('blocker conditions', () => {
  it('names what has to stop for each blocker', () => {
    expect(blockerCondition('busy: Telegram is running (pid 5)')).toEqual({
      key: 'quit:Telegram',
      action: 'quit Telegram',
    });
    expect(
      blockerCondition(
        'busy: Music is running (pid 31) and owns com.apple.Music'
      ).action
    ).toBe('quit Music');
    expect(
      blockerCondition('busy: npm is running in /work/app (pid 9)').action
    ).toBe('npm (pid 9) in /work/app exits');
    expect(
      blockerCondition('busy: in use: /a/b (pid 7, Claude Code)').action
    ).toBe('Claude Code (pid 7) exits');
    expect(
      blockerCondition('busy: modified 5m ago, inside the 1h activity window')
        .action
    ).toBe('they stay untouched for the 1h activity window');
    expect(
      blockerCondition('scan incomplete: scan time budget exceeded').action
    ).toBe('a later scan finishes measuring them (scan time budget exceeded)');
    expect(blockerCondition('3 files inside /w tracked by Git')).toBe(null);
  });

  it('groups items by the conditions that free all their blockers', () => {
    const result = blockedConditions([
      blocked(700 * MiB, 'moderate', 'busy: Telegram is running (pid 5)'),
      blocked(20 * MiB, 'safe', 'busy: Telegram is running (pid 5)'),
      blocked(
        230 * MiB,
        'moderate',
        'locked by running Claude Code (pid 8, /locks/2.1.lock)',
        'busy: in use: /versions/2.1 (pid 8, claude)'
      ),
      blocked(64 * MiB, 'safe', 'Playwright in /app still uses webkit-1'),
    ]);
    expect(result.conditions).toEqual([
      {
        action: 'quit Telegram',
        items: 2,
        bytes: 720 * MiB,
        tiers: { moderate: 700 * MiB, safe: 20 * MiB },
      },
      {
        action: 'the Claude Code session (pid 8) ends',
        items: 1,
        bytes: 230 * MiB,
        tiers: { moderate: 230 * MiB },
      },
    ]);
    expect(result.other).toEqual({ items: 1, bytes: 64 * MiB });
  });

  it('warns about conditional space and lists it in the report', () => {
    const totals = blockedConditions([
      blocked(700 * MiB, 'moderate', 'busy: Telegram is running (pid 5)'),
      blocked(64 * MiB, 'safe', 'Playwright in /app still uses webkit-1'),
    ]);
    expect(conditionsWarning(totals)).toBe(
      '700 MiB more frees only once something stops using it: quit Telegram (700 MiB). See FREEABLE ON CONDITIONS.'
    );
    const section = conditionsSection(totals).join('\n');
    expect(section).toMatch(/quit Telegram \(1 item: moderate 700 MiB\)/);
    expect(section).toMatch(/kept for other reasons .*: 1 item/);
    expect(conditionsWarning({ conditions: [] })).toBe(null);
  });
});

describe('who keeps a path busy', () => {
  it('names the process holding a file open and the app it runs from', async () => {
    const env = {
      path: path.posix,
      processes: () =>
        Promise.resolve([
          {
            pid: 1206,
            name: 'stable',
            executable: '/Applications/Warp.app/Contents/MacOS/stable',
          },
        ]),
      openPaths: () => Promise.resolve(new Set(['/cache/warp/update.zip'])),
      openPathPids: new Map([['/cache/warp/update.zip', 1206]]),
      bundleIdentifier: () => Promise.resolve('dev.warp.Warp-Stable'),
    };
    const live = new LivenessProbe(env, { staleAgeMs: 3600e3 });
    await live.refresh();
    expect(
      live.busyReason({ paths: ['/cache/warp'], checks: { mtime: false } })
    ).toBe('in use: /cache/warp/update.zip (pid 1206, Warp (stable))');
    expect(
      live.busyReason({
        paths: ['/elsewhere'],
        checks: { busy: ['stable'], mtime: false },
      })
    ).toBe('Warp (stable) is running (pid 1206)');
  });

  itUnless(sandboxed || process.getuid?.() === 0)(
    'collapses access errors inside directories this user cannot enter',
    async () => {
      const root = tempRoot('dss-foreign-');
      const locked = path.join(root, 'tmp-mount-a');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const env = new LocalEnv({});
        const error = Object.assign(new Error('denied'), { code: 'EACCES' });
        env.recordAccessError(path.join(locked, 'ms-playwright'), error);
        env.recordAccessError(path.join(root, 'Sandbox'), error);
        expect(await env.accessErrorMessages()).toEqual([
          `cannot inspect ${path.join(root, 'Sandbox')}: EACCES`,
          `skipped 1 directory this user cannot enter, such as ${locked}; nothing inside can be deleted without their owner's rights`,
        ]);
      } finally {
        chmodSync(locked, 0o700);
        removeRoot(root);
      }
    }
  );
});
