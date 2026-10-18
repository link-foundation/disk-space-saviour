import { CACHE_LEAVES } from './apps.js';

/**
 * Files an application downloads or stages for itself and fetches again on
 * demand: staged updates, language servers, toolchain archives, app bundle
 * clones and caches outside the usual cache folders. Installed applications
 * and the data they read are never matched.
 */
const openaiProfiles = [
  '~/Library/Caches/com.openai.atlas/browser-data/host/*',
  '~/Library/Caches/Codex/*',
];
const zedRoots = ['~/Library/Application Support/Zed', '~/.local/share/zed'];

export const DOWNLOAD_RULES = [
  {
    id: 'chromium-code-sign-clones',
    ecosystem: 'browsers',
    scope: 'tmp',
    description:
      'Chromium app bundle clones left by exited browsers (an update makes them full copies)',
    // Chrome clones its bundle into the per-user `X` directory next to
    // `$TMPDIR` at launch and removes the clone when it exits. A running
    // browser maps the executables of its clone, so the open-file check
    // keeps every clone in use: a browser name would block orphans forever.
    paths: ['{TMP}/../X/*.code_sign_clone/code_sign_clone.*'],
    directoryOnly: true,
    minAge: 'stale',
    busy: [],
  },
  {
    id: 'chrome-on-device-models',
    ecosystem: 'browsers',
    description:
      'Chromium on-device AI models, downloaded again when a page uses built-in AI',
    // Every installed version matches: the component updater fetches the
    // model again on demand. A loaded model is held open and a download in
    // progress writes to its directory, which the open-file check and the
    // activity window catch.
    paths: [
      '~/Library/Application Support/Google/Chrome*',
      '~/Library/Application Support/Chromium',
      '~/Library/Application Support/Microsoft Edge*',
      '~/.config/google-chrome*',
      '~/.config/chromium',
      '{LOCALAPPDATA}/Google/Chrome*/User Data',
      '{LOCALAPPDATA}/Chromium/User Data',
      '{LOCALAPPDATA}/Microsoft/Edge*/User Data',
    ].map((root) => `${root}/OptGuideOnDevice*Model/*`),
    directoryOnly: true,
    minAge: 'stale',
    busy: [],
  },
  {
    id: 'google-updater-downloads',
    ecosystem: 'system',
    description: 'Google Updater downloaded installers',
    paths: [
      '~/Library/Application Support/Google/GoogleUpdater/crx_cache',
      '{LOCALAPPDATA}/Google/GoogleUpdater/crx_cache',
    ],
    minAge: 'stale',
    busy: ['GoogleUpdater'],
  },
  {
    id: 'openai-app-caches',
    ecosystem: 'apps',
    description: 'ChatGPT Atlas and Codex app browser caches',
    paths: openaiProfiles.flatMap((profile) =>
      CACHE_LEAVES.map((leaf) => `${profile}/${leaf}`)
    ),
    busy: ['ChatGPT Atlas', 'Codex'],
  },
  {
    id: 'electron-downloads',
    ecosystem: 'javascript',
    description: 'Electron and electron-builder downloaded archives',
    paths: [
      '~/Library/Caches/electron',
      '~/Library/Caches/electron-builder',
      '~/.cache/electron',
      '~/.cache/electron-builder',
      '{LOCALAPPDATA}/electron/Cache',
      '{LOCALAPPDATA}/electron-builder/Cache',
    ],
    minAge: 'stale',
    busy: ['electron-builder', 'electron-forge'],
  },
  {
    id: 'bun-transpiler-cache',
    ecosystem: 'javascript',
    description: 'Bun runtime transpiler cache',
    // Bun validates every entry against its source and transpiles again on
    // a miss, so only open files hold the cache back.
    paths: ['~/Library/Caches/bun/@t@', '~/.cache/bun/@t@'],
    busy: [],
  },
  {
    id: 'docker-desktop-update-downloads',
    ecosystem: 'apps',
    description: 'Docker Desktop updates downloaded but not installed',
    paths: ['~/Library/Application Support/com.docker.install/in_progress'],
    minAge: 'stale',
    busy: ['Docker Desktop', 'com.docker.backend', 'Docker'],
  },
  {
    id: 'docker-desktop-update-images',
    ecosystem: 'apps',
    scope: 'tmp',
    description: 'Docker Desktop update disk images',
    paths: ['{TMP}/DockerDesktopUpdates/*'],
    minAge: 'stale',
    busy: ['Docker Desktop', 'com.docker.backend', 'Docker'],
  },
  {
    id: 'warp-staged-updates',
    ecosystem: 'apps',
    description: 'Warp updates staged for the next restart',
    paths: ['~/Library/Application Support/dev.warp.Warp-*/autoupdate/*'],
    minAge: 'stale',
    // Warp applies the staged bundle when it quits, so it stays while Warp
    // runs. The process names are those of the Stable and Preview builds.
    busy: ['stable', 'preview', 'Warp'],
  },
  {
    id: 'zed-downloads',
    ecosystem: 'ide',
    description: 'Zed downloaded Node.js, language servers and Copilot',
    paths: zedRoots.flatMap((root) =>
      ['node', 'languages', 'copilot'].map((leaf) => `${root}/${leaf}`)
    ),
    busy: ['zed', 'Zed', 'zed-editor'],
  },
  {
    id: 'tree-sitter-downloads',
    ecosystem: 'c-cpp',
    description: 'tree-sitter CLI downloaded WASI SDK, Binaryen and parsers',
    paths: ['~/.cache/tree-sitter', '~/Library/Caches/tree-sitter'],
    busy: ['tree-sitter'],
  },
  {
    id: 'codex-plugin-staging',
    ecosystem: 'agents',
    description: 'abandoned Codex plugin and marketplace install staging',
    paths: [
      '~/.codex/plugins/..plugin-appserver.staging-*',
      '~/.codex/plugins/.marketplace-plugin-source-staging/*',
      '~/.codex/plugins/.remote-plugin-install-staging/*',
      '~/.codex/.tmp/marketplaces/.staging/*',
    ],
    // The Codex daemon runs for days; an install in progress writes to its
    // staging directory, which the activity window and open files catch.
    minAge: 'stale',
  },
  {
    id: 'clang-module-cache',
    ecosystem: 'c-cpp',
    description: 'Clang and Swift implicit module cache',
    scope: 'tmp',
    paths: [
      '{TMP}/../C/clang/ModuleCache',
      '{TMP}/../C/org.llvm.clang*/ModuleCache',
    ],
    // A build in another directory still reads the cache, which the
    // activity window and open files catch.
    minAge: 'stale',
    busy: ['clang', 'clang++', 'swift-frontend', 'swiftc', 'xcodebuild'],
  },
  {
    id: 'crashpad-reports',
    ecosystem: 'system',
    description: 'Chromium and Electron app crash reports already processed',
    tier: 'moderate',
    aggregate: true,
    paths: [
      '~/Library/Application Support/*/Crashpad/completed/*',
      ...['Google', 'Yandex', 'BraveSoftware'].map(
        (vendor) =>
          `~/Library/Application Support/${vendor}/*/Crashpad/completed/*`
      ),
      '~/.config/*/Crashpad/completed/*',
    ],
    minAge: 'stale',
  },
];
