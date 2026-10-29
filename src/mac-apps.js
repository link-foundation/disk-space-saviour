/** Explicit macOS application removal and conservative leftover inventory. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { LocalEnv } from './env/local.js';
import { LivenessProbe } from './liveness.js';
import { parseBundleIdentifier } from './app-owners.js';
import { runProcess } from './exec.js';
import { startAudit, writeAudit } from './audit.js';

const TRASH = `ObjC.import('Foundation');
function run(args) {
 const url = $.NSURL.fileURLWithPath(args[0]);
 if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, null))
   throw new Error('macOS refused the Trash operation');
 return 'In Trash';
}`;

export async function appIdentity(target, home = os.homedir()) {
  const full = path.resolve(target);
  const allowed = ['/Applications', path.join(home, 'Applications')];
  if (
    !allowed.some((root) => full.startsWith(`${root}/`)) ||
    !full.endsWith('.app')
  ) {
    throw new Error(
      'Select an explicit .app inside /Applications or ~/Applications'
    );
  }
  if ((await fs.realpath(full)) !== full) {
    throw new Error('Symlinked app paths are not supported');
  }
  if (
    full
      .split(path.sep)
      .slice(0, -1)
      .some((part) => part.endsWith('.app'))
  ) {
    throw new Error(
      'Nested application components cannot be removed separately'
    );
  }
  const stats = await fs.lstat(full);
  if (!stats.isDirectory()) {
    throw new Error('Application must be a directory');
  }
  const plist = await runProcess([
    '/usr/bin/plutil',
    '-convert',
    'xml1',
    '-o',
    '-',
    path.join(full, 'Contents/Info.plist'),
  ]);
  const id = parseBundleIdentifier(plist.stdout);
  if (plist.code || !id) {
    throw new Error('Application identity cannot be verified');
  }
  return {
    path: full,
    id,
    device: stats.dev,
    inode: stats.ino,
    webApp: plist.stdout.includes('CrAppModeShortcutID'),
    hasReceipt: await fs
      .access(path.join(full, 'Contents/_MASReceipt/receipt'))
      .then(
        () => true,
        () => false
      ),
  };
}

export function leftoverCategory(kind) {
  return ['Caches', 'Logs'].includes(kind)
    ? 'disposable-after-activity-check'
    : 'user-decision';
}

async function installedIds(root, ids, errors, depth = 0) {
  if (depth > 4) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.name.endsWith('.app')) {
      try {
        const result = await runProcess([
          '/usr/bin/plutil',
          '-convert',
          'xml1',
          '-o',
          '-',
          path.join(full, 'Contents/Info.plist'),
        ]);
        const id = parseBundleIdentifier(result.stdout);
        if (!id) {
          throw new Error('Unreadable app identity');
        }
        ids.add(id);
      } catch {
        errors.push(`Cannot inventory ${full}`);
      }
    } else {
      await installedIds(full, ids, errors, depth + 1);
    }
  }
}

export async function appLeftovers(home = os.homedir()) {
  const ids = new Set();
  const errors = [];
  for (const root of [
    '/Applications',
    '/System/Applications',
    path.join(home, 'Applications'),
  ]) {
    try {
      await installedIds(root, ids, errors);
    } catch (error) {
      errors.push(`${root}: ${error.message}`);
    }
  }
  const items = [];
  for (const kind of [
    'Caches',
    'Logs',
    'Application Support',
    'Containers',
    'Group Containers',
    'Preferences',
    'Saved Application State',
  ]) {
    const root = path.join(home, 'Library', kind);
    const entries = await fs.readdir(root).catch(() => []);
    for (const name of entries) {
      const id = name.replace(/\.(plist|savedState)$/, '');
      if (
        (kind !== 'Logs' &&
          !/^(?:com|org|net|io|dev|ai|app|at|ru|us|notion)\.[a-zA-Z0-9_.-]+$/.test(
            id
          )) ||
        id.startsWith('com.apple.')
      ) {
        continue;
      }
      if (
        [...ids].some(
          (installed) =>
            installed === id ||
            installed.startsWith(`${id}.`) ||
            id.startsWith(`${installed}.`)
        )
      ) {
        continue;
      }
      items.push({
        path: path.join(root, name),
        category: leftoverCategory(kind),
        status: 'possible-leftover',
        reason:
          'No matching bundle in standard application folders; app may be elsewhere or ownership shared',
        automaticDeletion: false,
      });
    }
  }
  return {
    items,
    errors,
    note: 'Read-only candidates, not proof of uninstall. Logs can contain diagnostic history. No support data is automatically removed.',
  };
}

async function trashApp(identity) {
  const fresh = await appIdentity(identity.path);
  if (
    fresh.inode !== identity.inode ||
    fresh.device !== identity.device ||
    fresh.id !== identity.id
  ) {
    throw new Error('Application changed during removal');
  }
  const env = new LocalEnv();
  const probe = new LivenessProbe(env, { staleAgeMs: 0 });
  await probe.refresh(true);
  await probe.resolve([identity.path]);
  const blocker = probe.busyReason({
    paths: [identity.path],
    checks: { mtime: false },
  });
  if (blocker) {
    throw new Error(blocker);
  }
  const result = await runProcess([
    '/usr/bin/osascript',
    '-l',
    'JavaScript',
    '-e',
    TRASH,
    identity.path,
  ]);
  if (result.code) {
    throw new Error(result.stderr || 'macOS Trash operation failed');
  }
  if (
    await fs.lstat(identity.path).then(
      () => true,
      () => false
    )
  ) {
    throw new Error('Trash operation did not remove the original path');
  }
  return result.stdout.trim();
}

function removalDryRun(values) {
  return !values.yes || Boolean(values['dry-run']);
}

export async function runApps(argv, io, signal) {
  if (process.platform !== 'darwin') {
    throw new Error('apps is currently macOS-only');
  }
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'launcher-only': { type: 'boolean' },
      json: { type: 'boolean' },
      'audit-dir': { type: 'string' },
    },
  });
  const [command, ...targets] = positionals;
  if (command === 'leftovers') {
    io.stdout(JSON.stringify(await appLeftovers(), null, 2));
    return 0;
  }
  if (command !== 'remove' || !targets.length) {
    throw new Error(
      'Use apps remove /absolute/App.app [--yes] [--launcher-only], or apps leftovers'
    );
  }
  const audit = startAudit('apps-remove', {
    dryRun: removalDryRun(values),
  });
  for (const target of targets) {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }
    try {
      const identity = await appIdentity(target);
      if (identity.hasReceipt) {
        throw new Error('App Store app: use the macOS uninstall flow');
      }
      if (identity.webApp && !values['launcher-only']) {
        throw new Error(
          'Use Chrome > chrome://apps > Uninstall first; --launcher-only explicitly permits the Trash fallback, preserving browser data and registration'
        );
      }
      const destination = audit.dryRun ? null : await trashApp(identity);
      audit.entries.push({
        ...identity,
        status: audit.dryRun ? 'would-trash' : 'trashed',
        destination,
      });
    } catch (error) {
      audit.entries.push({
        path: target,
        status: 'blocked',
        reason: error.message,
      });
    }
  }
  const file = await writeAudit(audit, { auditDir: values['audit-dir'] });
  io.stdout(JSON.stringify({ ...audit, auditFile: file }, null, 2));
  return audit.entries.some((entry) => entry.status === 'blocked') ? 1 : 0;
}
