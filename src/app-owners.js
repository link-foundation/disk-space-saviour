/**
 * macOS apps that own per-app Library folders.
 *
 * Caches, containers and other per-app data under `~/Library/<kind>/` are
 * named after the owning app's bundle identifier
 * (`~/Library/Caches/com.apple.Music/WebKit`, group containers carry a
 * team prefix: `6N38VWS5BX.ru.keepcoder.Telegram`). A running app may read
 * or write such a folder at any moment without holding a file open, so a
 * folder stays while a process runs from a bundle of its owner. This
 * covers apps a rule's process names do not list, such as every app that
 * embeds WebKit.
 */

const OWNED =
  /\/Library\/(Caches|Containers|Group Containers|HTTPStorages|WebKit|Saved Application State|Application Scripts|Application Support|Logs|Cookies)\/([^/]+)/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9_-]+)+$/;

/** Bundle identifier owning `target`, or null outside per-app folders. */
export function ownerBundleId(target) {
  const match = OWNED.exec(target);
  if (!match) {
    return null;
  }
  let id = match[2].replace(/\.(savedState|binarycookies)$/, '');
  if (match[1] === 'Group Containers') {
    id = id.replace(/^(?:[A-Z0-9]{10}\.|group\.)/, '');
  }
  return BUNDLE_ID.test(id) ? id : null;
}

/** Bundles (`.app`, `.appex`, `.xpc`) an executable runs from, outermost first. */
export function bundleRoots(executable) {
  const roots = [];
  const parts = (executable ?? '').split('/');
  for (let index = 1; index < parts.length - 1; index++) {
    if (/\.(app|appex|xpc)$/.test(parts[index])) {
      roots.push(parts.slice(0, index + 1).join('/'));
    }
  }
  return roots;
}

/** `CFBundleIdentifier` of an XML property list, or null. */
export function parseBundleIdentifier(plist) {
  return (
    /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/
      .exec(plist ?? '')?.[1]
      ?.trim() || null
  );
}

/**
 * Whether a running bundle belongs to the owner of a folder: the same
 * identifier, or one nested under the other (helpers such as
 * `com.google.Chrome.helper`, updaters such as `….ShipIt`).
 */
export function ownsFolder(running, owner) {
  const a = running.toLowerCase();
  const b = owner.toLowerCase();
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * Identifiers a process runs under. A bundle without a readable identifier
 * falls back to its name, which still matches an owner ending in it
 * (`Telegram.app` and `ru.keepcoder.Telegram`).
 * @param {string[]} roots bundle paths of the process
 * @param {Map<string, string|null>} ids bundle path → identifier
 */
export function processBundles(roots, ids) {
  return roots.map((root) => ({
    id: ids.get(root) ?? null,
    name: root
      .split('/')
      .at(-1)
      .replace(/\.(app|appex|xpc)$/, ''),
  }));
}

/** Whether one of `bundles` owns the folder of bundle identifier `owner`. */
export function bundlesOwn(bundles, owner) {
  return bundles.some((bundle) =>
    bundle.id
      ? ownsFolder(bundle.id, owner)
      : owner.toLowerCase().split('.').at(-1) === bundle.name.toLowerCase()
  );
}
