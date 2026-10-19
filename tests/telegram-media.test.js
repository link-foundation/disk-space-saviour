/**
 * Telegram cleanup removes pure caches and, in the moderate tier, media
 * Telegram downloads again from its cloud; its media database and files
 * the user sent stay.
 */

import { describe, expect } from 'test-anywhere';
import { join } from 'node:path';

import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

describe('Telegram media', () => {
  itUnless(sandboxed)(
    'offers caches and cloud media, never the media database',
    async () => {
      const root = tempRoot('dss-telegram-');
      try {
        const media = join(
          root,
          'home/Library/Group Containers/ABC.ru.keepcoder.Telegram/appstore/account-1/postbox/media'
        );
        for (const name of [
          'cache/part',
          'storage/db/media.sqlite',
          'local-file-123.jpg',
          'telegram-cloud-document-2-55',
        ]) {
          writeBlob(join(media, name), 64 * 1024);
        }
        age(root, 40 * DAY_MS);
        const report = await scan(
          scanInput(fixtureEnv(root), [], {
            scanners: ['global'],
            only: ['telegram-caches', 'telegram-downloaded-media'],
          })
        );
        const found = report.items.map((item) => [
          item.rule,
          item.path.slice(media.length + 1),
          item.tier,
        ]);
        expect(found.sort()).toEqual([
          ['telegram-caches', 'cache', 'safe'],
          [
            'telegram-downloaded-media',
            'telegram-cloud-document-2-55',
            'moderate',
          ],
        ]);
      } finally {
        removeRoot(root);
      }
    }
  );
});
