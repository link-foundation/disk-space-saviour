# Faster scans and reusable cleanup plans

This case study concerns [disk-space-saviour issue #42](https://github.com/link-foundation/disk-space-saviour/issues/42).
The other README in this directory concerns an older template issue with the same number.

## Problem and reproduction

The issue reports a 548-second scan and another 346–445 seconds of discovery
before cleanup on a macOS host with 460 GB of storage and 18 GB of RAM. The default
two-minute environment budget blocked every finding, even when earlier scanners
had finished. A serialized report also forced another discovery scan.

Five minimal tests reproduced the underlying behavior before implementation:

- The default scanner order began with projects rather than global caches.
- A later scanner timing out blocked a completed cache finding too.
- Activity detection sized the entire project after sizing its generated output.
- Project directories were traversed serially, and version-pin discovery entered
  generated dependency trees.
- Cleaning an unchanged JSON report invoked discovery again.

The tests are in [issue-42-speed.test.js](../../../tests/issue-42-speed.test.js).
The initial run failed all five tests. They now pass, together with the additional
state, streaming and safety cases in [issue-42-state.test.js](../../../tests/issue-42-state.test.js).

## Changes

Global cache rules run first. Rules without recursive timestamp requirements
can use native `du -skx` and finish before expensive activity walks. Non-interactive
cleanup processes completed safe cache findings immediately. Emergency cleanup
checks the watched filesystem after deletion and stops discovery when the goal
is met. Its regression test proves that neither the remaining timestamp-based
cache measurement nor project discovery runs after a cheap cache meets the goal.

Matching CLI scans are stored for 30 minutes. `--from` accepts a scan or an audit
containing its full scan report. A local HMAC, host/user identity and age check
allow an unchanged report to bypass discovery; edited, unsigned or expired input,
and changes to discovery or action options, use the existing scanner reconstruction.
The private key and plans use mode 0600,
and the state directory uses 0700 when created. `--fresh` disables this reuse.

Discovery uses eight directory workers, metadata operations use bounded workers,
and candidate measurements use four workers. Matched generated trees, Git objects,
home media, Photos libraries and default system exclusions are pruned. Explicitly
selected media directories and root aliases remain discoverable. Verified OS
index hits arrive early; the normal walk still finds paths missing from an index.

The persistent directory index checks each directory's own identity and timestamps.
Child directories get fresh metadata checks so mount changes and link replacements
cannot authorize crossing a boundary. Cached byte counts are advisory and labeled
estimated. Cleanup measures current allocation and checks processes, open files,
Git and boundaries again. Safe cleanup rechecks project activity. Explicit moderate
cleanup retains existing support for removing ignored dependencies when only source
files changed. Task health watches and audit entries survive streaming phases.

Completed independent findings remain usable after a later budget expiry; incomplete
findings remain blocked. Explicit cancellation retains the existing blocking behavior.
Progress distinguishes candidates from files actually sized and native directory
measurements. macOS swap diagnostics report global swap usage and resident/compressed
memory consumers, without claiming verified per-process swap ownership or deleting swap.

## Bounded synthetic benchmark

Run from the repository root:

```sh
node --max-old-space-size=256 experiments/issue-42/benchmark.mjs origin/main
node --max-old-space-size=256 experiments/issue-42/benchmark.mjs
```

The script creates and removes a finite fixture: 32 projects, 4,416 regular files,
and approximately 4.25 MiB of logical payload. It compares the baseline's own source
with the working implementation, using isolated homes and dry-run cleanup. Both
versions found and planned the same 34 candidates. On Linux, Node v26.11.1, against
baseline `ee58831`, one run produced:

| Operation                       | Baseline | Updated |
| ------------------------------- | -------: | ------: |
| Cold scan                       |   959 ms |  849 ms |
| Warm scan                       |   975 ms |  537 ms |
| Dry cleanup of serialized plan  | 1,199 ms |  876 ms |
| Whole-project sizing operations |       96 |       0 |

The warm updated scan recorded 97 directory-index hits, 34 size-cache hits and zero
files sized. Cleanup still performed fresh measurements. Raw results are preserved
in [benchmark-before.json](../../../experiments/issue-42/benchmark-before.json) and
[benchmark-after.json](../../../experiments/issue-42/benchmark-after.json).

These are synthetic results, not a reproduction of the reported production Mac.
The requested under-60-second scan and under-10-second dry cleanup on that machine
remain unverified. Cold timestamp-sensitive caches and fresh deletion checks still
depend on filesystem size, permissions and activity. The implementation avoids
repeating discovery and allows independent useful cleanup to finish first.
