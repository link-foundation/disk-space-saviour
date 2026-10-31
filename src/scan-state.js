/** Advisory discovery/size index and authenticated, short-lived scan plans. */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trace } from './exec.js';

export const REPORT_MAX_AGE = 30 * 60 * 1000;
export const SIZE_MAX_AGE = 60 * 60 * 1000;
const LIMIT = 20000;

export function defaultStateDirectory(vars = process.env) {
  return path.join(
    vars.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
    'disk-space-saviour'
  );
}

function payload(report) {
  const { authentication, ...fields } = report;
  void authentication;
  return JSON.stringify(fields);
}

async function secret(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'scan-key');
  try {
    await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  return fs.readFile(file);
}

export async function authenticateReport(report, directory) {
  if (!directory) {
    return report;
  }
  try {
    report.authentication = {
      hostname: os.hostname(),
      uid: process.getuid?.() ?? os.userInfo().username,
      digest: createHmac('sha256', await secret(directory))
        .update(payload(report))
        .digest('hex'),
    };
  } catch (error) {
    trace('scan state unavailable', error.message);
  }
  return report;
}

function recentLocalReport(report, now) {
  const age = now - Date.parse(report.createdAt);
  const auth = report.authentication;
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > REPORT_MAX_AGE ||
    report.aborted ||
    auth?.hostname !== os.hostname() ||
    auth?.uid !== (process.getuid?.() ?? os.userInfo().username)
  ) {
    return false;
  }
  return true;
}

export async function authenticatedReport(report, directory, now = Date.now()) {
  if (
    !directory ||
    report?.schema !== 1 ||
    report.tool !== 'disk-space-saviour' ||
    !recentLocalReport(report, now)
  ) {
    return false;
  }
  try {
    const key = await fs.readFile(path.join(directory, 'scan-key'));
    const expected = createHmac('sha256', key).update(payload(report)).digest();
    const actual = Buffer.from(report.authentication.digest, 'hex');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

export function scopeKey(options) {
  const names = [
    'roots',
    'containerRoots',
    'scanners',
    'host',
    'docker',
    'dockerDepth',
    'maxDepth',
    'staleAgeMs',
    'inactiveMs',
    'minSizeBytes',
    'only',
    'exclude',
    'includeVolumes',
    'noNative',
    'journalKeepBytes',
    'containerFilter',
    'removeStoppedContainers',
    'investigationMaxAgeMs',
    'removeContainers',
    'removeImages',
    'allowDirtyRepos',
    'allowDirtyContainers',
  ];
  return createHash('sha256')
    .update(JSON.stringify(names.map((name) => [name, options[name]])))
    .digest('hex');
}

export async function saveScan(report, directory) {
  if (
    !directory ||
    !report.authentication ||
    report.aborted ||
    report.environments.some((env) => env.scanStatus === 'goal-reached')
  ) {
    return;
  }
  try {
    const dir = path.join(directory, 'scans');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${scopeKey(report.options)}.json`);
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    await fs.writeFile(temporary, JSON.stringify(report), { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    trace('cannot save scan', error.message);
  }
}

export async function loadScan(options) {
  if (!options.cacheDir) {
    return null;
  }
  try {
    const report = JSON.parse(
      await fs.readFile(
        path.join(options.cacheDir, 'scans', `${scopeKey(options)}.json`),
        'utf8'
      )
    );
    return (await authenticatedReport(report, options.cacheDir, options.now()))
      ? report
      : null;
  } catch {
    return null;
  }
}

/** Cached listings are validated by each directory's own metadata, never its parent alone. */
export class ScanIndex {
  constructor(directory) {
    this.directory = directory;
    this.entries = new Map();
    this.dirty = false;
  }

  async load() {
    if (!this.directory) {
      return;
    }
    try {
      const data = JSON.parse(
        await fs.readFile(
          path.join(this.directory, 'index', 'directories.json'),
          'utf8'
        )
      );
      if (data.schema === 1 && Array.isArray(data.entries)) {
        this.entries = new Map(data.entries.slice(-LIMIT));
      }
    } catch {
      // Missing/corrupt state only loses an optimization.
    }
  }

  get(key, fingerprint, maxAge = Infinity) {
    const entry = this.entries.get(key);
    return entry &&
      entry.fingerprint === fingerprint &&
      Date.now() - entry.time < maxAge
      ? entry.value
      : null;
  }

  set(key, fingerprint, value) {
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, value, time: Date.now() });
    while (this.entries.size > LIMIT) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.dirty = true;
  }

  async save() {
    if (!this.directory || !this.dirty) {
      return;
    }
    const dir = path.join(this.directory, 'index');
    const temporary = path.join(
      dir,
      `directories.${process.pid}.${randomBytes(4).toString('hex')}.json`
    );
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        temporary,
        JSON.stringify({ schema: 1, entries: [...this.entries] }),
        { mode: 0o600 }
      );
      await fs.rename(temporary, path.join(dir, 'directories.json'));
      this.dirty = false;
    } catch (error) {
      trace('cannot save discovery index', error.message);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export const directoryFingerprint = (stats) =>
  `${stats.device}:${stats.inode}:${stats.mtimeMs}:${stats.ctimeMs}`;
