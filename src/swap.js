/** Swap is a capacity diagnostic, never a deletion candidate. */
import { parseSize } from './units.js';

export function parseSwapUsage(text) {
  const match =
    /total\s*=\s*([\d.]+[KMGT]?B?)\s+used\s*=\s*([\d.]+[KMGT]?B?)\s+free\s*=\s*([\d.]+[KMGT]?B?)/i.exec(
      text
    );
  return match
    ? {
        total: parseSize(match[1]),
        used: parseSize(match[2]),
        free: parseSize(match[3]),
      }
    : null;
}

export function parseMemoryHolders(text) {
  return text
    .split('\n')
    .map((line) =>
      /^\s*(\d+)\s+(.+?)\s+([\d.]+[KMGT]?B?[+-]?)\s+([\d.]+[KMGT]?B?[+-]?)\s*$/i.exec(
        line
      )
    )
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      command: match[2],
      memoryBytes: parseSize(match[3].replace(/[+-]$/, '')),
      compressedBytes: parseSize(match[4].replace(/[+-]$/, '')),
    }))
    .sort((a, b) => b.memoryBytes - a.memoryBytes)
    .slice(0, 10);
}

export async function readSwap(env) {
  if (env.kind !== 'host' || env.platform !== 'darwin') {
    return null;
  }
  try {
    const usage = await env.run(['sysctl', 'vm.swapusage']);
    const swap = usage.code === 0 ? parseSwapUsage(usage.stdout) : null;
    if (!swap) {
      return null;
    }
    const top = await env.run([
      'top',
      '-l',
      '1',
      '-o',
      'mem',
      '-n',
      '10',
      '-stats',
      'pid,command,mem,cmprs',
    ]);
    return {
      ...swap,
      holders: top.code === 0 ? parseMemoryHolders(top.stdout) : [],
      attribution:
        'Largest resident/compressed memory consumers; macOS does not expose per-process swap ownership here.',
      advice:
        'If Docker Desktop is consuming memory, restart it after saving running work or lower its VM memory limit. Swap files are managed by macOS; dss never deletes them.',
    };
  } catch {
    return null;
  }
}
