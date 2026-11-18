import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './errors.ts';

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  workspace?: string;
  request_id?: string;
  [k: string]: unknown;
}

export interface Logger {
  error(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  /** Last warn/error entries (in-memory ring buffer, never persisted), optionally for one workspace. */
  recentProblems(workspace?: string): LogEntry[];
}

export interface LoggerOptions {
  /** Log file; omit for no file output. */
  file?: string;
  level?: LogLevel;
  /** Mirror every line to stderr (`tasklog serve`). */
  stderr?: boolean;
  /** Rotate at this size. */
  maxBytes?: number;
  /** Total files kept, including the live one (daemon.log: 3; shim.log: 2). */
  keep?: number;
  /** Rotate only at start (shim.log), not on each write. */
  rotateOnWrite?: boolean;
  now?: () => Date;
}

export function parseLevel(v: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  return v && v in RANK ? (v as LogLevel) : fallback;
}

/** Rename file -> file.1 -> file.2 ..., dropping the oldest. Best-effort: failures are ignored. */
export function rotate(file: string, keep: number): void {
  try {
    for (let i = keep - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try {
        if (i === keep - 1) fs.rmSync(to, { force: true });
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

const RING_SIZE = 50;

export function createLogger(opts: LoggerOptions = {}): Logger {
  const threshold = RANK[opts.level ?? 'info'];
  const now = opts.now ?? (() => new Date());
  const keep = opts.keep ?? 3;
  const rings = new Map<string, LogEntry[]>();
  let size = 0;

  const file = opts.file;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (opts.maxBytes && size >= opts.maxBytes) {
        rotate(file, keep);
        size = 0;
      }
    } catch {
      /* logging must never break the process */
    }
  }

  function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const entry: LogEntry = { ts: now().toISOString(), level, event, ...fields };
    if (level === 'warn' || level === 'error') {
      // Latest 50 per workspace, so a noisy workspace cannot push another's events out.
      const key = typeof entry.workspace === 'string' ? entry.workspace : '';
      const list = rings.get(key) ?? [];
      rings.set(key, list);
      list.push(entry);
      if (list.length > RING_SIZE) list.shift();
    }
    if (RANK[level] > threshold) return;
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line);
    if (opts.stderr) process.stderr.write(line);
    if (!file) return;
    try {
      if (opts.maxBytes && opts.rotateOnWrite !== false && size + bytes > opts.maxBytes && size > 0) {
        rotate(file, keep);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += bytes;
    } catch {
      /* ignore */
    }
  }

  return {
    error: (e, f) => write('error', e, f),
    warn: (e, f) => write('warn', e, f),
    info: (e, f) => write('info', e, f),
    debug: (e, f) => write('debug', e, f),
    recentProblems: (workspace) =>
      workspace
        ? [...(rings.get(workspace) ?? [])]
        : [...rings.values()].flat().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(-RING_SIZE),
  };
}

export const daemonLoggerOptions = { maxBytes: 5 * 1024 * 1024, keep: 3 } as const;
export const shimLoggerOptions = { maxBytes: 1024 * 1024, keep: 2, rotateOnWrite: false } as const;
