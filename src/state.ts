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

/**
 * Exclusive single-instance lock: a file created with the `wx` flag holding the owner pid.
 * A lock whose pid is dead is stale and reclaimed. Returns null if another live daemon holds it.
 */
export function acquireLock(paths: DataPaths, pid: number = process.pid): Lock | null {
  fs.mkdirSync(paths.dir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
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
      let owner = NaN;
      try {
        owner = Number(fs.readFileSync(paths.lock, 'utf8').trim());
      } catch {
        /* vanished or unreadable: retry */
      }
      if (Number.isFinite(owner) && owner !== pid && pidAlive(owner)) return null;
      if (owner === pid) return null; // already ours (same process)
      try {
        fs.rmSync(paths.lock, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
