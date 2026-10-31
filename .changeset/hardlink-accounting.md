---
'disk-space-saviour': minor
---

Hard-link aware sizes: items report physically reclaimable bytes, with `allocatedBytes` and `sharedBytes` when links outside the item keep blocks allocated. Each inode is counted once across a selected deletion set, and the audit records `sharedBytes` and marks link-aware estimated `freedBytes`.
