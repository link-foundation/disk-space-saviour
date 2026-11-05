---
'disk-space-saviour': minor
---

Scans report more of what they find. A `node_modules` without a `package.json` or lockfile now appears as a blocked item instead of vanishing from the report. The default scan budget grows to ten minutes so project search finishes on large disks (`dss emergency` keeps two minutes). Tier headings no longer count nested items twice, and a new `NOTES` section (`notes` in JSON) names the toolchain versions kept and says when Docker could not be inspected.
