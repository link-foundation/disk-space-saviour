---
'disk-space-saviour': patch
---

Writable-layer cleanup audit is hard-link aware: the authoritative upperdir before/after measurement lists device/inode identities and credits as freed only blocks whose every link is inside the deletion set. Blocks retained by an outside hard link are no longer reported as physically freed; measured results are marked `freedAccounting: 'hardlink-aware-measurement'` and bare path deltas `'path-delta'`.
