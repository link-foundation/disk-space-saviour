/** OS index hits are hints; stale/missing indexes always fall back to discovery. */
import { isWithin, matchesGlob } from '../paths.js';
import { mapLimit } from './parallel.js';

export async function indexedDirectories(env, roots, globs, maxDepth) {
  if (!env.scanIndex?.directory || env.platformIndex === false) {
    return [];
  }
  let hits = [];
  try {
    if (env.platform === 'darwin' && (await env.which('mdfind'))) {
      const query = globs
        .map((glob) => `kMDItemFSName == "${glob.replaceAll('"', '\\"')}"`)
        .join(' || ');
      for (const root of roots) {
        const result = await env.run(['mdfind', '-0', '-onlyin', root, query]);
        if (result.code === 0) {
          hits.push(...result.stdout.split('\0').filter(Boolean));
        }
      }
    } else if (env.platform === 'linux') {
      const command = (await env.which('plocate'))
        ? 'plocate'
        : (await env.which('locate'))
          ? 'locate'
          : null;
      if (command) {
        const result = await env.run([command, '-0', '-e', '-b', ...globs]);
        if (result.code === 0) {
          hits = result.stdout.split('\0').filter(Boolean);
        }
      }
    }
  } catch {
    // Budget/cancellation will be observed by the fallback walk too.
  }
  hits = [...new Set(hits)]
    .filter((target) => {
      const root = roots.find((candidate) =>
        isWithin(target, candidate, env.path)
      );
      if (
        !root ||
        !env.path.isAbsolute(target) ||
        !globs.some((glob) => matchesGlob(env.path.basename(target), glob))
      ) {
        return false;
      }
      const parts = env.path.relative(root, target).split(/[\\/]/);
      return (
        parts.length <= maxDepth &&
        !parts
          .slice(0, -1)
          .some(
            (name, index) =>
              env.skipDiscoveryDirectory(
                env.path.join(root, ...parts.slice(0, index)),
                name
              ) || globs.some((glob) => matchesGlob(name, glob))
          )
      );
    })
    .slice(0, 20000);
  const candidates = await mapLimit(hits, 8, async (target) => {
    const stat = await env.stat(target);
    const root = roots.find((candidate) =>
      isWithin(target, candidate, env.path)
    );
    if (stat?.type !== 'dir' || stat.device !== (await env.deviceId(root))) {
      return null;
    }
    let parent = env.path.dirname(target);
    while (parent !== root && isWithin(parent, root, env.path)) {
      const ancestor = await env.stat(parent);
      if (ancestor?.type !== 'dir' || ancestor.device !== stat.device) {
        return null;
      }
      parent = env.path.dirname(parent);
    }
    return {
      path: target,
      name: env.path.basename(target),
      parent: env.path.dirname(target),
    };
  });
  return candidates.filter(Boolean);
}
