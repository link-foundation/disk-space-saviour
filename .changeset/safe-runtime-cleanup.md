---
'disk-space-saviour': minor
---

Treat every regenerable project directory as `safe` regardless of how recently
the project was used, and block it only while something uses it. Detect
processes that keep a directory on their `PATH`, stop a long-running Bun script
or Codex daemon from blocking caches they do not use, prune old Codex daemon
releases, resolve partial nvm pins to the newest matching install, keep Node.js
versions that hold user-installed global packages, inspect Git safety in linked
worktrees and submodules, and report per-phase scan timings.
