/**
 * Browser revisions that installed Playwright packages still launch.
 *
 * Playwright records every package it installed browsers for as a file in
 * `<registry>/.links/` holding that package's directory, and the package's
 * `browsers.json` names the revisions it launches. Playwright's own cleanup
 * keeps a revision while a linked package that still exists names it; dss
 * keeps the same revisions, so deleting one never breaks an installed
 * project until its next `playwright install`.
 */

/** Directory of a registry revision: `chromium-headless-shell` → `chromium_headless_shell-1248`. */
export function browserDirName(name, revision) {
  return `${name.replace(/-/g, '_')}-${revision}`;
}

/** Revision directories one `browsers.json` names, platform overrides included. */
export function requiredDirs(text) {
  const browsers = JSON.parse(text)?.browsers;
  if (!Array.isArray(browsers)) {
    throw new Error('no browsers list');
  }
  return browsers.flatMap((browser) =>
    [browser.revision, ...Object.values(browser.revisionOverrides ?? {})]
      .filter(Boolean)
      .map((revision) => browserDirName(browser.name, revision))
  );
}

/**
 * Maps each revision directory name to the linked packages that need it;
 * `unreadable` lists links whose package exists but cannot be read.
 */
export async function playwrightUsers(env, registry) {
  const users = new Map();
  const unreadable = [];
  for (const link of await env.list(env.path.join(registry, '.links'))) {
    const pkg = (await env.readText(link.path))?.trim();
    if (!pkg) {
      unreadable.push(link.path);
      continue;
    }
    const manifest = env.path.join(pkg, 'browsers.json');
    if (!(await env.exists(manifest))) {
      // The project or its node_modules is gone; Playwright drops the link too.
      continue;
    }
    try {
      for (const dir of requiredDirs((await env.readText(manifest)) ?? '')) {
        users.set(dir, [...(users.get(dir) ?? []), pkg]);
      }
    } catch {
      unreadable.push(manifest);
    }
  }
  return { users, unreadable };
}

/**
 * Why `target`, a revision directory in a Playwright registry, must stay;
 * null when no installed package needs it.
 * @param {Map<string, Promise<object>>} [cache] registry → playwrightUsers
 */
export async function playwrightBlocker(env, target, cache = new Map()) {
  const registry = env.path.dirname(target);
  if (!cache.has(registry)) {
    cache.set(registry, playwrightUsers(env, registry));
  }
  const { users, unreadable } = await cache.get(registry);
  if (unreadable.length > 0) {
    return `cannot read Playwright install record ${unreadable[0]}`;
  }
  const needed = users.get(env.path.basename(target));
  return needed
    ? `Playwright in ${needed[0]} still uses ${env.path.basename(target)}`
    : null;
}
