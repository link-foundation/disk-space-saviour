# Issues 55–57: upload staging and GitHub CLI log caches

## Scope and plan

Issue [57](https://github.com/link-foundation/disk-space-saviour/issues/57)
requires issues [55](https://github.com/link-foundation/disk-space-saviour/issues/55)
and [56](https://github.com/link-foundation/disk-space-saviour/issues/56) in one
pull request. All three issue bodies, their comments, native sub-issues, and
PR 58 conversation comments, inline comments, and reviews were read on
2026-11-14. There were no comments or additional sub-issues.

| Requirement                                                            | Finding and implementation plan                                                                                              | Verification plan                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 55: discover `{TMP}/hive-mind-log-upload-*` containing `sanitized.log` | Add the missing pattern to `sanitized-upload-staging`.                                                                       | Scan small real filesystem fixtures in multiple temporary roots.                                                       |
| 55: retain existing upload layouts                                     | Keep both previous patterns.                                                                                                 | Verify all three layouts together.                                                                                     |
| 55: preserve the stale activity window                                 | Keep `minAge: 'stale'`.                                                                                                      | Fresh directories and old directories with a newly written log stay unoffered; cleanup rechecks writes after scanning. |
| 55: preserve liveness checks                                           | Use the shared open-file and process checks at scan and deletion time.                                                       | Hold a staging log open through a mocked probe and verify it survives.                                                 |
| 55: moderate tier                                                      | Keep the existing tier.                                                                                                      | Safe cleanup preserves it; moderate cleanup removes idle staging.                                                      |
| 56: discover `~/.cache/gh/run-log-*.zip`                               | Already partially implemented in `src/rules/downloads.js`; reuse that rule.                                                  | Scan several ZIP files and verify only matching files enter removal actions.                                           |
| 56: safe tier                                                          | Existing rule is moderate; change it to safe as requested.                                                                   | Verify the reported tier and actual safe cleanup.                                                                      |
| 56: protect while `gh` runs                                            | Add `busy: ['gh']`.                                                                                                          | Mock a running `gh` outside the cache during scan and after scan; verify deletion is blocked.                          |
| 56: normal stale activity window                                       | Retain `minAge: 'stale'`.                                                                                                    | Mixed fresh/stale entries and writes after scanning.                                                                   |
| 56: one candidate per user/home                                        | Retain `aggregate: true`.                                                                                                    | Two homes with multiple archives produce two candidates.                                                               |
| 56: cache data only, preserve source/auth state                        | Match archive files only, never the entire cache or configuration directory.                                                 | Keep unrelated files, nested nonmatching directories, and `hosts.yml`/`config.yml` during real cleanup.                |
| Apply throughout the codebase                                          | Host and container environments share `GLOBAL_RULES`; existing XDG mapping applies. Include the upstream Windows cache path. | Focused shared-scanner fixtures, configured-cache and container coverage in CI.                                        |
| 57: one PR, no deferred requirements                                   | Complete both changes with regression tests and one release changeset in PR 58.                                              | Review the complete diff, merge latest main, inspect current-commit CI, ensure clean working tree.                     |
| 57: close parent and both children                                     | Preserve separate positive `Fixes #57`, `Fixes #55`, `Fixes #56` references.                                                 | Read final PR description.                                                                                             |
| 57: disclose existing implementation                                   | Explain that 56's discovery, stale window and aggregation already existed, while tier and busy protection remained unmet.    | Include this finding in the PR description.                                                                            |

## Research and alternatives

- GitHub CLI's [run view implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/run/view/view.go)
  creates and opens `run-log-<key>.zip`; it downloads missing entries from the
  workflow log API. This supports matching those archive leaves and using the
  existing cleanup engine. Downloadability still depends on GitHub retaining
  the logs; safe-tier classification follows issue 56's explicit request.
- Hive-mind's [log upload producer](https://github.com/link-assistant/hive-mind/blob/main/src/log-upload.lib.mjs)
  calls `mkdtemp` with the `hive-mind-log-upload-` prefix, sets mode `0700`,
  and writes `sanitized.log` inside it. The missing glob matches this layout
  in every discovered temporary root, retaining the two older patterns.
- The CLI's [cache path resolver](https://github.com/cli/go-gh/blob/trunk/pkg/config/config.go)
  selects `$XDG_CACHE_HOME/gh`, `%LocalAppData%/GitHub CLI` on Windows, or
  `~/.cache/gh` (including macOS). The repository already resolves XDG cache
  roots for the current home. A Windows rule path covers the other normal
  location without assuming macOS uses `~/Library/Caches`.
- [BleachBit CleanerML](https://docs.bleachbit.org/cml/cleanerml/)
  offers declarative glob-based cleanup. It is a useful comparable design,
  but integrating a second cleanup engine adds no benefit for two rules and
  would need to preserve this project's container and liveness checks.
- [env-paths](https://github.com/sindresorhus/env-paths) generates conventional
  application directories. It does not discover existing caches or verify
  liveness, and its macOS defaults differ from GitHub CLI's actual resolver.
  Reusing `configuredPattern`, the environment adapters, and global rule
  aggregation avoids a dependency and uses each producer's real layout.

Alternatives considered: documenting these exclusions would leave recoverable
space undiscovered; deleting whole cache roots would also match unrelated data;
a dedicated scanner would duplicate existing age, aggregation, and safety logic.
The implementation therefore extends the current declarative rules.

## Verification

The new `tests/upload-and-run-log-caches.test.js` exercises the shared scanner
with real filesystem fixtures, mocked process/open-file probes, and real
cleanup. Its Linux-only shell-adapter case also verifies both rules through
`ShellEnv` without starting Docker. Other cases run on every supported OS.

Reproduce the missing staging pattern by writing an old
`hive-mind-log-upload-<random>/sanitized.log` under a discovered temporary root
and scanning with `only: ['sanitized-upload-staging']`. Reproduce the remaining
GitHub CLI gaps with an old `~/.cache/gh/run-log-1.zip`: the original rule
reports moderate tier and no busy blocker for a running `gh`.

Run the regression suite against the original rule definitions without editing
the working tree:

```sh
node --import ./experiments/issue-57-original-rules.mjs --test \
  --test-timeout=30000 tests/upload-and-run-log-caches.test.js
```

Run the fix and adjacent existing coverage:

```sh
node --test --test-timeout=30000 tests/upload-and-run-log-caches.test.js \
  tests/download-caches.test.js tests/issue-14-caches.test.js
```

Local result: all 44 focused tests pass on Node.js and Bun. ESLint passes for changed JavaScript
and the reproducer; Prettier formats all changed files. CI supplies the full
runtime/OS matrix, Docker integration, and repository-wide checks. Current
commit CI results are recorded in PR 58 when final verification finishes.

The first CI run exposed an in-place sort in the new test's path comparison.
Bun's directory order made that comparison alter the sealed scan report and
trigger report revalidation before cleanup. Comparing copies preserves the
report; the test also checks both removal audit entries and their reasons.
