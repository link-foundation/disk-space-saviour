/**
 * Proof that a repository's commits still exist on a network remote, and
 * the linked worktrees that share its object database.
 *
 * Remote URLs are read from the repository config but never used through
 * it: `git ls-remote` runs outside any repository, with only the https and
 * ssh transports allowed and no prompts, so a planted config cannot run
 * commands or ask for credentials. Only advertised branches, tags and
 * review refs (`refs/pull/*`, `refs/merge-requests/*`) count, and only the
 * advertised commits that exist locally, so "on the remote" never relies
 * on cached remote-tracking refs.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LS_REMOTE_TIMEOUT_MS = 30 * 1000;
const ADVERTISED = [
  'refs/heads/*',
  'refs/tags/*',
  'refs/pull/*/head',
  'refs/merge-requests/*/head',
];

/**
 * A remote URL `git ls-remote` may contact: https/http or ssh, with a host
 * that cannot be mistaken for an option. Local paths and `file://` remotes
 * are not proof that the code exists elsewhere.
 */
export function networkRemote(url) {
  const value = url.trim();
  if (/\s/.test(value) || value.startsWith('-')) {
    return null;
  }
  const standard = /^(https?|ssh|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)/i.exec(
    value
  );
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)[^\\]/.exec(value);
  const host = standard?.[2] ?? scp?.[1];
  // `C:/repo` is a Windows path, not the host `C`.
  const drive = !standard && /^[a-z]$/i.test(host ?? '');
  return host && !drive && /^[\w.[\]-]+$/.test(host) && !host.startsWith('-')
    ? { url: value, host }
    : null;
}

/** `remote.<name>.url` values from a Git config, as `{name, url}`. */
export function parseRemoteUrls(text) {
  const remotes = [];
  let remote = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line);
    if (section) {
      remote = section[1];
      continue;
    }
    if (/^\[/.test(line)) {
      remote = null;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/i.exec(line);
    if (remote && url) {
      remotes.push({ name: remote, url: url[1].replace(/^"(.*)"$/, '$1') });
    }
  }
  return remotes;
}

/** Commit IDs from `git ls-remote` output, peeled tags included. */
export function advertisedCommits(text) {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => /^([0-9a-f]{40,64})\t/.exec(line)?.[1])
        .filter(Boolean)
    ),
  ];
}

/** Network remotes of the repository whose common Git directory is given. */
export async function networkRemotes(commonDir) {
  const text = await fsp
    .readFile(path.join(commonDir, 'config'), 'utf8')
    .catch(() => '');
  return parseRemoteUrls(text)
    .map((remote) => ({ name: remote.name, ...networkRemote(remote.url) }))
    .filter((remote) => remote.host);
}

/**
 * Work trees attached to a common Git directory: the main one (unless the
 * repository is bare) and every linked one that still exists, with the
 * detached HEAD commits of linked worktrees.
 */
export async function attachedWorktrees(commonDir) {
  const trees = [];
  const detached = [];
  const config = await fsp
    .readFile(path.join(commonDir, 'config'), 'utf8')
    .catch(() => '');
  if (
    path.basename(commonDir) === '.git' &&
    !/^\s*bare\s*=\s*true/m.test(config)
  ) {
    trees.push(path.dirname(commonDir));
  }
  const base = path.join(commonDir, 'worktrees');
  for (const name of await fsp.readdir(base).catch(() => [])) {
    const read = (file) =>
      fsp.readFile(path.join(base, name, file), 'utf8').catch(() => '');
    const gitdir = (await read('gitdir')).trim();
    const head = (await read('HEAD')).trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) {
      detached.push(head);
    }
    if (gitdir) {
      const tree = path.dirname(path.resolve(base, name, gitdir));
      if (await fsp.stat(tree).catch(() => null)) {
        trees.push(tree);
      }
    }
  }
  return { trees, detached };
}

/**
 * Runs `git ls-remote` for `url` outside every repository.
 * @param {(argv: string[], options: object) => Promise<object>} run
 */
export async function lsRemote(run, url) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dss-ls-remote-'));
  try {
    return await run(
      [
        'git',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.http.allow=always',
        '-c',
        'protocol.ssh.allow=always',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        dir,
        'ls-remote',
        url,
        ...ADVERTISED,
      ],
      {
        timeoutMs: LS_REMOTE_TIMEOUT_MS,
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
          GIT_CEILING_DIRECTORIES: path.dirname(dir),
        },
      }
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
