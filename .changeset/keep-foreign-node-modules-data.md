---
'disk-space-saviour': patch
---

Keep a `node_modules` folder that holds data no package manager installs, naming each such entry and its size, at scan time and right before deletion.

Let `clean` and `emergency` delete on a full disk: an audit log that does not fit is reported as not written and written as soon as deletions free space.
