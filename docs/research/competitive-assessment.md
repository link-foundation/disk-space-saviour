# Disk cleanup competitive assessment

Research date: 2026-10-30. This is an initial evidence-based inventory, not an
exhaustive census or a claim that dss beats every product. The adjacent
[competitors.json](competitors.json) records 30 products, first-party sources,
source models, platform scope and unmeasured comparison fields. No competitor
was installed or run against this user's files. Prices, popularity and marketing
speed claims are deliberately excluded. Websites can change after this date.

See the extensive [platform-specific feature tables](platform-feature-comparison.md)
for Linux, macOS and five other Unix targets, including separate per-platform
capability and interface tables. [Platform feature data](platform-feature-matrix.json)
is machine-readable and keeps unknowns distinct from unsupported scope.

## Delivery state and implemented detection

The implementation contains these mechanisms; their presence alone does not
establish superiority or a guarantee against every race or data-loss scenario:

| Mechanism                                                       | Implementation                         | Evidence to retain                                             |
| --------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Process/file-use checks, command paths, PATH and app ownership  | `src/liveness.js`, `src/app-owners.js` | Liveness and app-owner tests; unreadable probes must block     |
| Clean-time revalidation                                         | `src/clean.js`                         | Tests opening a file after scan; saved-report rechecks         |
| Linked worktree and remote-presence checks for temporary clones | `src/git.js`, `src/git-remote.js`      | Dirty/outside worktrees, unreachable remotes and local commits |
| Playwright package-registry protection                          | `src/playwright-registry.js`           | Registry and cleanup-time change tests                         |
| Claude version locks and runtime reference protection           | `src/scanners/versions.js`             | Live lock, alias, pin and current-version tests                |
| Telegram cache/media boundaries                                 | `src/rules/apps.js`                    | Preserve database/storage and local user-file fixtures         |
| Chromium app-clone executable identity                          | `src/scanners/app-clones.js`           | Hardlinked running executable and shared-size tests            |
| Swap-growth diagnosis                                           | `src/swap.js`                          | History/growth tests; macOS memory is not exact swap ownership |
| Automatic phase timings                                         | `src/timings.js`                       | Scan and cleaner timing tests                                  |
| Explicit app Trash and leftover classification                  | `src/mac-apps.js`                      | Opt-in CLI, path rejection, audit and classification tests     |

The new app removal command is separate from cache cleaning. Leftover discovery
is a read-only heuristic: an absent bundle is not proof of uninstall. It does
not yet provide a verified ownership database or automatic orphan cleanup.
Chrome launcher removal preserves Chrome registration. Full vendor uninstall,
including its registration, is a separate workflow. Source is committed/pushed
before release; a published version and passing remote CI must be checked
separately. Codex memory work is a separate fork; production A/B validation and
streaming transcript export remain outside completed dss delivery.

## What the competitor evidence actually supports

| Comparison group             | First-party examples                                                                                                                                        | Implication for dss                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Rule-based/general cleanup   | [BleachBit](https://www.bleachbit.org/features), [Mole CLI](https://github.com/tw93/Mole), [CleanMyMac CLI](https://github.com/MacPaw/cleanmymac-cli)       | Developer cleanup and auditing are not automatically unique; compare individual rules and protections                     |
| App management and leftovers | [Pearcleaner](https://github.com/aurochseth/pearcleaner), [AppCleaner](https://freemacsoft.net/appcleaner/), [Nektony](https://nektony.com/mac-app-cleaner) | dss's bundle Trash plus heuristic inventory is a narrower workflow; evaluate shared data, helpers and vendor uninstallers |
| Developer artifacts          | [Kondo](https://github.com/tbillington/kondo), [npkill](https://github.com/voidcosmos/npkill)                                                               | Compare ecosystem recall and false positives on the same labeled projects                                                 |
| Duplicates/similar media     | [Czkawka](https://github.com/qarmin/czkawka), [fclones](https://github.com/pkolaczk/fclones), [dupeGuru](https://dupeguru.voltaicideas.net/)                | dss does not currently establish equivalent general duplicate or similar-media detection                                  |
| Disk exploration             | [ncdu](https://dev.yorhel.nl/ncdu), [DaisyDisk](https://daisydiskapp.com/), [GrandPerspective](https://grandperspectiv.sourceforge.net/)                    | Separate raw traversal speed and visualization from safe-cleaning decisions                                               |
| OS maintenance               | [OnyX](https://www.titanium-software.fr/en/onyx.html), [Stacer](https://github.com/oguzhaninan/Stacer)                                                      | Broader maintenance features are distinct from safe space reclamation                                                     |

Pearcleaner currently describes itself as source-available/fair-code, rather
than unrestricted open source. Mole's GPL CLI and proprietary native app are
separate products. The CleanMyMac CLI documentation repository does not by
itself establish an open-source cleanup engine. Proprietary implementations
must be evaluated through documented behavior and repeatable black-box tests;
missing public source or documentation means unknown, not absent or unsafe.

## Platform conclusions

Linux and macOS are dss's documented host targets. Other Unix systems, including
FreeBSD, OpenBSD, NetBSD, illumos and AIX, are **not validated** by this research.
Do not infer coverage from Node.js portability or POSIX filesystem calls.
`/proc`, `lsof`, process arguments, permissions, mounts and size accounting differ.
Audit unsupported-platform fail-closed behavior before advertising cleanup there.
Linux desktop products and macOS-only products should not receive failure scores
on unsupported platforms; mark those comparisons not applicable.

## Repeatable comparison protocol

Run each product only in disposable VMs or dedicated test accounts with snapshots.
Use a small synthetic corpus first; no customer/private files or running-workload
termination. Record product version, source commit or signed binary hash, OS,
filesystem, permissions, exact settings and commands, and dates. Do not install
commercial trials, accept licenses, buy software, or grant Full Disk Access as
an implicit part of a documentation comparison.

1. Label regenerable files and irreplaceable data independently of every product.
   Include node_modules containing foreign user data, tracked vendor code,
   virtual environments, Telegram databases and shared application containers.
2. Exercise open files, executable mappings, working directories, command paths,
   PATH references, app ownership, permission-denied probes and process exit.
   A Unix open file is not necessarily an exclusive lock; observe behavior.
3. Exercise scan-to-delete changes: a new open file, a new package reference,
   a symlink replacement, a dirty worktree and a remote becoming unreachable.
4. Exercise Git stashes, ignored/untracked files, submodules, detached HEADs,
   external worktrees and misleading stale remote-tracking refs. Demonstrate
   actual recoverability, not just a remote URL or a clean status.
5. Measure sparse files, hardlinks, APFS clones/shared containers and snapshots.
   Report logical size, allocated size and actual volume free-space changes
   separately; do not add shared blocks or attribute all swap to one process.
6. Compare each cleaner's preview and final actions with the labeled corpus.
   Track protected-data loss (must be zero), false positives, safe-byte recall,
   correct blocking, reasons, audit completeness and recoverability.
7. Benchmark disk analyzers separately from rule scanners. Match roots, symlink
   and mount policies, hidden files and allocated/apparent sizing. Measure wall
   time, CPU time, peak memory and I/O. Use at least five randomized runs, report
   median and spread, and distinguish warm/cold cache without flushing a live
   machine's caches. Disclose the extra cost of process/Git safety checks.
8. Retest after cleanup and restart the sample apps/projects to verify behavior.
   Report data not inspected, unsupported cases and access-denied errors.

An overall winner requires declared weights and category-level results. More
bytes deleted is not a win if user data or active dependencies were removed.
No comparative performance, correctness or overall-win result has been measured
in this assessment. Existing dss-only tests are not competitor benchmarks.

## Priorities revealed by the assessment

1. Add reproducible cross-product safety fixtures and results, with source/binary
   version pinning; inspect evidence before making superiority claims.
2. Validate app inventory completeness, ownership of shared folders, active log
   writers and vendor uninstall behavior; keep uncertain candidates read-only.
3. Verify unsupported-platform refusal, then add BSD CI and native process/mount
   probes before expanding the supported-platform statement.
4. Establish filesystem-aware reclaim estimates and independent traversal
   baselines; compare actual freed blocks as well as reported bytes.
5. Treat duplicate/similar-media detection as a separate potential feature,
   requiring its own consent and recovery design rather than automatic deletion.

The catalog is extensible. Additional commercial suites, distro-native package
and cache tools, specialized Rust/Python cleaners and smaller regional products
remain discovery work; this inventory must not be advertised as all competitors.
