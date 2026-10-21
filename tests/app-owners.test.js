/**
 * Per-app Library folders stay while a process of their owning app runs,
 * even when no rule lists that app's process name.
 */

import { describe, it, expect } from 'test-anywhere';
import path from 'node:path';

import {
  bundleRoots,
  ownerBundleId,
  ownsFolder,
  parseBundleIdentifier,
} from '../src/app-owners.js';
import { LivenessProbe } from '../src/liveness.js';

const LIB = '/Users/me/Library';

describe('app owners', () => {
  it('names the bundle identifier owning a per-app folder', () => {
    expect(ownerBundleId(`${LIB}/Caches/com.apple.Music/WebKit`)).toBe(
      'com.apple.Music'
    );
    expect(
      ownerBundleId(
        `${LIB}/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore`
      )
    ).toBe('ru.keepcoder.Telegram');
    expect(
      ownerBundleId(`${LIB}/Saved Application State/us.zoom.xos.savedState`)
    ).toBe('us.zoom.xos');
    expect(ownerBundleId(`${LIB}/Caches/Google/Chrome/Default/Cache`)).toBe(
      null
    );
    expect(ownerBundleId('/work/app/node_modules')).toBe(null);
  });

  it('finds every bundle an executable runs from', () => {
    expect(
      bundleRoots(
        '/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper'
      )
    ).toEqual([
      '/Applications/Google Chrome.app',
      '/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper.app',
    ]);
    expect(bundleRoots('/usr/bin/node')).toEqual([]);
    expect(bundleRoots(undefined)).toEqual([]);
  });

  it('reads the identifier of an XML property list', () => {
    expect(
      parseBundleIdentifier(
        '<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>com.apple.Music</string>\n</dict>'
      )
    ).toBe('com.apple.Music');
    expect(parseBundleIdentifier('<dict></dict>')).toBe(null);
  });

  it('matches helpers and updaters of the owner, not lookalikes', () => {
    expect(ownsFolder('com.google.Chrome.helper', 'com.google.Chrome')).toBe(
      true
    );
    expect(
      ownsFolder(
        'com.anthropic.claudefordesktop',
        'com.anthropic.claudefordesktop.ShipIt'
      )
    ).toBe(true);
    expect(ownsFolder('com.openai.codex', 'com.openai.chat')).toBe(false);
    expect(ownsFolder('com.apple.Music', 'com.apple.MusicKit')).toBe(false);
  });
});

describe('LivenessProbe app owners', () => {
  async function probe(processes, ids) {
    const env = {
      path: path.posix,
      processes: () => Promise.resolve(processes),
      openPaths: () => Promise.resolve(new Set()),
      bundleIdentifier: (bundle) =>
        bundle === '/Broken.app'
          ? Promise.reject(new Error('unreadable'))
          : Promise.resolve(ids[bundle] ?? null),
    };
    const live = new LivenessProbe(env, { staleAgeMs: 3600e3 });
    await live.refresh();
    return live;
  }

  const cache = (owner) => ({
    paths: [`${LIB}/Caches/${owner}/WebKit`],
    checks: { busy: ['Safari'], mtime: false },
  });

  it('keeps the WebKit cache of a running app the rule does not name', async () => {
    const live = await probe(
      [
        {
          pid: 31,
          name: 'Music',
          executable: '/System/Applications/Music.app/Contents/MacOS/Music',
        },
      ],
      { '/System/Applications/Music.app': 'com.apple.Music' }
    );
    expect(live.busyReason(cache('com.apple.Music'))).toBe(
      'Music is running (pid 31) and owns com.apple.Music'
    );
    expect(live.busyReason(cache('com.openai.chat'))).toBe(null);
  });

  it('falls back to the bundle name when the identifier is unreadable', async () => {
    const live = await probe(
      [
        {
          pid: 5,
          name: 'Telegram',
          executable: '/Applications/Telegram.app/Contents/MacOS/Telegram',
        },
        { pid: 6, name: 'Broken', executable: '/Broken.app/Contents/MacOS/x' },
      ],
      {}
    );
    expect(
      live.busyReason({
        paths: [
          `${LIB}/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore`,
        ],
        checks: { mtime: false },
      })
    ).toBe('Telegram is running (pid 5) and owns ru.keepcoder.Telegram');
  });
});
