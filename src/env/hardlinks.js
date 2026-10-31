/**
 * Hard-link aware accounting of reclaimable blocks.
 *
 * `du` (and every per-path walk) counts each inode once per measured path,
 * including inodes that also have links outside that path. Deleting such a
 * path removes a directory entry but releases no file blocks while another
 * link remains. A file's blocks are reclaimable only when every one of its
 * links is inside the selected deletion set; several links that are all
 * inside the set are reclaimable once.
 *
 * Usage objects carry:
 * - `allocatedBytes`: blocks reachable from the path (what `du` prints);
 * - `sharedBytes`: blocks of multi-link files with a link outside the path;
 * - `bytes`: `allocatedBytes - sharedBytes`, the physically reclaimable part;
 * - `links`: the multi-link non-directory entries below the path
 *   (`{path, id, nlink, bytes}`), used to account a whole selection.
 */

/** POSIX shell fragment listing multi-link files below "$t" (GNU/busybox or BSD stat). */
export const LINKS_SCRIPT = `if stat -c %h / >/dev/null 2>&1; then
  find "$t" -xdev ! -type d -links +1 -exec stat -c '%d:%i %h %b %B %n' -- {} + 2>/dev/null
else
  find "$t" -xdev ! -type d -links +1 -exec stat -f '%d:%i %l %b 512 %N' {} + 2>/dev/null
fi`;

/** Parses LINKS_SCRIPT output lines (`dev:ino nlink blocks blocksize path`). */
export function parseLinks(text) {
  const links = [];
  for (const line of (text ?? '').split('\n')) {
    const match = /^(\d+:\d+) (\d+) (\d+) (\d+) (.+)$/.exec(line);
    if (match) {
      links.push({
        id: match[1],
        nlink: Number(match[2]),
        bytes: Number(match[3]) * Number(match[4]),
        path: match[5],
      });
    }
  }
  return links;
}

function groupLinks(groups) {
  const inodes = new Map();
  for (const [target, links] of groups) {
    for (const link of links ?? []) {
      if (!inodes.has(link.id)) {
        inodes.set(link.id, {
          nlink: link.nlink,
          bytes: link.bytes,
          paths: new Set(),
          targets: new Set(),
        });
      }
      const inode = inodes.get(link.id);
      inode.nlink = Math.max(inode.nlink, link.nlink);
      inode.paths.add(link.path);
      inode.targets.add(target);
    }
  }
  return inodes;
}

/**
 * Accounts a deletion set measured per path.
 * @param {Array<[string, {allocated: number, links?: object[]}]>} measured
 *   one entry per selected path: its per-path allocated bytes (each inode
 *   counted once within that path) and its multi-link entries
 * @returns {{allocatedBytes: number, sharedBytes: number, bytes: number}}
 *   blocks reachable from the set (each inode once), blocks retained by
 *   links outside the set, and the physically reclaimable remainder
 */
export function accountLinks(measured) {
  let allocated = measured.reduce((sum, [, entry]) => sum + entry.allocated, 0);
  let shared = 0;
  const inodes = groupLinks(
    measured.map(([target, entry]) => [target, entry.links])
  );
  for (const inode of inodes.values()) {
    // Per-path walks counted this inode once in every path containing it.
    allocated -= (inode.targets.size - 1) * inode.bytes;
    if (inode.paths.size < inode.nlink) {
      shared += inode.bytes;
    }
  }
  allocated = Math.max(0, allocated);
  shared = Math.min(shared, allocated);
  return {
    allocatedBytes: allocated,
    sharedBytes: shared,
    bytes: allocated - shared,
  };
}

/** Adds allocated/shared/reclaimable fields to one path's usage. */
export function withLinkAccounting(usage, links) {
  if (!usage) {
    return usage;
  }
  const allocated = usage.allocatedBytes ?? usage.bytes;
  const accounted = accountLinks([['', { allocated, links }]]);
  return {
    ...usage,
    bytes: accounted.bytes,
    allocatedBytes: accounted.allocatedBytes,
    sharedBytes: accounted.sharedBytes,
    ...(links?.length ? { links } : {}),
  };
}

/**
 * Reclaimable bytes of several selected paths of one environment, from
 * their usages. Links between selected paths are reclaimable; links
 * outside the selection are not.
 */
export function selectionBytes(usages, selected) {
  const measured = selected
    .map((target) => [target, usages.get(target)])
    .filter(([, usage]) => usage)
    .map(([target, usage]) => [
      target,
      {
        allocated: usage.allocatedBytes ?? usage.bytes,
        links: usage.links,
      },
    ]);
  return accountLinks(measured);
}

/**
 * Item size fields of the usages of one item's paths: `bytes` is the
 * reclaimable total; `allocatedBytes`/`sharedBytes` are added only when
 * hard links outside the item retain blocks.
 */
export function itemSize(entries) {
  const usages = new Map(entries.filter(([, usage]) => usage));
  const accounted = selectionBytes(usages, [...usages.keys()]);
  return accounted.sharedBytes > 0 ? accounted : { bytes: accounted.bytes };
}
