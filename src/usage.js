/**
 * Where disk space goes on every path of a volume, beyond the locations
 * rules know.
 *
 * One read-only `du -axk` pass per root streams every file and directory
 * with its allocated size (hard links once, other mounts skipped). Only
 * directories and files above a threshold stay in memory, which is enough
 * for a tree of the largest directories: every ancestor of a large
 * directory is at least as large. Each directory of the tree names what
 * the latest dss scan found inside it, freeable or blocked, so a report
 * separates space dss can reclaim from data it does not consider
 * regenerable. On macOS the APFS volumes (system, VM swap, Preboot,
 * Recovery) and local snapshots complete the picture, since a walk of the
 * Data volume cannot see them.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { clearInterval, setInterval } from 'node:timers';

import { auditDirectory } from './audit.js';
import { hostExecutor } from './exec.js';
import { isWithin } from './paths.js';
import { formatBytes } from './units.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DATA_VOLUME = '/System/Volumes/Data';
const DENIED = /^du: (.+): (Permission denied|Operation not permitted)$/;

/** `{bytes, path}` of one `du -k` line, or null. */
export function parseDuLine(line) {
  const match = /^(\d+)\t(.+)$/.exec(line);
  return match ? { bytes: Number(match[1]) * 1024, path: match[2] } : null;
}

/**
 * Streaming accumulator for `du -a` output. `du` lists a directory after
 * its contents, so an entry is a directory exactly when the line before it
 * lies inside it.
 */
export class UsageCollector {
  /**
   * @param {{minBytes?: number, topFiles?: number}} [options]
   */
  constructor(options = {}) {
    this.minBytes = options.minBytes ?? 64 * MiB;
    this.topFiles = options.topFiles ?? 25;
    this.dirs = new Map();
    this.files = [];
    this.entries = 0;
    this.previous = null;
    this.last = null;
  }

  add(line) {
    const entry = parseDuLine(line);
    if (!entry) {
      return;
    }
    this.entries += 1;
    const prefix = entry.path.endsWith('/') ? entry.path : `${entry.path}/`;
    const isDir = this.previous?.startsWith(prefix) ?? false;
    this.previous = entry.path;
    this.last = entry;
    if (entry.bytes < this.minBytes) {
      return;
    }
    if (isDir) {
      this.dirs.set(entry.path, entry.bytes);
    } else {
      this.files.push(entry);
      if (this.files.length > this.topFiles * 4) {
        this.#trimFiles();
      }
    }
  }

  #trimFiles() {
    this.files.sort((a, b) => b.bytes - a.bytes);
    this.files.length = Math.min(this.files.length, this.topFiles);
  }

  /** The root `du` was given: its line comes last. */
  result(root) {
    this.#trimFiles();
    const total = this.dirs.get(root) ?? this.last?.bytes ?? 0;
    this.dirs.set(root, total);
    return {
      root,
      bytes: total,
      entries: this.entries,
      dirs: this.dirs,
      files: this.files,
    };
  }
}

/**
 * The display form of a walked path: the Data volume is shown through the
 * firmlinked paths users know (`/Users`, `/private/tmp`).
 */
export function displayPath(target, root) {
  if (root === DATA_VOLUME && target.startsWith(DATA_VOLUME)) {
    return target.slice(DATA_VOLUME.length) || '/';
  }
  return target;
}

/** Item paths as macOS resolves them (`/tmp` is `/private/tmp`). */
export function canonicalItemPath(target, platform = process.platform) {
  if (platform !== 'darwin') {
    return target;
  }
  return target.replace(/^\/(tmp|var|etc)(?=\/|$)/, '/private/$1');
}

/**
 * Tree of the largest directories under `root`.
 * @param {Map<string, number>} dirs directory → bytes, closed under parents
 * @param {string} root
 * @param {{minBytes: number, perDir?: number}} options
 */
export function buildTree(dirs, root, options) {
  const children = new Map();
  for (const [dir, bytes] of dirs) {
    if (dir === root || bytes < options.minBytes) {
      continue;
    }
    const parent = path.posix.dirname(dir);
    if (!children.has(parent)) {
      children.set(parent, []);
    }
    children.get(parent).push(dir);
  }
  const perDir = options.perDir ?? 10;
  const node = (dir) => ({
    path: dir,
    bytes: dirs.get(dir),
    children: (children.get(dir) ?? [])
      .sort((a, b) => dirs.get(b) - dirs.get(a))
      .slice(0, perDir)
      .map(node),
  });
  return node(root);
}

/**
 * What the latest scan found inside `target`: bytes dss may free there,
 * bytes blocked, and the rule when `target` lies inside one item.
 */
export function scanCoverage(target, items) {
  const coverage = { freeable: 0, blocked: 0, item: null, shared: null };
  for (const item of items) {
    if (isWithin(target, item.path, path.posix)) {
      coverage.item = item;
    }
    if (isWithin(item.path, target, path.posix)) {
      if (item.sharedWith) {
        coverage.shared ??= { bytes: 0, with: item.sharedWith };
        coverage.shared.bytes += item.apparentBytes;
      } else if (item.blockers.length > 0) {
        coverage.blocked += item.bytes;
      } else {
        coverage.freeable += item.bytes;
      }
    }
  }
  return coverage;
}

/** Host items of a saved scan, outermost only, with canonical paths. */
export function scanItems(
  report,
  platform = process.platform,
  removed = new Set()
) {
  const items = (report?.items ?? [])
    .filter(
      (item) =>
        item.env === 'host' &&
        item.path &&
        !item.parentId &&
        !removed.has(item.path)
    )
    .map((item) => ({
      path: canonicalItemPath(item.path, platform),
      bytes: item.bytes ?? 0,
      rule: item.rule,
      tier: item.tier,
      blockers: item.blockers ?? [],
    }))
    .concat(
      (report?.shared ?? []).map((item) => ({
        path: canonicalItemPath(item.path, platform),
        bytes: 0,
        rule: item.rule,
        blockers: [],
        apparentBytes: item.apparentBytes ?? 0,
        sharedWith: item.sharedWith,
      }))
    );
  return items.filter(
    (item) =>
      !items.some(
        (other) =>
          other !== item &&
          other.path !== item.path &&
          isWithin(item.path, other.path, path.posix)
      )
  );
}

/**
 * APFS volumes from `diskutil apfs list`.
 * @returns {{name: string, mount: string|null, bytes: number}[]}
 */
export function parseApfsVolumes(text) {
  const volumes = [];
  let current = null;
  for (const line of text.split('\n')) {
    const name = /\bName:\s+(.+?)(?: \(Case-(?:in)?sensitive\))?\s*$/.exec(
      line
    );
    if (name && !/Snapshot Name/.test(line)) {
      current = { name: name[1], mount: null, bytes: 0 };
      volumes.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const mount = /^\s*\|?\s*(Snapshot )?Mount Point:\s+(\/.*)$/.exec(line);
    if (mount && !current.mount) {
      current.mount = mount[2].trim();
    }
    const consumed = /Capacity Consumed:\s+(\d+) B/.exec(line);
    if (consumed) {
      current.bytes = Number(consumed[1]);
    }
  }
  return volumes;
}

/** What an APFS volume holds, by its usual role. */
export function volumeRole(volume) {
  const name = volume.name.toLowerCase();
  if (name === 'vm' || volume.mount === '/System/Volumes/VM') {
    return 'swap files and the sleep image, managed by macOS';
  }
  if (name === 'preboot') {
    return 'boot files and the cryptex of the running macOS';
  }
  if (name === 'recovery') {
    return 'macOS Recovery';
  }
  if (name === 'update') {
    return 'staged macOS updates';
  }
  if (volume.mount === '/') {
    return 'macOS system (sealed, read-only)';
  }
  if (volume.mount === DATA_VOLUME) {
    return 'apps and user data (walked below)';
  }
  return volume.mount ? `mounted at ${volume.mount}` : 'not mounted';
}

async function newestSavedReport(options) {
  const dir = auditDirectory(options);
  const names = await fsp.readdir(dir).catch(() => []);
  // Stamps are ISO times with `:` and `.` replaced, so they sort as text.
  const stamp = (name) => /-(\d{4}-\d\d-\d\dT[\d-]+Z)-/.exec(name)?.[1] ?? '';
  const candidates = names
    .filter((name) => /^dss-(scan|clean)-.+\.json$/.test(name))
    .sort((a, b) => stamp(b).localeCompare(stamp(a)));
  for (const name of candidates) {
    const saved = await fsp
      .readFile(path.join(dir, name), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    const report = saved?.report ?? saved;
    if (Array.isArray(report?.items)) {
      return {
        file: path.join(dir, name),
        report,
        removed: removedPaths(saved),
      };
    }
  }
  return null;
}

/** Paths a clean already deleted: its report still lists them. */
function removedPaths(audit) {
  return new Set(
    (audit.entries ?? [])
      .filter((entry) => entry.status === 'removed')
      .flatMap((entry) => entry.paths ?? [entry.path])
      .filter(Boolean)
  );
}

function defaultRoots(platform) {
  return platform === 'darwin' ? [DATA_VOLUME] : ['/'];
}

/**
 * Walks `root` with `du` and streams its output into a collector.
 * @param {object} executor with `spawn(argv, options)`
 */
export function walk(executor, root, options = {}) {
  const collector = new UsageCollector(options);
  const denied = { count: 0, samples: [] };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = executor.spawn(['du', '-a', '-x', '-k', root], {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 6 * 3600e3,
    });
    const timer = setInterval(
      () =>
        options.onProgress?.({
          root,
          elapsedMs: Date.now() - started,
          entries: collector.entries,
          at: collector.previous,
        }),
      5000
    );
    timer.unref?.();
    createInterface({ input: child.stdout }).on('line', (line) =>
      collector.add(line)
    );
    createInterface({ input: child.stderr }).on('line', (line) => {
      const match = DENIED.exec(line);
      if (match) {
        denied.count += 1;
        if (denied.samples.length < 5) {
          denied.samples.push(match[1]);
        }
      }
    });
    child.once('error', (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearInterval(timer);
      if (options.signal?.aborted) {
        reject(new Error('usage walk aborted'));
        return;
      }
      if (signal || collector.entries === 0) {
        reject(new Error(`du ${root} stopped (${signal ?? `exit ${code}`})`));
        return;
      }
      resolve({
        ...collector.result(root),
        denied,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Reports where the space of whole volumes goes. Never deletes anything.
 * @param {{roots?: string[]|null, minSize?: number, executor?: object,
 *   platform?: string, signal?: AbortSignal, onUsageProgress?: Function,
 *   auditDir?: string}} [options]
 */
export async function usage(options = {}) {
  const platform = options.platform ?? process.platform;
  const executor = options.executor ?? hostExecutor();
  const started = Date.now();
  const roots = (
    options.roots?.length ? options.roots : defaultRoots(platform)
  ).map((root) => path.resolve(root));
  const saved = await newestSavedReport(options);
  const items = scanItems(saved?.report, platform, saved?.removed);
  // One walk at a time: parallel walks of one disk only compete for it.
  const walks = await roots.reduce(
    async (done, root) => [
      ...(await done),
      await walk(executor, root, {
        minBytes: Math.min(options.minSize ?? 64 * MiB, 64 * MiB),
        signal: options.signal,
        onProgress: options.onUsageProgress,
      }),
    ],
    Promise.resolve([])
  );
  const volumes =
    platform === 'darwin'
      ? await darwinVolumes(executor, options.signal)
      : { volumes: [], snapshots: null };
  return {
    schema: 1,
    createdAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    platform,
    minSize: options.minSize ?? null,
    scan: saved
      ? { file: saved.file, createdAt: saved.report.createdAt ?? null }
      : null,
    roots: walks.map((result) => rootReport(result, items, options)),
    ...volumes,
  };
}

function rootReport(result, items, options) {
  const minBytes = options.minSize ?? Math.max(result.bytes * 0.01, 100 * MiB);
  const show = (target) => displayPath(target, result.root);
  const dirs = new Map(
    [...result.dirs].map(([dir, bytes]) => [show(dir), bytes])
  );
  const rootPath = show(result.root);
  const annotate = (node) => ({
    ...node,
    dss: summary(scanCoverage(node.path, items)),
    children: node.children.map(annotate),
  });
  const inside = items.filter((item) =>
    isWithin(item.path, rootPath, path.posix)
  );
  return {
    root: result.root,
    path: rootPath,
    bytes: result.bytes,
    entries: result.entries,
    durationMs: result.durationMs,
    denied: {
      count: result.denied.count,
      samples: result.denied.samples.map(show),
    },
    known: {
      freeable: inside
        .filter((item) => item.blockers.length === 0)
        .reduce((sum, item) => sum + item.bytes, 0),
      blocked: inside
        .filter((item) => item.blockers.length > 0)
        .reduce((sum, item) => sum + item.bytes, 0),
      shared: inside.reduce((sum, item) => sum + (item.apparentBytes ?? 0), 0),
    },
    tree: annotate(
      buildTree(dirs, rootPath, {
        minBytes,
        perDir: options.verbose ? 30 : 10,
      })
    ),
    files: result.files.map((file) => ({
      path: show(file.path),
      bytes: file.bytes,
      dss: summary(scanCoverage(show(file.path), items)),
    })),
  };
}

function summary(coverage) {
  return {
    rule: coverage.item?.rule ?? null,
    tier: coverage.item?.tier ?? null,
    blocked: coverage.item ? coverage.item.blockers.length > 0 : null,
    freeable: coverage.freeable,
    blockedBytes: coverage.blocked,
    shared: coverage.shared,
  };
}

async function darwinVolumes(executor, signal) {
  const list = await executor
    .run(['diskutil', 'apfs', 'list'], { timeoutMs: 30000, signal })
    .catch(() => null);
  const snapshots = await executor
    .run(['tmutil', 'listlocalsnapshots', '/'], { timeoutMs: 30000, signal })
    .catch(() => null);
  return {
    volumes: parseApfsVolumes(list?.stdout ?? '').map((volume) => ({
      ...volume,
      role: volumeRole(volume),
    })),
    snapshots: snapshots
      ? snapshots.stdout
          .split('\n')
          .filter((line) => /^com\.apple\./.test(line.trim())).length
      : null,
  };
}

function dssNote(dss) {
  if (dss.shared && !dss.freeable && !dss.blockedBytes) {
    return `  [dss: ${formatBytes(dss.shared.bytes)} are APFS clones sharing their blocks with ${dss.shared.with}; deleting them frees almost nothing]`;
  }
  if (dss.rule) {
    return `  [dss: ${dss.rule}, ${dss.blocked ? 'blocked' : dss.tier}]`;
  }
  const parts = [];
  if (dss.freeable > 0) {
    parts.push(`${formatBytes(dss.freeable)} freeable`);
  }
  if (dss.blockedBytes > 0) {
    parts.push(`${formatBytes(dss.blockedBytes)} blocked`);
  }
  return parts.length > 0 ? `  [dss: ${parts.join(', ')}]` : '';
}

function treeLines(node, depth = 0) {
  // A directory that is almost all one subdirectory says nothing more
  // than that subdirectory: show the deeper path in its place.
  const [only] = node.children;
  if (
    depth > 0 &&
    node.children.length === 1 &&
    only.bytes >= node.bytes * 0.95
  ) {
    return treeLines(only, depth);
  }
  return [
    `${formatBytes(node.bytes).padStart(10)}  ${'  '.repeat(depth)}${node.path}${dssNote(node.dss)}`,
    ...node.children.flatMap((child) => treeLines(child, depth + 1)),
  ];
}

function volumeLines(report, data) {
  if (report.volumes.length === 0) {
    return [];
  }
  const lines = ['', 'VOLUMES (APFS space consumed)'];
  for (const volume of report.volumes) {
    lines.push(
      `${formatBytes(volume.bytes).padStart(10)}  ${volume.name}: ${volume.role}`
    );
  }
  if (report.snapshots !== null) {
    lines.push(
      `            local Time Machine snapshots: ${report.snapshots}${report.snapshots > 0 ? ' (macOS frees them under pressure; `tmutil deletelocalsnapshots /` removes them)' : ''}`
    );
  }
  const volume = report.volumes.find((entry) => entry.mount === DATA_VOLUME);
  if (volume && data) {
    const gap = volume.bytes - data.bytes;
    lines.push(
      gap > GiB
        ? `            ${formatBytes(gap)} of the Data volume is outside the walk: directories this user cannot read, snapshots or files deleted while still open.`
        : gap < -GiB
          ? `            The walk counts APFS clones at full size, so it exceeds the Data volume by ${formatBytes(-gap)}.`
          : '            The walk accounts for the whole Data volume.'
    );
  }
  return lines;
}

/**
 * Renders a usage report.
 * @param {object} report
 * @returns {string}
 */
export function formatUsage(report) {
  const lines = [
    `disk-space-saviour usage in ${(report.durationMs / 1000).toFixed(1)}s (report only, nothing was deleted)`,
  ];
  for (const root of report.roots) {
    lines.push(
      '',
      `WHERE SPACE GOES under ${root.path} (${formatBytes(root.bytes)} in ${root.entries.toLocaleString('en-US')} entries, ${(root.durationMs / 1000).toFixed(0)}s)`,
      ...treeLines(root.tree),
      '',
      'LARGEST FILES',
      ...root.files.map(
        (file) =>
          `${formatBytes(file.bytes).padStart(10)}  ${file.path}${dssNote(file.dss)}`
      )
    );
    if (report.scan) {
      lines.push(
        '',
        `dss rules cover ${formatBytes(root.known.freeable + root.known.blocked)} here: ${formatBytes(root.known.freeable)} freeable now, ${formatBytes(root.known.blocked)} blocked (scan of ${report.scan.createdAt}). The rest is data dss does not treat as regenerable.`
      );
      if (root.known.shared > 0) {
        lines.push(
          `${formatBytes(root.known.shared)} of the walk are APFS clones of installed apps: du counts them in full, but deleting them frees almost nothing.`
        );
      }
    } else {
      lines.push(
        '',
        'Run `dss scan` to mark what dss can free inside these directories.'
      );
    }
    if (root.denied.count > 0) {
      lines.push(
        `Unreadable: ${root.denied.count} directories were skipped, such as ${root.denied.samples.join(', ')}; grant Full Disk Access or run with sudo to include them.`
      );
    }
  }
  const data = report.roots.find((root) => root.root === DATA_VOLUME);
  lines.push(...volumeLines(report, data));
  return lines.join('\n');
}
