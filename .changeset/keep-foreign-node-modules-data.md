---
'disk-space-saviour': patch
---

Keep a `node_modules` folder that holds data no package manager installs, naming each such entry and its size, at scan time and right before deletion.

Let `clean` and `emergency` delete on a full disk: an audit log that does not fit is reported as not written and written as soon as deletions free space.

Keep everything inside a live Claude Code session scratchpad until the session and its transcript stay idle for the inactive window, at scan time and right before deletion.

Show the dss run among swap holders as `(this dss run)` and never name it as a process to quit.

Name what fills a directory of many small entries in `dss usage` by name pattern, with their count and total size.

Offer rotated app logs in `~/Library/Logs`, Crashpad reports left unsent for 30 days and the GitHub CLI run-log cache in the moderate tier.
