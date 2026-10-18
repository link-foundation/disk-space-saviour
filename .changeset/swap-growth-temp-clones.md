---
'disk-space-saviour': minor
---

Warn when swap grows, nearly fills, or outgrows the free disk space, naming the processes holding the memory and how much each grew since earlier scans (with Linux `VmSwap` support), and offer Git clones in temporary directories as safe once every worktree is clean and `git ls-remote` shows the remote still holds every local commit.
