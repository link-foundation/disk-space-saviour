---
'disk-space-saviour': minor
---

Recursive container scans honor requested roots: `--container-root PATH` (`containerRoots`) sets project roots inside every scanned container at any Docker depth, and host roots that exist inside a container join its defaults. The same roots reach the traversal policy and project discovery. Every environment now reports its effective `scope` (roots with source and status, max depth, exclusions, pruned mounts) and the text report names requested roots that were absent, inaccessible, pruned, excluded or not searched.
