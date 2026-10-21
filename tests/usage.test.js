/**
 * `dss usage` walks whole volumes with one `du` pass and shows where the
 * space goes, beyond the locations rules know.
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  UsageCollector,
  buildTree,
  canonicalItemPath,
  displayPath,
  formatUsage,
  parseApfsVolumes,
  scanCoverage,
  scanItems,
  usage,
  volumeRole,
} from '../src/usage.js';
import { removeRoot, tempRoot } from './helpers/fixtures.js';
import { itUnless, noPosixShell } from './helpers/skip.js';

const MiB = 1024 * 1024;
const du = (kib, target) => `${kib}\t${target}`;

describe('usage walk', () => {
  it('tells directories from files by the order du lists them', () => {
    const collector = new UsageCollector({ minBytes: MiB, topFiles: 2 });
    for (const line of [
      du(4096, '/r/a/big.bin'),
      du(2048, '/r/a/mid.bin'),
      du(1, '/r/a/small.txt'),
      du(6145, '/r/a'),
      du(3072, '/r/b/c/huge'),
      du(3072, '/r/b/c'),
      du(3072, '/r/b'),
      du(0, '/r/empty'),
      du(9217, '/r'),
      'garbage line',
    ]) {
      collector.add(line);
    }
    const result = collector.result('/r');
    expect(result.bytes).toBe(9217 * 1024);
    expect(result.entries).toBe(9);
    expect([...result.dirs.keys()].sort()).toEqual([
      '/r',
      '/r/a',
      '/r/b',
      '/r/b/c',
    ]);
    expect(result.files.map((file) => file.path)).toEqual([
      '/r/a/big.bin',
      '/r/b/c/huge',
    ]);
  });

  it('builds a tree of directories above the threshold, largest first', () => {
    const dirs = new Map([
      ['/', 100 * MiB],
      ['/Users', 70 * MiB],
      ['/Users/me', 69 * MiB],
      ['/private', 25 * MiB],
      ['/private/tmp', 4 * MiB],
    ]);
    const tree = buildTree(dirs, '/', { minBytes: 10 * MiB });
    expect(tree.children.map((node) => node.path)).toEqual([
      '/Users',
      '/private',
    ]);
    expect(tree.children[0].children.map((node) => node.path)).toEqual([
      '/Users/me',
    ]);
    expect(tree.children[1].children).toEqual([]);
  });

  it('shows the Data volume at its firmlinked paths', () => {
    expect(
      displayPath('/System/Volumes/Data/Users/me', '/System/Volumes/Data')
    ).toBe('/Users/me');
    expect(displayPath('/System/Volumes/Data', '/System/Volumes/Data')).toBe(
      '/'
    );
    expect(displayPath('/home/me', '/')).toBe('/home/me');
    expect(canonicalItemPath('/tmp/x', 'darwin')).toBe('/private/tmp/x');
    expect(canonicalItemPath('/var/folders/a', 'darwin')).toBe(
      '/private/var/folders/a'
    );
    expect(canonicalItemPath('/tmp/x', 'linux')).toBe('/tmp/x');
  });
});

describe('usage annotations', () => {
  const report = {
    items: [
      { env: 'host', path: '/u/.cache/a', bytes: 30, blockers: [], rule: 'a' },
      {
        env: 'host',
        path: '/u/.cache/a/inner',
        bytes: 5,
        blockers: [],
        rule: 'inner',
      },
      {
        env: 'host',
        path: '/u/.cache/b',
        bytes: 20,
        blockers: ['busy: x is running (pid 1)'],
        rule: 'b',
      },
      { env: 'host', path: '/u/gone', bytes: 9, blockers: [], rule: 'g' },
      { env: 'docker:web', path: '/u/.cache/c', bytes: 7, blockers: [] },
    ],
  };
  const items = scanItems(report, 'linux', new Set(['/u/gone']));

  it('keeps outermost host items a clean has not removed', () => {
    expect(items.map((item) => item.rule)).toEqual(['a', 'b']);
  });

  it('sums freeable and blocked space inside a directory', () => {
    expect(scanCoverage('/u', items)).toEqual({
      freeable: 30,
      blocked: 20,
      item: null,
      shared: null,
    });
    expect(scanCoverage('/u/.cache/b/deep', items).item.rule).toBe('b');
  });
});

describe('APFS volumes', () => {
  it('reads consumed space and roles from diskutil apfs list', () => {
    const volumes = parseApfsVolumes(
      [
        '    |   Name:                      Macintosh HD (Case-insensitive)',
        '    |   Mount Point:               Not Mounted',
        '    |   Capacity Consumed:         11270619136 B (11.3 GB)',
        '    |   Snapshot Mount Point:      /',
        '    |   Name:                      Data (Case-insensitive)',
        '    |   Mount Point:               /System/Volumes/Data',
        '    |   Capacity Consumed:         446914449408 B (446.9 GB)',
        '        Name:                      VM (Case-insensitive)',
        '        Mount Point:               /System/Volumes/VM',
        '        Capacity Consumed:         19338035200 B (19.3 GB)',
      ].join('\n')
    );
    expect(volumes).toEqual([
      { name: 'Macintosh HD', mount: '/', bytes: 11270619136 },
      { name: 'Data', mount: '/System/Volumes/Data', bytes: 446914449408 },
      { name: 'VM', mount: '/System/Volumes/VM', bytes: 19338035200 },
    ]);
    expect(volumes.map(volumeRole)).toEqual([
      'macOS system (sealed, read-only)',
      'apps and user data (walked below)',
      'swap files and the sleep image, managed by macOS',
    ]);
  });
});

describe('usage end to end', () => {
  itUnless(noPosixShell)(
    'walks a directory with du and renders the tree and largest files',
    async () => {
      const root = tempRoot('dss-usage-');
      try {
        mkdirSync(path.join(root, 'cache', 'deep'), { recursive: true });
        mkdirSync(path.join(root, 'docs'));
        writeFileSync(
          path.join(root, 'cache', 'deep', 'blob.bin'),
          Buffer.alloc(3 * MiB, 1)
        );
        writeFileSync(path.join(root, 'docs', 'a.txt'), Buffer.alloc(MiB, 1));
        const report = await usage({
          roots: [root],
          minSize: MiB,
          platform: 'linux',
          auditDir: path.join(root, 'no-audit'),
        });
        const [walked] = report.roots;
        expect(walked.bytes >= 4 * MiB).toBe(true);
        expect(walked.files[0].path).toBe(
          path.join(walked.path, 'cache', 'deep', 'blob.bin')
        );
        const text = formatUsage(report);
        expect(text).toMatch(/WHERE SPACE GOES under /);
        expect(text).toMatch(/cache[\\/]deep\n/);
        expect(text).toMatch(/LARGEST FILES/);
        expect(text).toMatch(/Run `dss scan` to mark what dss can free/);
      } finally {
        removeRoot(root);
      }
    }
  );
});
