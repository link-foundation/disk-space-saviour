/**
 * Chromium browsers on macOS clone their app bundle at launch with APFS
 * `clonefile` and replace the clone's main executable with a hard link to
 * the installed one (chrome/browser/mac/code_sign_clone_manager.mm). The
 * browser holds no file open inside its clone: it runs the shared inode,
 * which `lsof` reports under the installed path until an update replaces
 * the app. After an update the clone keeps the running browser's code
 * signature valid, so a clone stays while any process runs its executable.
 * Until then the clone shares every block with the installed app, and
 * removing it frees nothing but directory entries.
 */

const BUNDLE_SUFFIX = '.bundle';

/**
 * Main executables of the bundle cloned in `clone`, and whether the clone
 * still shares its blocks with an app installed in one of `appDirs`.
 * @returns {Promise<{executables: string[], sharedWith: string|null}>}
 */
export async function appCloneDetails(env, clone, appDirs) {
  const executables = [];
  let sharedWith = null;
  for (const bundle of await env.list(clone)) {
    if (
      bundle.type !== 'dir' ||
      !bundle.name.endsWith(`.app${BUNDLE_SUFFIX}`)
    ) {
      continue;
    }
    const appName = bundle.name.slice(0, -BUNDLE_SUFFIX.length);
    const macos = env.path.join(bundle.path, 'Contents', 'MacOS');
    for (const entry of await env.list(macos)) {
      if (entry.type !== 'file') {
        continue;
      }
      executables.push(entry.path);
      sharedWith ??= await installedCopy(env, entry, appName, appDirs);
    }
  }
  return { executables, sharedWith };
}

async function installedCopy(env, executable, appName, appDirs) {
  const inode = (await env.stat(executable.path))?.inode;
  for (const dir of appDirs) {
    const app = env.path.join(dir, appName);
    const installed = env.path.join(app, 'Contents', 'MacOS', executable.name);
    if (inode && (await env.stat(installed))?.inode === inode) {
      return app;
    }
  }
  return null;
}
