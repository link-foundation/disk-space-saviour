/**
 * Space that frees when a condition is met: blocked items grouped by what
 * keeps them, so a report says "quit Telegram: 1.9 GiB" in one line for
 * hundreds of busy items. An item frees only when every one of
 * its blockers clears; items kept for reasons no running program explains
 * (Git state, protected installs, unreadable records) are counted apart.
 */

const CONDITIONS = [
  [
    /^(?:busy: )?(.+?) is running in (.+?) \(pid (\d+)\)$/,
    (m) => ({
      key: `exit:${m[3]}`,
      action: `${m[1]} (pid ${m[3]}) in ${m[2]} exits`,
    }),
  ],
  [
    /^(?:busy: )?(.+?) is running \(pid \d+(?:, working directory unknown)?\)(?: and owns \S+)?$/,
    (m) => ({ key: `quit:${m[1]}`, action: `quit ${m[1]}` }),
  ],
  [
    /^locked by running Claude Code \(pid (\d+)/,
    (m) => ({
      key: `exit:${m[1]}`,
      action: `the Claude Code session (pid ${m[1]}) ends`,
    }),
  ],
  [
    /^(?:busy: )?on the PATH of (.+?) \(pid (\d+)\)/,
    (m) => ({ key: `exit:${m[2]}`, action: `${m[1]} (pid ${m[2]}) exits` }),
  ],
  [
    /^(?:busy: )?in use: .+ \(pid (\d+)(?:, (.+))?\)$/,
    (m) => ({
      key: `exit:${m[1]}`,
      action: `${m[2] ?? 'process'} (pid ${m[1]}) exits`,
    }),
  ],
  [
    /^(?:busy: )?(?:in use: |every path is in use)/,
    () => ({ key: 'open', action: 'the programs holding the files open exit' }),
  ],
  [
    /^(?:busy: )?modified .+ ago, inside the (.+) activity window$/,
    (m) => ({
      key: 'idle',
      action: `they stay untouched for the ${m[1]} activity window`,
    }),
  ],
  [
    /^scan incomplete: (.+)$/,
    (m) => ({
      key: 'rescan',
      action: `a later scan finishes measuring them (${m[1]})`,
    }),
  ],
  [
    /^bind-mounted by running container (\S+)/,
    (m) => ({ key: `container:${m[1]}`, action: `container ${m[1]} stops` }),
  ],
];

/** What must happen for `blocker` to clear, or null when nothing running explains it. */
export function blockerCondition(blocker) {
  for (const [pattern, condition] of CONDITIONS) {
    const match = pattern.exec(blocker);
    if (match) {
      return condition(match);
    }
  }
  return null;
}

/**
 * Blocked space grouped by the conditions that free it, largest first.
 * @param {object[]} items blocked items, nested ones already dropped
 * @returns {{conditions: object[], other: {items: number, bytes: number}}}
 */
export function blockedConditions(items) {
  const groups = new Map();
  const other = { items: 0, bytes: 0 };
  for (const item of items) {
    const found = item.blockers.map(blockerCondition);
    if (found.length === 0 || found.includes(null)) {
      other.items += 1;
      other.bytes += item.bytes;
      continue;
    }
    // The first blocker names a process most specifically (a Claude Code
    // lock before the files it holds open).
    const unique = found.filter(
      (entry, index) => found.findIndex((e) => e.key === entry.key) === index
    );
    const key = unique
      .map((entry) => entry.key)
      .sort()
      .join('+');
    const group = groups.get(key) ?? {
      action: unique.map((entry) => entry.action).join(' and '),
      items: 0,
      bytes: 0,
      tiers: {},
    };
    group.items += 1;
    group.bytes += item.bytes;
    group.tiers[item.tier] = (group.tiers[item.tier] ?? 0) + item.bytes;
    groups.set(key, group);
  }
  return {
    conditions: [...groups.values()].sort((a, b) => b.bytes - a.bytes),
    other,
  };
}

/**
 * Host processes named by blockers of a saved scan that no longer run, so
 * the items they blocked may be free now and the scan is stale.
 * @param {object} report saved scan
 * @param {(pid: number) => boolean} alive
 * @returns {number[]}
 */
export function exitedBlockerPids(report, alive) {
  const pids = new Set();
  for (const item of report.items ?? []) {
    if (item.env !== 'host') {
      continue;
    }
    for (const blocker of item.blockers ?? []) {
      for (const match of blocker.matchAll(/\(pid (\d+)/g)) {
        pids.add(Number(match[1]));
      }
    }
  }
  return [...pids].filter((pid) => !alive(pid));
}

/** Whether a process with `pid` exists, including other users' processes. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
