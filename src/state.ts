import fs from 'node:fs';
import { pidAlive, readJsonFile, writeFileAtomic } from './fsutil.ts';
import type { DataPaths } from './paths.ts';

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  version: string;
  protocol: number;
}

export function readDaemonState(paths: DataPaths): DaemonState | null {
  const s = readJsonFile<DaemonState>(paths.daemonJson);
  if (!s || typeof s.port !== 'number' || typeof s.token !== 'string' || typeof s.pid !== 'number') return null;
  return s;
}

export function writeDaemonState(paths: DataPaths, s: DaemonState): void {
  writeFileAtomic(paths.daemonJson, JSON.stringify(s));
}

/** Removes daemon.json only if it still describes this daemon. */
export function removeDaemonState(paths: DataPaths, pid: number, port: number): void {
  const s = readDaemonState(paths);
  if (s && s.pid === pid && s.port === port) {
    try {
      fs.rmSync(paths.daemonJson, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface Lock {
  release(): void;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** How long a lock file may stay empty/unparsable (its owner is between `wx` create and write) before it is treated as stale. */
const LOCK_GRACE_MS = 2000;
const RECLAIM_STALE_MS = 5000;

/** The pid in the lock file when that process is alive; null when there is no lock, or it is stale or unparsable. */
export function lockHolder(paths: DataPaths): number | null {
  const raw = readLockRaw(paths.lock);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return pidAlive(pid) ? pid : null;
}

function readLockRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Deletes the stale lock, but only if it still holds the content we judged stale. A `.reclaim` mutex
 * serialises reclaimers, so a second one re-reads under the mutex and finds the first one's fresh lock
 * instead of deleting it.
 */
function reclaimStale(paths: DataPaths, expected: string): void {
  const mutex = `${paths.lock}.reclaim`;
  let fd: number;
  try {
    fd = fs.openSync(mutex, 'wx');
  } catch {
    try {
      if (Date.now() - fs.statSync(mutex).mtimeMs > RECLAIM_STALE_MS) fs.rmSync(mutex, { force: true });
    } catch {
      /* gone already */
    }
    sleepSync(20);
    return;
  }
  try {
    if (readLockRaw(paths.lock) === expected) fs.rmSync(paths.lock, { force: true });
  } catch {
    /* ignore */
  } finally {
    fs.closeSync(fd);
    try {
      fs.rmSync(mutex, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Exclusive single-instance lock: a file created with the `wx` flag holding the owner pid.
 * A lock whose pid is dead is stale and reclaimed. An empty or unparsable lock is assumed to be
 * mid-creation and waited on (not deleted) for a grace period. Returns null if another live daemon holds it.
 */
export function acquireLock(paths: DataPaths, pid: number = process.pid): Lock | null {
  fs.mkdirSync(paths.dir, { recursive: true });
  let unparsableSince: number | null = null;
  const deadline = Date.now() + LOCK_GRACE_MS + 3000;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(paths.lock, 'wx');
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return {
        release() {
          try {
            if (fs.readFileSync(paths.lock, 'utf8').trim() === String(pid)) fs.rmSync(paths.lock, { force: true });
          } catch {
            /* ignore */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const raw = readLockRaw(paths.lock);
    if (raw === null) continue; // vanished: retry the create
    const owner = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isFinite(owner)) {
      unparsableSince = null;
      if (owner === pid) return null; // already ours (same process)
      if (pidAlive(owner)) return null;
      reclaimStale(paths, raw);
      continue;
    }
    // Empty or unparsable: probably being created right now. Wait, then give up on it.
    unparsableSince ??= Date.now();
    if (Date.now() - unparsableSince >= LOCK_GRACE_MS) reclaimStale(paths, raw);
    else sleepSync(25);
  }
  return null;
}
