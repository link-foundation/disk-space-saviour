// Preload the original rules to reproduce issues 55 and 56 without changing
// the working tree. Run from the repository root:
// node --import ./experiments/issue-57-original-rules.mjs --test \
//   --test-timeout=30000 tests/upload-and-run-log-caches.test.js
import { OTHER_RULES } from '../src/rules/other.js';
import { DOWNLOAD_RULES } from '../src/rules/downloads.js';

const upload = OTHER_RULES.find(
  (rule) => rule.id === 'sanitized-upload-staging'
);
upload.paths = upload.paths.filter(
  (pattern) => pattern !== '{TMP}/hive-mind-log-upload-*'
);
const logs = DOWNLOAD_RULES.find((rule) => rule.id === 'gh-run-log-cache');
logs.tier = 'moderate';
logs.paths = ['~/.cache/gh/run-log-*.zip'];
delete logs.fileOnly;
delete logs.busy;
