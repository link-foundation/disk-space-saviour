/**
 * Swap is a capacity diagnostic, never a deletion candidate. Swap files
 * live on the system disk, so memory a process keeps but never touches
 * turns into used disk space. Each scan records swap usage and the largest
 * memory holders in the state directory; the next scan reports how much
 * both grew since the oldest sample of the last week.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AGENT_NAMES } from './health.js';
import { formatBytes, parseSize } from './units.js';

const GIB = 1024 ** 3;
export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 200;
const HOLDER_LIMIT = 10;
/** Growth below this is noise from normal paging. */
const GROWTH_WARNING_BYTES = GIB;
/** A single process holding this much is worth naming in a warning. */
const LARGE_HOLDER_BYTES = 2 * GIB;

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
    .slice(0, HOLDER_LIMIT);
}

/** Swap totals from `/proc/meminfo`, or null. */
export function parseMeminfo(text) {
  const field = (name) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = field('SwapTotal');
  const free = field('SwapFree');
  return total === null || free === null || total === 0
    ? null
    : { total, used: total - free, free };
}

/** Name, PID, resident and swapped bytes from a `/proc/<pid>/status`. */
export function parseProcStatus(text) {
  const value = (name) => new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(text)?.[1];
  const kib = (name) => Number(/^(\d+)/.exec(value(name) ?? '')?.[1] ?? 0);
  const pid = Number(value('Pid'));
  if (!Number.isInteger(pid)) {
    return null;
  }
  const residentBytes = kib('VmRSS') * 1024;
  const swappedBytes = kib('VmSwap') * 1024;
  return {
    pid,
    command: value('Name')?.trim() ?? '',
    memoryBytes: residentBytes + swappedBytes,
    swappedBytes,
  };
}

async function linuxHolders(procRoot) {
  const pids = (await fsp.readdir(procRoot)).filter((name) =>
    /^\d+$/.test(name)
  );
  const holders = await Promise.all(
    pids.map((pid) =>
      fsp
        .readFile(path.join(procRoot, pid, 'status'), 'utf8')
        .then(parseProcStatus, () => null)
    )
  );
  return holders
    .filter((holder) => holder && holder.memoryBytes > 0)
    .sort(
      (a, b) => b.swappedBytes - a.swappedBytes || b.memoryBytes - a.memoryBytes
    )
    .slice(0, HOLDER_LIMIT);
}

async function readDarwin(env) {
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
    String(HOLDER_LIMIT),
    '-stats',
    'pid,command,mem,cmprs',
  ]);
  return {
    ...swap,
    holders: top.code === 0 ? parseMemoryHolders(top.stdout) : [],
    attribution:
      'Largest memory consumers (memory includes compressed and swapped pages); macOS does not expose per-process swap ownership here.',
    advice:
      'If Docker Desktop is consuming memory, restart it after saving running work or lower its VM memory limit. Swap files are managed by macOS; dss never deletes them.',
  };
}

async function readLinux(procRoot) {
  const swap = parseMeminfo(
    await fsp.readFile(path.join(procRoot, 'meminfo'), 'utf8')
  );
  if (!swap) {
    return null;
  }
  return {
    ...swap,
    holders: await linuxHolders(procRoot),
    attribution:
      'Processes with the most swapped memory (VmSwap in /proc/<pid>/status), then the most resident memory.',
    advice:
      'Swap is managed by the kernel; dss never deletes swap files or partitions.',
  };
}

const holderKey = (holder) => `${holder.pid}\0${holder.command}`;

/** Samples of the last week, oldest first; missing state is empty. */
export async function loadSwapHistory(stateDir, now) {
  if (!stateDir) {
    return [];
  }
  try {
    const data = JSON.parse(
      await fsp.readFile(path.join(stateDir, 'swap-history.json'), 'utf8')
    );
    return (Array.isArray(data.samples) ? data.samples : []).filter(
      (sample) =>
        Number.isFinite(sample?.time) &&
        sample.time <= now &&
        now - sample.time <= HISTORY_WINDOW_MS
    );
  } catch {
    return [];
  }
}

async function saveSwapHistory(stateDir, samples) {
  if (!stateDir) {
    return;
  }
  try {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, 'swap-history.json');
    const temporary = `${file}.${process.pid}`;
    await fsp.writeFile(
      temporary,
      JSON.stringify({ schema: 1, samples: samples.slice(-HISTORY_LIMIT) }),
      { mode: 0o600 }
    );
    await fsp.rename(temporary, file);
  } catch {
    // History only adds growth figures; a read-only state dir loses them.
  }
}

/**
 * Adds swap and per-holder growth since the oldest sample of `history`.
 * A holder's baseline is the oldest sample that lists the same PID and
 * command, so a restarted process starts over.
 */
export function withGrowth(swap, history) {
  const baseline = history[0];
  const firstSeen = new Map();
  for (const sample of history) {
    for (const holder of sample.holders ?? []) {
      if (!firstSeen.has(holderKey(holder))) {
        firstSeen.set(holderKey(holder), { time: sample.time, ...holder });
      }
    }
  }
  return {
    ...swap,
    growth: baseline
      ? { since: baseline.time, usedBytes: swap.used - baseline.used }
      : null,
    holders: swap.holders.map((holder) => {
      const first = firstSeen.get(holderKey(holder));
      return first
        ? {
            ...holder,
            growth: {
              since: first.time,
              memoryBytes: holder.memoryBytes - first.memoryBytes,
            },
          }
        : holder;
    }),
  };
}

const isAgent = (holder) =>
  AGENT_NAMES.includes(holder.command.trim().toLowerCase());

function holderSummary(holder) {
  const grew =
    holder.growth?.memoryBytes > 0
      ? `, +${formatBytes(holder.growth.memoryBytes)} since ${new Date(holder.growth.since).toISOString()}`
      : '';
  return `${holder.command} (pid ${holder.pid}): ${formatBytes(holder.memoryBytes)}${grew}`;
}

/**
 * Warnings for swap that is large, growing, or larger than the free disk
 * space it can grow into, naming the processes that hold the memory.
 * @param {object} swap result of `withGrowth`
 * @param {{free: number}|null} disk
 * @returns {string[]}
 */
export function swapWarnings(swap, disk) {
  const reasons = [];
  if (swap.growth && swap.growth.usedBytes >= GROWTH_WARNING_BYTES) {
    reasons.push(
      `grew by ${formatBytes(swap.growth.usedBytes)} since ${new Date(swap.growth.since).toISOString()}`
    );
  }
  if (swap.total > 0 && swap.used >= GIB && swap.used >= 0.75 * swap.total) {
    reasons.push(
      `is ${Math.round((100 * swap.used) / swap.total)}% full, so the system adds swap files on disk when memory demand grows`
    );
  }
  if (disk && swap.used >= GIB && disk.free < swap.used) {
    reasons.push(
      `has only ${formatBytes(disk.free)} of free disk to grow into, less than the ${formatBytes(swap.used)} already used`
    );
  }
  if (reasons.length === 0) {
    return [];
  }
  // The kernel (PID 0) cannot be quit and this dss run ends by itself, so
  // naming either helps nobody.
  const candidates = swap.holders.filter(
    (holder) => holder.pid > 0 && !holder.self
  );
  const growing = candidates.filter(
    (holder) => holder.growth?.memoryBytes >= GROWTH_WARNING_BYTES
  );
  const large = candidates.filter(
    (holder) => holder.memoryBytes >= LARGE_HOLDER_BYTES
  );
  const named = [...new Set([...growing, ...large])].slice(0, 5);
  const warnings = [`Swap ${reasons.join('; ')}.`];
  if (named.length > 0) {
    warnings.push(
      `Memory held by: ${named.map(holderSummary).join('; ')}. Quitting or restarting them frees that swap and its disk space.`
    );
  }
  if (named.some(isAgent)) {
    warnings.push(
      'Long-running AI agent sessions keep their history in memory: quit the session and resume it (for example `codex resume <session-id>` or `claude --resume`) to release it without losing the conversation.'
    );
  }
  return warnings;
}

/**
 * Swap usage, its largest memory holders, growth since earlier scans and
 * warnings; null where swap cannot be read.
 * @param {object} env
 * @param {{stateDir?: string|false, disk?: object|null, now?: number,
 *   procRoot?: string}} [options]
 */
export async function readSwap(env, options = {}) {
  if (env.kind !== 'host') {
    return null;
  }
  const { stateDir, disk = null, now = Date.now() } = options;
  let swap = null;
  try {
    if (env.platform === 'darwin') {
      swap = await readDarwin(env);
    } else if (env.platform === 'linux') {
      swap = await readLinux(options.procRoot ?? '/proc');
    }
  } catch {
    swap = null;
  }
  if (!swap) {
    return null;
  }
  // This dss run shows up among the holders while it scans; it ends on its own.
  swap.holders = swap.holders.map((holder) =>
    holder.pid === process.pid ? { ...holder, self: true } : holder
  );
  const history = await loadSwapHistory(stateDir, now);
  const grown = withGrowth(swap, history);
  await saveSwapHistory(stateDir, [
    ...history,
    {
      time: now,
      used: swap.used,
      total: swap.total,
      holders: swap.holders.map(({ pid, command, memoryBytes }) => ({
        pid,
        command,
        memoryBytes,
      })),
    },
  ]);
  return { ...grown, warnings: swapWarnings(grown, disk) };
}
