# Platform-specific feature comparison

Research date: 2026-10-30. Covers dss and all 30 products in the
[competitor catalog](competitors.json). The [machine-readable matrix](platform-feature-matrix.json)
keeps platform support separate from per-platform feature evidence.
See the [assessment and benchmark protocol](competitive-assessment.md) for limits.
This is a documentation/source comparison, not an installation, safety certification,
benchmark or proof that one product beats another. No star counts or overall score.

## Reading the tables

- **I**: implemented in dss and source-inspected; not a cross-product benchmark.
- **D**: documented by the project/vendor for the reviewed platform scope.
- **P**: partial or qualified coverage; see product notes below.
- **G**: generic POSIX/Unix portability claim, not an exact OS validation.
- **C**: documented capability conditional on an unverified/qualified platform port.
- **U**: unknown; absence of documentation is not absence of the feature.
- **N**: outside the reviewed product/platform scope, not a failed comparison.
- **0**: explicitly not implemented in dss for that platform.

A review screen is not equivalent to a CLI dry run; structured export is not
necessarily a deletion audit. Native GUI excludes terminal UIs. dss's GUI is an
example application, so it is P rather than production-manager parity. Big-file
finding is P disk analysis; app-related cache removal is P standalone cache cleanup.
Feature availability can vary with product version, edition, architecture,
permissions, optional tools/codecs, and the chosen frontend. Linked product names
are first-party evidence; a D means documented, not independently measured.
Windows products/branches are outside these Unix-family tables.

## Feature definitions

| Dimension         | What an affirmative cell means                                                  |
| ----------------- | ------------------------------------------------------------------------------- |
| Disk analysis     | Directory/tree size exploration; a big-file-only search is partial              |
| Cache cleanup     | Standalone disposable-cache rules; app-attached cache removal is partial        |
| Dev artifacts     | Rebuildable project dependencies/build output; exact ecosystems still differ    |
| Duplicates        | General duplicate file detection, not only repeated cache entries               |
| Similar media     | At least one similarity mode; image, music and video modes need separate checks |
| App removal       | Installed-application removal; dss bundle-only Trash is partial                 |
| Leftover search   | Uninstalled-app/related-data discovery; dss read-only heuristic is partial      |
| CLI               | Documented terminal entry point, not necessarily unattended operation           |
| Native GUI        | Desktop graphical frontend; terminal UIs do not count                           |
| Preview/review    | Inspect/select before deletion; not necessarily a noninteractive dry run        |
| Operation audit   | History/records of cleanup decisions or actions, not just a scan result         |
| Structured export | Machine-readable reports/history/database format; exact content varies          |

## Platform availability

Narrow platform claims intentionally stay narrow. In particular, Linux support
does not imply BSD support and macOS support does not imply other Unix support.

| Product                                                              | Linux | macOS | FreeBSD | OpenBSD | NetBSD | illumos | AIX |
| -------------------------------------------------------------------- | ----- | ----- | ------- | ------- | ------ | ------- | --- |
| [dss](../../README.md)                                               | I     | I     | U       | U       | U      | U       | U   |
| [BleachBit](https://www.bleachbit.org/features)                      | D     | N     | N       | N       | N      | N       | N   |
| [Mole CLI](https://github.com/tw93/Mole)                             | N     | D     | N       | N       | N      | N       | N   |
| [Mole native](https://mole.fit/)                                     | N     | D     | N       | N       | N      | N       | N   |
| [Kondo](https://github.com/tbillington/kondo)                        | D     | D     | U       | U       | U      | U       | U   |
| [npkill](https://github.com/voidcosmos/npkill)                       | U     | U     | U       | U       | U      | U       | U   |
| [Pearcleaner](https://github.com/aurochseth/pearcleaner)             | N     | D     | N       | N       | N      | N       | N   |
| [Czkawka / Krokiet](https://github.com/qarmin/czkawka)               | D     | D     | D       | U       | U      | U       | U   |
| [rmlint](https://github.com/sahib/rmlint)                            | D     | U     | U       | U       | U      | U       | U   |
| [fclones](https://github.com/pkolaczk/fclones)                       | D     | P     | U       | U       | U      | U       | U   |
| [fdupes](https://github.com/adrianlopezroche/fdupes)                 | U     | U     | U       | U       | U      | U       | U   |
| [dupeGuru](https://dupeguru.voltaicideas.net/)                       | D     | D     | U       | U       | U      | U       | U   |
| [ncdu](https://dev.yorhel.nl/ncdu)                                   | D     | G     | G       | G       | G      | G       | G   |
| [gdu](https://github.com/dundee/gdu)                                 | D     | U     | U       | U       | U      | U       | U   |
| [dua-cli](https://github.com/Byron/dua-cli)                          | D     | D     | G       | G       | D      | G       | G   |
| [dust](https://github.com/bootandy/dust)                             | D     | D     | U       | U       | U      | U       | U   |
| [GrandPerspective](https://grandperspectiv.sourceforge.net/)         | N     | D     | N       | N       | N      | N       | N   |
| [GNOME Disk Usage Analyzer (Baobab)](https://apps.gnome.org/Baobab/) | D     | U     | U       | U       | U      | U       | U   |
| [Filelight](https://apps.kde.org/filelight/)                         | D     | U     | U       | U       | U      | U       | U   |
| [Sweeper](https://apps.kde.org/sweeper/)                             | D     | U     | U       | U       | U      | U       | U   |
| [Stacer](https://github.com/oguzhaninan/Stacer)                      | D     | N     | N       | N       | N      | N       | N   |
| [CleanMyMac](https://macpaw.com/cleanmymac)                          | N     | D     | N       | N       | N      | N       | N   |
| [CleanMyMac CLI](https://github.com/MacPaw/cleanmymac-cli)           | N     | D     | N       | N       | N      | N       | N   |
| [AppCleaner](https://freemacsoft.net/appcleaner/)                    | N     | D     | N       | N       | N      | N       | N   |
| [AppZapper](https://appzapper.com/)                                  | N     | D     | N       | N       | N      | N       | N   |
| [App Cleaner & Uninstaller](https://nektony.com/mac-app-cleaner)     | N     | D     | N       | N       | N      | N       | N   |
| [DaisyDisk](https://daisydiskapp.com/)                               | N     | D     | N       | N       | N      | N       | N   |
| [BuhoCleaner](https://www.drbuho.com/buhocleaner)                    | N     | D     | N       | N       | N      | N       | N   |
| [CCleaner for Mac](https://www.ccleaner.com/ccleaner-mac)            | N     | D     | N       | N       | N      | N       | N   |
| [OnyX](https://www.titanium-software.fr/en/onyx.html)                | N     | D     | N       | N       | N      | N       | N   |
| [Gemini 2](https://macpaw.com/gemini)                                | N     | D     | N       | N       | N      | N       | N   |

## Linux cleanup and discovery features

Products marked N for this platform are omitted here; they remain in the availability table.

| Product                                                              | Disk analysis | Cache cleanup | Dev artifacts | Duplicates | Similar media | App removal | Leftover search |
| -------------------------------------------------------------------- | ------------- | ------------- | ------------- | ---------- | ------------- | ----------- | --------------- |
| [dss](../../README.md)                                               | I             | I             | I             | 0          | 0             | 0           | 0               |
| [BleachBit](https://www.bleachbit.org/features)                      | U             | D             | U             | U          | U             | U           | U               |
| [Kondo](https://github.com/tbillington/kondo)                        | U             | U             | D             | U          | U             | U           | U               |
| [npkill](https://github.com/voidcosmos/npkill)                       | U             | U             | C             | U          | U             | U           | U               |
| [Czkawka / Krokiet](https://github.com/qarmin/czkawka)               | P             | P             | U             | D          | D             | U           | U               |
| [rmlint](https://github.com/sahib/rmlint)                            | U             | U             | U             | D          | U             | U           | U               |
| [fclones](https://github.com/pkolaczk/fclones)                       | U             | U             | U             | D          | U             | U           | U               |
| [fdupes](https://github.com/adrianlopezroche/fdupes)                 | U             | U             | U             | C          | U             | U           | U               |
| [dupeGuru](https://dupeguru.voltaicideas.net/)                       | U             | U             | U             | D          | D             | U           | U               |
| [ncdu](https://dev.yorhel.nl/ncdu)                                   | D             | U             | U             | U          | U             | U           | U               |
| [gdu](https://github.com/dundee/gdu)                                 | D             | U             | U             | U          | U             | U           | U               |
| [dua-cli](https://github.com/Byron/dua-cli)                          | D             | U             | U             | U          | U             | U           | U               |
| [dust](https://github.com/bootandy/dust)                             | D             | U             | U             | U          | U             | U           | U               |
| [GNOME Disk Usage Analyzer (Baobab)](https://apps.gnome.org/Baobab/) | D             | U             | U             | U          | U             | U           | U               |
| [Filelight](https://apps.kde.org/filelight/)                         | D             | U             | U             | U          | U             | U           | U               |
| [Sweeper](https://apps.kde.org/sweeper/)                             | U             | D             | U             | U          | U             | U           | U               |
| [Stacer](https://github.com/oguzhaninan/Stacer)                      | U             | D             | U             | U          | U             | U           | U               |

### Linux interfaces, review and records

| Product                                                              | CLI | Native GUI | Preview/review | Operation audit | Structured export |
| -------------------------------------------------------------------- | --- | ---------- | -------------- | --------------- | ----------------- |
| [dss](../../README.md)                                               | I   | P          | I              | I               | I                 |
| [BleachBit](https://www.bleachbit.org/features)                      | D   | D          | D              | U               | U                 |
| [Kondo](https://github.com/tbillington/kondo)                        | D   | D          | D              | U               | U                 |
| [npkill](https://github.com/voidcosmos/npkill)                       | C   | U          | C              | U               | U                 |
| [Czkawka / Krokiet](https://github.com/qarmin/czkawka)               | D   | D          | D              | U               | U                 |
| [rmlint](https://github.com/sahib/rmlint)                            | D   | U          | U              | U               | D                 |
| [fclones](https://github.com/pkolaczk/fclones)                       | D   | U          | D              | U               | U                 |
| [fdupes](https://github.com/adrianlopezroche/fdupes)                 | C   | U          | U              | U               | U                 |
| [dupeGuru](https://dupeguru.voltaicideas.net/)                       | U   | D          | D              | U               | U                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                                   | D   | U          | D              | U               | D                 |
| [gdu](https://github.com/dundee/gdu)                                 | D   | U          | D              | U               | D                 |
| [dua-cli](https://github.com/Byron/dua-cli)                          | D   | U          | D              | U               | U                 |
| [dust](https://github.com/bootandy/dust)                             | D   | U          | U              | U               | U                 |
| [GNOME Disk Usage Analyzer (Baobab)](https://apps.gnome.org/Baobab/) | U   | D          | U              | U               | U                 |
| [Filelight](https://apps.kde.org/filelight/)                         | U   | D          | U              | U               | U                 |
| [Sweeper](https://apps.kde.org/sweeper/)                             | U   | D          | U              | U               | U                 |
| [Stacer](https://github.com/oguzhaninan/Stacer)                      | U   | D          | U              | U               | U                 |

## macOS cleanup and discovery features

Products marked N for this platform are omitted here; they remain in the availability table.

| Product                                                              | Disk analysis | Cache cleanup | Dev artifacts | Duplicates | Similar media | App removal | Leftover search |
| -------------------------------------------------------------------- | ------------- | ------------- | ------------- | ---------- | ------------- | ----------- | --------------- |
| [dss](../../README.md)                                               | I             | I             | I             | 0          | 0             | P           | P               |
| [Mole CLI](https://github.com/tw93/Mole)                             | D             | D             | D             | U          | U             | D           | D               |
| [Mole native](https://mole.fit/)                                     | D             | D             | P             | U          | U             | D           | D               |
| [Kondo](https://github.com/tbillington/kondo)                        | U             | U             | D             | U          | U             | U           | U               |
| [npkill](https://github.com/voidcosmos/npkill)                       | U             | U             | C             | U          | U             | U           | U               |
| [Pearcleaner](https://github.com/aurochseth/pearcleaner)             | U             | P             | P             | U          | U             | D           | D               |
| [Czkawka / Krokiet](https://github.com/qarmin/czkawka)               | P             | P             | U             | D          | D             | U           | U               |
| [rmlint](https://github.com/sahib/rmlint)                            | U             | U             | U             | C          | U             | U           | U               |
| [fclones](https://github.com/pkolaczk/fclones)                       | U             | U             | U             | C          | U             | U           | U               |
| [fdupes](https://github.com/adrianlopezroche/fdupes)                 | U             | U             | U             | C          | U             | U           | U               |
| [dupeGuru](https://dupeguru.voltaicideas.net/)                       | U             | U             | U             | D          | D             | U           | U               |
| [ncdu](https://dev.yorhel.nl/ncdu)                                   | C             | U             | U             | U          | U             | U           | U               |
| [gdu](https://github.com/dundee/gdu)                                 | C             | U             | U             | U          | U             | U           | U               |
| [dua-cli](https://github.com/Byron/dua-cli)                          | D             | U             | U             | U          | U             | U           | U               |
| [dust](https://github.com/bootandy/dust)                             | D             | U             | U             | U          | U             | U           | U               |
| [GrandPerspective](https://grandperspectiv.sourceforge.net/)         | D             | U             | U             | U          | U             | U           | U               |
| [GNOME Disk Usage Analyzer (Baobab)](https://apps.gnome.org/Baobab/) | C             | U             | U             | U          | U             | U           | U               |
| [Filelight](https://apps.kde.org/filelight/)                         | C             | U             | U             | U          | U             | U           | U               |
| [Sweeper](https://apps.kde.org/sweeper/)                             | U             | C             | U             | U          | U             | U           | U               |
| [CleanMyMac](https://macpaw.com/cleanmymac)                          | D             | D             | U             | D          | U             | D           | D               |
| [CleanMyMac CLI](https://github.com/MacPaw/cleanmymac-cli)           | D             | D             | D             | U          | U             | U           | U               |
| [AppCleaner](https://freemacsoft.net/appcleaner/)                    | U             | P             | U             | U          | U             | D           | P               |
| [AppZapper](https://appzapper.com/)                                  | U             | P             | U             | U          | U             | D           | P               |
| [App Cleaner & Uninstaller](https://nektony.com/mac-app-cleaner)     | U             | P             | U             | U          | U             | D           | D               |
| [DaisyDisk](https://daisydiskapp.com/)                               | D             | U             | U             | U          | U             | U           | U               |
| [BuhoCleaner](https://www.drbuho.com/buhocleaner)                    | U             | D             | U             | U          | U             | D           | U               |
| [CCleaner for Mac](https://www.ccleaner.com/ccleaner-mac)            | U             | D             | U             | D          | U             | D           | U               |
| [OnyX](https://www.titanium-software.fr/en/onyx.html)                | U             | D             | U             | U          | U             | D           | U               |
| [Gemini 2](https://macpaw.com/gemini)                                | U             | U             | U             | D          | U             | U           | U               |

### macOS interfaces, review and records

| Product                                                              | CLI | Native GUI | Preview/review | Operation audit | Structured export |
| -------------------------------------------------------------------- | --- | ---------- | -------------- | --------------- | ----------------- |
| [dss](../../README.md)                                               | I   | P          | I              | I               | I                 |
| [Mole CLI](https://github.com/tw93/Mole)                             | D   | U          | D              | D               | D                 |
| [Mole native](https://mole.fit/)                                     | U   | D          | D              | U               | U                 |
| [Kondo](https://github.com/tbillington/kondo)                        | D   | U          | D              | U               | U                 |
| [npkill](https://github.com/voidcosmos/npkill)                       | C   | U          | C              | U               | U                 |
| [Pearcleaner](https://github.com/aurochseth/pearcleaner)             | U   | D          | D              | U               | U                 |
| [Czkawka / Krokiet](https://github.com/qarmin/czkawka)               | D   | D          | D              | U               | U                 |
| [rmlint](https://github.com/sahib/rmlint)                            | C   | U          | U              | U               | C                 |
| [fclones](https://github.com/pkolaczk/fclones)                       | C   | U          | C              | U               | U                 |
| [fdupes](https://github.com/adrianlopezroche/fdupes)                 | C   | U          | U              | U               | U                 |
| [dupeGuru](https://dupeguru.voltaicideas.net/)                       | U   | D          | D              | U               | U                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                                   | C   | U          | C              | U               | C                 |
| [gdu](https://github.com/dundee/gdu)                                 | C   | U          | C              | U               | C                 |
| [dua-cli](https://github.com/Byron/dua-cli)                          | D   | U          | D              | U               | U                 |
| [dust](https://github.com/bootandy/dust)                             | D   | U          | U              | U               | U                 |
| [GrandPerspective](https://grandperspectiv.sourceforge.net/)         | U   | D          | U              | U               | U                 |
| [GNOME Disk Usage Analyzer (Baobab)](https://apps.gnome.org/Baobab/) | U   | C          | U              | U               | U                 |
| [Filelight](https://apps.kde.org/filelight/)                         | U   | C          | U              | U               | U                 |
| [Sweeper](https://apps.kde.org/sweeper/)                             | U   | C          | U              | U               | U                 |
| [CleanMyMac](https://macpaw.com/cleanmymac)                          | U   | D          | D              | U               | U                 |
| [CleanMyMac CLI](https://github.com/MacPaw/cleanmymac-cli)           | D   | U          | D              | U               | U                 |
| [AppCleaner](https://freemacsoft.net/appcleaner/)                    | U   | D          | D              | U               | U                 |
| [AppZapper](https://appzapper.com/)                                  | U   | D          | D              | U               | U                 |
| [App Cleaner & Uninstaller](https://nektony.com/mac-app-cleaner)     | U   | D          | D              | U               | U                 |
| [DaisyDisk](https://daisydiskapp.com/)                               | U   | D          | D              | U               | U                 |
| [BuhoCleaner](https://www.drbuho.com/buhocleaner)                    | U   | D          | U              | U               | U                 |
| [CCleaner for Mac](https://www.ccleaner.com/ccleaner-mac)            | U   | D          | U              | U               | U                 |
| [OnyX](https://www.titanium-software.fr/en/onyx.html)                | U   | D          | U              | U               | U                 |
| [Gemini 2](https://macpaw.com/gemini)                                | U   | D          | U              | U               | U                 |

## Other Unix systems: feature evidence, not assumed parity

These are the specific non-Linux/non-macOS cases supported by reviewed platform
statements. Every other product/OS combination remains U or N as shown above;
no Linux or macOS feature cell is silently promoted to BSD/Unix support.

| Product                                                | OS      | OS evidence | Disk analysis | Duplicates | Similar media | CLI | Native GUI | Structured export |
| ------------------------------------------------------ | ------- | ----------- | ------------- | ---------- | ------------- | --- | ---------- | ----------------- |
| [Czkawka / Krokiet](https://github.com/qarmin/czkawka) | FreeBSD | D           | P             | D          | D             | D   | D          | U                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                     | FreeBSD | G           | C             | U          | U             | C   | U          | C                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                     | OpenBSD | G           | C             | U          | U             | C   | U          | C                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                     | NetBSD  | G           | C             | U          | U             | C   | U          | C                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                     | illumos | G           | C             | U          | U             | C   | U          | C                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                     | AIX     | G           | C             | U          | U             | C   | U          | C                 |
| [dua-cli](https://github.com/Byron/dua-cli)            | FreeBSD | G           | C             | U          | U             | C   | U          | U                 |
| [dua-cli](https://github.com/Byron/dua-cli)            | OpenBSD | G           | C             | U          | U             | C   | U          | U                 |
| [dua-cli](https://github.com/Byron/dua-cli)            | NetBSD  | D           | D             | U          | U             | D   | U          | U                 |
| [dua-cli](https://github.com/Byron/dua-cli)            | illumos | G           | C             | U          | U             | C   | U          | U                 |
| [dua-cli](https://github.com/Byron/dua-cli)            | AIX     | G           | C             | U          | U             | C   | U          | U                 |

Specific differences matter: ncdu's generic POSIX statement does not establish
ncdu 2.x availability on every listed OS. dua-cli documents NetBSD installation,
while its generic Unix build guidance is weaker evidence for the other systems.
Czkawka documents FreeBSD portability; matching frontends, codec dependencies
and binary releases still need to be checked before asserting feature parity.
dss has no validated BSD/illumos/AIX process-inspection backend in this review.

## dss platform-specific mechanisms

The linked source is evidence of implementation, not a guarantee that every
permission regime or race is handled. All five other Unix targets remain U.

| Mechanism/source                                                          | Linux                                       | macOS                                                                     | FreeBSD | OpenBSD | NetBSD | illumos | AIX |
| ------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- | ------- | ------- | ------ | ------- | --- |
| [Host cleanup target](../../README.md)                                    | I: documented Linux host                    | I: documented macOS host                                                  | U       | U       | U      | U       | U   |
| [Open descriptors, executable and cwd evidence](../../src/env/local.js)   | I: /proc process/FD inspection              | I: lsof paths and executable checks                                       | U       | U       | U      | U       | U   |
| [Process arguments and PATH references](../../src/env/local.js)           | I: /proc arguments/environment              | I: ps arguments/environment; path parsing limits apply                    | U       | U       | U      | U       | U   |
| [Recheck before cleanup](../../src/clean.js)                              | I: process/Git checks                       | I: process/Git checks                                                     | U       | U       | U      | U       | U   |
| [App bundle ownership](../../src/app-owners.js)                           | N: macOS bundle mechanism                   | I: bundle identifiers/helpers                                             | U       | U       | U      | U       | U   |
| [Total swap usage](../../src/swap.js)                                     | I: /proc/meminfo                            | I: sysctl vm.swapusage                                                    | U       | U       | U      | U       | U   |
| [Per-process memory attribution](../../src/swap.js)                       | I: VmSwap; permissions limit visibility     | P: top memory includes compressed/swapped pages; not exact swap ownership | U       | U       | U      | U       | U   |
| [Swap growth history and advice](../../src/swap.js)                       | I: state history and growth warnings        | I: state history and growth warnings                                      | U       | U       | U      | U       | U   |
| [Explicit installed-app removal](../../src/mac-apps.js)                   | 0: apps subcommand rejects non-macOS        | P: selected bundle to Trash; not full vendor uninstall                    | U       | U       | U      | U       | U   |
| [Leftover ownership inventory](../../src/mac-apps.js)                     | 0: no Linux apps-leftovers inventory        | P: read-only standard-folder heuristic                                    | U       | U       | U      | U       | U   |
| [User data versus disposable candidates](../../src/rules/apps.js)         | I: rule-specific protections                | I: rule protections; app inventory separates candidates for review        | U       | U       | U      | U       | U   |
| [Chromium code-sign clone inode checks](../../src/scanners/app-clones.js) | N: macOS mechanism                          | I: matching hardlinked executables; shared-size caveats                   | U       | U       | U      | U       | U   |
| [APFS hidden/shared volumes](../../src/usage.js)                          | N: not an APFS host                         | P: volume reporting; not arbitrary block-sharing proof                    | U       | U       | U      | U       | U   |
| [General APFS file-clone deduplication](../../src/env/local.js)           | N: macOS mechanism                          | U: no equivalence to dua APFS traversal option established                | U       | U       | U      | U       | U   |
| [Temporary Git clone recoverability](../../src/git.js)                    | I: all-worktree and remote checks           | I: all-worktree and remote checks                                         | U       | U       | U      | U       | U   |
| [Runtime references and version locks](../../src/scanners/versions.js)    | I: applicable rule paths and references     | I: applicable rule paths and references                                   | U       | U       | U      | U       | U   |
| [Playwright package registry](../../src/playwright-registry.js)           | I: linked-package required revisions        | I: linked-package required revisions                                      | U       | U       | U      | U       | U   |
| [Telegram layout coverage](../../src/rules/apps.js)                       | I: Telegram Desktop cache leaves            | I: Desktop and native container/account layouts                           | U       | U       | U      | U       | U   |
| [System-native cleanup tools](../../src/scanners/system.js)               | P: journald/snap when present and permitted | P: Homebrew cleanup when available                                        | U       | U       | U      | U       | U   |
| [Docker/nested Docker](../../src/docker/scan.js)                          | I: where reachable with required permission | P: daemon/VM interface; not host access to all VM internals               | U       | U       | U      | U       | U   |
| [Scan budget and phase timings](../../src/scan.js)                        | I: cooperative budget and timings           | I: cooperative budget and timings                                         | U       | U       | U      | U       | U   |
| [JSON output and deletion audits](../../src/audit.js)                     | I: reports and audits                       | I: reports and audits                                                     | U       | U       | U      | U       | U   |
| [Exact duplicate/similar-media finding](../../README.md)                  | 0: not implemented                          | 0: not implemented                                                        | U       | U       | U      | U       | U   |

### Competitor platform differences worth testing

| Product         | Platform                   | Documented difference                                                                             | Evidence                                                                   |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| BleachBit       | Linux versus Windows       | Cleaner availability varies; winapp2 import is Windows-only, not a Linux advantage                | [Features](https://www.bleachbit.org/features)                             |
| Mole            | macOS versus Windows       | Separate Windows branch/native offering; do not assume macOS command or protection parity         | [Project](https://github.com/tw93/Mole)                                    |
| dua-cli         | macOS                      | Opt-in fully shared APFS clone accounting; partial shared blocks are excluded from that guarantee | [Traversal documentation](https://github.com/Byron/dua-cli)                |
| dua-cli         | NetBSD                     | Explicit pkgin/pkgsrc installation; not proof of macOS APFS features                              | [Install documentation](https://github.com/Byron/dua-cli)                  |
| fclones         | Linux versus macOS         | Linux-only optimizations include page-cache handling and physical-placement ordering              | [Limitations](https://github.com/pkolaczk/fclones)                         |
| Czkawka/Krokiet | FreeBSD versus Linux/macOS | Project portability claim; binary frontend and media dependencies may vary                        | [Project](https://github.com/qarmin/czkawka)                               |
| DaisyDisk       | macOS editions             | Direct edition and App Store edition differ in purgeable-space removal                            | [Edition restriction](https://daisydiskapp.com/guide/4/en/PurgeableSpace/) |
| OnyX            | macOS versions             | OS-specific downloads; do not assume a single binary spans OS releases                            | [Downloads](https://www.titanium-software.fr/en/onyx.html)                 |
| dust            | Linux Snap packaging       | Snap confinement can restrict scan scope; package choice matters                                  | [Installation notes](https://github.com/bootandy/dust)                     |

## Product qualifications

| Product/source                                                       | Qualification                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [dss](../../README.md)                                               | Implemented Linux/macOS features; BSD/Unix ports are unvalidated. Example GUI is not a production native manager.                                                                                |
| [BleachBit](https://www.bleachbit.org/features)                      | Linux cleaners vary; winapp2 imports are Windows-only and excluded here.                                                                                                                         |
| [Mole CLI](https://github.com/tw93/Mole)                             | macOS CLI only in this matrix; Windows branch is a separate scope. Audit JSON is operation history, not a filesystem inventory.                                                                  |
| [Mole native](https://mole.fit/)                                     | Separate proprietary native product; do not import CLI features into this row.                                                                                                                   |
| [Kondo](https://github.com/tbillington/kondo)                        | Prompted project cleanup; Linux GUI documented separately. macOS GUI is not established here.                                                                                                    |
| [npkill](https://github.com/voidcosmos/npkill)                       | Node.js/runtime portability does not establish tested OS builds; feature descriptions are conditional on a working port.                                                                         |
| [Pearcleaner](https://github.com/aurochseth/pearcleaner)             | Source-available/fair-code; environment management is not proof of every artifact-cleaning rule.                                                                                                 |
| [Czkawka / Krokiet](https://github.com/qarmin/czkawka)               | FreeBSD is project-documented; frontend binaries, codec support and versions differ. Big-file finder is narrower than a full usage tree; temporary-file finder is narrower than app-cache rules. |
| [rmlint](https://github.com/sahib/rmlint)                            | Generated JSON/shell plans are not deletion audit history. Specific non-Linux builds require verification.                                                                                       |
| [fclones](https://github.com/pkolaczk/fclones)                       | Linux optimizations are not all available on macOS; macOS installation is documented but testing coverage is qualified by the project.                                                           |
| [fdupes](https://github.com/adrianlopezroche/fdupes)                 | Unix-oriented source; per-OS builds and exact deletion confirmation flags are not verified here.                                                                                                 |
| [dupeGuru](https://dupeguru.voltaicideas.net/)                       | Image/music modes are distinct from the richer video features of other products.                                                                                                                 |
| [ncdu](https://dev.yorhel.nl/ncdu)                                   | POSIX claim is generic for macOS and other Unix cells. Binary export and parallelism require ncdu 2.x; do not assume 1.x parity.                                                                 |
| [gdu](https://github.com/dundee/gdu)                                 | Linux installation is documented; other per-OS builds are unresolved. Database/export support does not imply operation audits.                                                                   |
| [dua-cli](https://github.com/Byron/dua-cli)                          | NetBSD installation is explicit; other Unix cells use only the generic Unix build guidance. APFS clone accounting is macOS-only and opt-in.                                                      |
| [dust](https://github.com/bootandy/dust)                             | Read-only terminal usage display; no destructive-preview claim is inferred.                                                                                                                      |
| [GrandPerspective](https://grandperspectiv.sourceforge.net/)         | Treemap disk explorer; automatic cache classification is not inferred.                                                                                                                           |
| [GNOME Disk Usage Analyzer (Baobab)](https://apps.gnome.org/Baobab/) | Linux/GNOME documentation; online accounts are not a claim of remote safe-cleaning.                                                                                                              |
| [Filelight](https://apps.kde.org/filelight/)                         | KDE/Linux scope; other OS packaging is not established by this review.                                                                                                                           |
| [Sweeper](https://apps.kde.org/sweeper/)                             | Privacy/activity cleanup; no developer or app-uninstaller parity inferred.                                                                                                                       |
| [Stacer](https://github.com/oguzhaninan/Stacer)                      | Linux system manager; package-manager removal is not macOS bundle uninstall.                                                                                                                     |
| [CleanMyMac](https://macpaw.com/cleanmymac)                          | Commercial GUI; CLI is a separate product row and feature evidence.                                                                                                                              |
| [CleanMyMac CLI](https://github.com/MacPaw/cleanmymac-cli)           | Interactive review is documented; a noninteractive dry-run flag is not inferred.                                                                                                                 |
| [AppCleaner](https://freemacsoft.net/appcleaner/)                    | Related-file selection attached to an app is not proof of system-wide orphan discovery.                                                                                                          |
| [AppZapper](https://appzapper.com/)                                  | Related-file removal is narrower than standalone cache cleanup or orphan discovery.                                                                                                              |
| [App Cleaner & Uninstaller](https://nektony.com/mac-app-cleaner)     | Selected app service files and orphaned files; shared-data correctness remains untested.                                                                                                         |
| [DaisyDisk](https://daisydiskapp.com/)                               | Purgeable-space removal differs between direct and App Store editions.                                                                                                                           |
| [BuhoCleaner](https://www.drbuho.com/buhocleaner)                    | Only reviewed cleanup/removal claims are affirmed; other features remain unknown here.                                                                                                           |
| [CCleaner for Mac](https://www.ccleaner.com/ccleaner-mac)            | Mac product only; Windows feature lists are not transferred.                                                                                                                                     |
| [OnyX](https://www.titanium-software.fr/en/onyx.html)                | Requires an OS-matched version; maintenance is not automatically a reclaimable-byte feature.                                                                                                     |
| [Gemini 2](https://macpaw.com/gemini)                                | Duplicate specialist; no automatic disposable-cache classification inferred.                                                                                                                     |

## How to extend or publish a comparison

Update the platform-feature JSON and these tables together, retaining per-OS
qualifications and evidence links. Use U for unresolved claims, C when only a
conditional port is known, and N for an out-of-scope platform. Do not collapse
these into a binary checkmark or treat unknowns as competitor failures. Verify
licenses separately from free pricing or a public documentation repository.

A public superiority claim still needs pinned versions, same-platform fixtures,
measured safety/correctness, and reproducible performance results. All competitor
hands-on and comparative benchmark fields remain unmeasured in this update.
