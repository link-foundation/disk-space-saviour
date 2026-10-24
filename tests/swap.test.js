/**
 * Swap growth warnings name the processes holding the memory, using the
 * swap history of earlier scans.
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HISTORY_WINDOW_MS,
  parseMeminfo,
  parseProcStatus,
  readSwap,
  swapWarnings,
  withGrowth,
} from '../src/swap.js';
import { formatReport } from '../src/report.js';
import { readOnlyRuntime, removeRoot, tempRoot } from './helpers/fixtures.js';
import { itUnless } from './helpers/skip.js';

const GIB = 1024 ** 3;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-18T18:00:00Z');

function darwinEnv(usedGib, holders) {
  return {
    kind: 'host',
    platform: 'darwin',
    run: async (argv) => ({
      code: 0,
      stdout:
        argv[0] === 'sysctl'
          ? `vm.swapusage: total = 16384.00M used = ${usedGib * 1024}.00M free = 0.00M (encrypted)`
          : `PID COMMAND MEM CMPRS\n${holders.join('\n')}\n`,
    }),
  };
}

describe('swap warnings', () => {
  it('reports growth since the oldest sample and names growing holders', () => {
    const swap = withGrowth(
      {
        total: 16 * GIB,
        used: 15 * GIB,
        free: GIB,
        holders: [
          { pid: 7, command: 'codex', memoryBytes: 7 * GIB },
          { pid: 0, command: 'kernel_task', memoryBytes: 4 * GIB },
          { pid: 9, command: 'browser', memoryBytes: GIB / 2 },
        ],
      },
      [
        {
          time: NOW - 3 * HOUR,
          used: 8 * GIB,
          holders: [{ pid: 7, command: 'codex', memoryBytes: 3 * GIB }],
        },
        {
          time: NOW - HOUR,
          used: 12 * GIB,
          holders: [{ pid: 9, command: 'browser', memoryBytes: GIB }],
        },
      ]
    );
    expect(swap.growth).toEqual({ since: NOW - 3 * HOUR, usedBytes: 7 * GIB });
    expect(swap.holders[0].growth.memoryBytes).toBe(4 * GIB);
    expect(swap.holders[2].growth.memoryBytes).toBe(-GIB / 2);
    const warnings = swapWarnings(swap, { free: 10 * GIB });
    expect(warnings[0]).toMatch(/^Swap grew by 7\.0 GiB since .*; is 94% full/);
    expect(warnings[0]).toMatch(/only 10\.0 GiB of free disk/);
    expect(warnings[1]).toMatch(/codex \(pid 7\): 7\.0 GiB, \+4\.0 GiB since/);
    expect(warnings[1]).not.toMatch(/kernel_task|browser/);
    expect(warnings[2]).toMatch(/codex resume <session-id>/);
  });

  it('stays quiet when swap is small and stable', () => {
    const swap = withGrowth(
      {
        total: 16 * GIB,
        used: 2 * GIB,
        free: 14 * GIB,
        holders: [{ pid: 7, command: 'codex', memoryBytes: 3 * GIB }],
      },
      [{ time: NOW - HOUR, used: 2 * GIB, holders: [] }]
    );
    expect(swapWarnings(swap, { free: 100 * GIB })).toEqual([]);
  });

  it('reads Linux swap and per-process VmSwap', () => {
    expect(
      parseMeminfo('MemTotal: 100 kB\nSwapTotal: 2048 kB\nSwapFree: 512 kB\n')
    ).toEqual({ total: 2048 * 1024, used: 1536 * 1024, free: 512 * 1024 });
    expect(parseMeminfo('SwapTotal: 0 kB\nSwapFree: 0 kB\n')).toBe(null);
    expect(
      parseProcStatus(
        'Name:\tnode\nPid:\t42\nVmRSS:\t   1024 kB\nVmSwap:\t   2048 kB\n'
      )
    ).toEqual({
      pid: 42,
      command: 'node',
      memoryBytes: 3072 * 1024,
      swappedBytes: 2048 * 1024,
    });
  });
});

describe('swap history', () => {
  itUnless(readOnlyRuntime())(
    'records history between scans and renders the warning',
    async () => {
      const root = tempRoot();
      try {
        const stateDir = join(root, 'state');
        const first = await readSwap(
          darwinEnv(6, ['7 codex 3G 3G', '8 Finder 100M 0B']),
          { stateDir, now: NOW - 2 * HOUR, disk: { free: 50 * GIB } }
        );
        expect(first.growth).toBe(null);
        expect(first.warnings).toEqual([]);
        const second = await readSwap(
          darwinEnv(14, ['7 codex 9G 9G', '8 Finder 100M 0B']),
          { stateDir, now: NOW, disk: { free: 50 * GIB } }
        );
        expect(second.growth.usedBytes).toBe(8 * GIB);
        expect(second.holders[0].growth.memoryBytes).toBe(6 * GIB);
        const history = JSON.parse(
          readFileSync(join(stateDir, 'swap-history.json'), 'utf8')
        );
        expect(history.samples.length).toBe(2);
        const text = formatReport({
          durationMs: 1,
          environments: [{ label: 'host', swap: second }],
          items: [],
          errors: [],
          totals: Object.fromEntries(
            ['safe', 'moderate', 'aggressive', 'blocked'].map((tier) => [
              tier,
              { bytes: 0 },
            ])
          ),
        });
        expect(text).toMatch(/WARNING: Swap grew by 8\.0 GiB/);
        expect(text).toMatch(
          /7 codex: 9\.0 GiB memory, 9\.0 GiB compressed, \+6\.0 GiB since/
        );
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(readOnlyRuntime())(
    'lists this dss run without asking to quit it',
    async () => {
      const root = tempRoot();
      try {
        const swap = await readSwap(
          darwinEnv(14, [`${process.pid} node 4G 4G`, '7 codex 3G 3G']),
          { stateDir: join(root, 'state'), now: NOW, disk: { free: 1 * GIB } }
        );
        expect(swap.holders.map((holder) => Boolean(holder.self))).toEqual([
          true,
          false,
        ]);
        expect(swap.warnings[1]).toMatch(/^Memory held by: codex \(pid 7\)/);
        expect(swap.warnings.join('\n')).not.toContain(`pid ${process.pid}`);
        const text = formatReport({
          durationMs: 1,
          environments: [{ label: 'host', swap }],
          items: [],
          errors: [],
          totals: Object.fromEntries(
            ['safe', 'moderate', 'aggressive', 'blocked'].map((tier) => [
              tier,
              { bytes: 0 },
            ])
          ),
        });
        expect(text).toContain(`${process.pid} node (this dss run): 4.0 GiB`);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(readOnlyRuntime())(
    'forgets samples older than a week and reads Linux /proc',
    async () => {
      const root = tempRoot();
      try {
        const stateDir = join(root, 'state');
        mkdirSync(stateDir);
        writeFileSync(
          join(stateDir, 'swap-history.json'),
          JSON.stringify({
            schema: 1,
            samples: [
              { time: NOW - HISTORY_WINDOW_MS - HOUR, used: 0, holders: [] },
            ],
          })
        );
        const proc = join(root, 'proc');
        mkdirSync(join(proc, '42'), { recursive: true });
        writeFileSync(
          join(proc, 'meminfo'),
          `SwapTotal: ${4 * 1024 * 1024} kB\nSwapFree: ${1024 * 1024} kB\n`
        );
        writeFileSync(
          join(proc, '42', 'status'),
          `Name:\tclaude\nPid:\t42\nVmRSS:\t1024 kB\nVmSwap:\t${2.5 * 1024 * 1024} kB\n`
        );
        const swap = await readSwap(
          { kind: 'host', platform: 'linux' },
          { stateDir, now: NOW, procRoot: proc, disk: { free: 100 * GIB } }
        );
        expect(swap.growth).toBe(null);
        expect([swap.holders[0].pid, swap.holders[0].command]).toEqual([
          42,
          'claude',
        ]);
        expect(swap.warnings[0]).toMatch(/is 75% full/);
        expect(swap.warnings[1]).toMatch(/claude \(pid 42\)/);
        expect(swap.warnings[2]).toMatch(/claude --resume/);
      } finally {
        removeRoot(root);
      }
    }
  );
});
