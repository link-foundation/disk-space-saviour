import { batches } from '../env/batches.js';
import { LINKS_SCRIPT, parseLinks } from '../env/hardlinks.js';

/** Root overlay from the running container's mount namespace, read by its daemon. */
export function rootUpperdir(mountinfo) {
  for (const line of mountinfo.split('\n')) {
    const [mount, filesystem] = line.split(' - ');
    if (mount.split(' ')[4] !== '/' || !filesystem?.startsWith('overlay ')) {
      continue;
    }
    const options = filesystem.split(' ').slice(2).join(' ');
    const upper = /(?:^|,)upperdir=([^,]+)/.exec(options)?.[1];
    if (upper) {
      return upper.replace(/\\([0-7]{3})/g, (_, code) =>
        String.fromCharCode(Number.parseInt(code, 8))
      );
    }
  }
  return null;
}

/**
 * One transport call per bounded batch; null means inaccessible, never
 * guessed. Each measured path maps to `{allocated, links}`: its `du` blocks
 * and its multi-link entries (device:inode, nlink), so a deletion set can be
 * accounted hard-link aware (issue 51).
 */
export async function upperdirUsage(executor, paths) {
  const measured = new Map();
  const script = `for t do
    printf '\\001%s\\n' "$t"
    value=$(LC_ALL=C du -skx -- "$t" 2>&1)
    code=$?
    if [ "$code" = 0 ]; then printf '%s\\n' "$value" | cut -f1
    else case "$value" in *'No such file or directory'*) echo 0 ;; *) echo unknown ;; esac; fi
    if [ "$code" = 0 ]; then
      echo links
      ${LINKS_SCRIPT}
    fi
  done`;
  for (const batch of batches(paths)) {
    const result = await executor.run(['sh', '-c', script, 'dss', ...batch]);
    for (const record of result.stdout.split('\u0001').slice(1)) {
      const lines = record.split('\n'),
        target = lines[0],
        value = (lines[1] ?? '').trim(),
        marker = lines.indexOf('links', 2);
      measured.set(
        target,
        result.code === 0 && /^\d+$/.test(value)
          ? {
              allocated: Number(value) * 1024,
              links:
                marker < 0
                  ? []
                  : parseLinks(lines.slice(marker + 1).join('\n')),
            }
          : null
      );
    }
  }
  return measured;
}

/** Per-path allocated bytes (`du`), null when inaccessible. */
export async function upperdirBytes(executor, paths) {
  const measured = await upperdirUsage(executor, paths);
  return new Map(
    [...measured].map(([target, usage]) => [target, usage?.allocated ?? null])
  );
}
