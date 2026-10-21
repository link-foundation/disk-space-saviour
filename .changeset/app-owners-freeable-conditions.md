---
'disk-space-saviour': minor
---

Add `dss usage`, which shows where the space of a whole volume goes (largest directories and files, what dss can free or has blocked inside each, APFS volumes, snapshots and unread space), list APFS clones that share their blocks with an installed app under `SHARED WITH INSTALLED APPS`, search Git worktree folders at full depth, keep per-app macOS Library folders while a process of the owning app runs, name the process and app holding a busy path, group blocked space by the condition that frees it in a `WARNING:` line and a `FREEABLE ON CONDITIONS` section, scan again when a process that blocked items has exited, warn when a clean plan rests on an incomplete scan, and collapse access errors inside directories this user cannot enter into one line.
