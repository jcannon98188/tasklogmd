// Keeps one workspace's model in step with edits made outside the daemon (spec section 4, "Watching and
// recovery"). Events are only hints: each debounced event re-reads the file and compares its hash with the
// model, so duplicates, bursts and the daemon's own writes all collapse to "nothing changed".
//
// Everything outside is injectable: the event source (real chokidar by default), the timers (debounce) and
// the debounce length. Tests feed synthetic events and advance a fake clock by hand.

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { identify, TASKLOG_DIR, type WorkspaceIndex } from '../model/index.ts';
import { contentHash } from '../model/parse.ts';
import { TEMP_SUFFIX } from './writes.ts';

export const DEBOUNCE_MS = 100;

export type WatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface WatchEvent {
  type: WatchEventType;
  /** Absolute path. */
  path: string;
}

export interface WatchHandlers {
  onEvent(e: WatchEvent): void;
  onError(err: unknown): void;
}

export interface WatchHandle {
  close(): Promise<void>;
}

/** Starts watching `dir`; resolves when the source is ready to report changes. */
export type EventSourceFactory = (dir: string, handlers: WatchHandlers) => Promise<WatchHandle>;

export interface WatchTimers {
  /** Schedules `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemTimers: WatchTimers = {
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** What the write service tells the watcher about the daemon's own writes (see `WriteService`). */
export interface WriteGuard {
  isSelfWrite(root: string, relPath: string, hash: string): boolean;
  /** Resolves when no write to this file is queued or running. */
  settled(root: string, relPath: string): Promise<void>;
  idle(): Promise<void>;
}

export interface WatcherOptions {
  /** Set false to run without a watcher (the model then only changes through writes and explicit scans). */
  enabled?: boolean;
  source?: EventSourceFactory;
  timers?: WatchTimers;
  debounceMs?: number;
}

export interface WatcherStats {
  /** Raw events received (before coalescing). */
  events: number;
  /** Debounced file reads. */
  reads: number;
  /** Reads dropped because the model already held those exact bytes. */
  suppressed: number;
  rescans: number;
}

/** True for paths the watcher must never look at: outside `.tasklog/`, `.git`, `node_modules`, temp files. */
export function isIgnoredPath(root: string, abs: string): boolean {
  const rel = path.relative(path.join(root, TASKLOG_DIR), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  const parts = rel.split(path.sep);
  return parts.some((p) => p === '.git' || p === 'node_modules') || abs.endsWith(TEMP_SUFFIX);
}

/** The default event source: chokidar v6, watching `.tasklog/` only, symlinks not followed. */
export const chokidarSource: EventSourceFactory = async (dir, handlers) => {
  const chokidar = await import('chokidar');
  const root = path.dirname(dir);
  const w = chokidar.watch(dir, {
    ignoreInitial: true,
    followSymlinks: false,
    persistent: true,
    ignored: (p: string, stats?: fs.Stats) => {
      if (isIgnoredPath(root, p) && path.resolve(p) !== path.resolve(dir)) return true;
      return !!stats && stats.isFile() && !p.endsWith('.md');
    },
  });
  w.on('all', (type: string, p: string) => {
    if (type === 'add' || type === 'change' || type === 'unlink' || type === 'addDir' || type === 'unlinkDir') handlers.onEvent({ type, path: p });
  });
  w.on('error', (err: unknown) => handlers.onError(err));
  await new Promise<void>((resolve) => w.once('ready', () => resolve()));
  return { close: () => w.close() };
};

export class WorkspaceWatcher {
  readonly stats: WatcherStats = { events: 0, reads: 0, suppressed: 0, rescans: 0 };
  private handle: WatchHandle | null = null;
  private closed = false;
  private readonly pending = new Map<string, () => void>(); // abs path -> cancel timer
  private cancelDirRescan: (() => void) | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private suppressedSinceRescan = 0;
  private readonly source: EventSourceFactory;
  private readonly timers: WatchTimers;
  private readonly debounceMs: number;

  constructor(
    private readonly root: string,
    private readonly idx: WorkspaceIndex,
    private readonly log: Logger,
    private readonly guard: WriteGuard | undefined,
    opts: WatcherOptions = {},
  ) {
    this.source = opts.source ?? chokidarSource;
    this.timers = opts.timers ?? systemTimers;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  }

  /** Starts the event source; logs `watch.ready` once it is live. A source that fails to start is logged, not thrown. */
  async start(): Promise<void> {
    try {
      const handle = await this.source(path.join(this.root, TASKLOG_DIR), {
        onEvent: (e) => this.push(e),
        onError: (err) => this.onError(err),
      });
      if (this.closed) {
        await handle.close().catch(() => undefined);
        return;
      }
      this.handle = handle;
      this.log.info('watch.ready', { workspace: this.root });
    } catch (e) {
      this.log.error('watch.start_failed', { workspace: this.root, error: (e as Error).message });
    }
  }

  /** Feeds one event (the event source calls this; tests call it directly). */
  push(e: WatchEvent): void {
    if (this.closed) return;
    if (e.type === 'addDir' || e.type === 'unlinkDir') {
      // A directory appearing or disappearing (a new effort, a renamed one): the per-file events are hints
      // and may be incomplete, so schedule one coalesced rescan as well.
      if (!isIgnoredPath(this.root, e.path) && path.resolve(e.path) !== path.resolve(this.root, TASKLOG_DIR)) {
        this.stats.events++;
        this.cancelDirRescan?.();
        this.cancelDirRescan = this.timers.setTimer(() => {
          this.cancelDirRescan = null;
          this.track(this.rescan('directory_event'));
        }, this.debounceMs);
      }
      return;
    }
    if (isIgnoredPath(this.root, e.path)) return;
    const rel = this.relOf(e.path);
    if (!rel || !identify(rel.slice(TASKLOG_DIR.length + 1))) return;
    this.stats.events++;
    this.pending.get(e.path)?.();
    const cancel = this.timers.setTimer(() => {
      this.pending.delete(e.path);
      this.track(this.sync(e.path, rel));
    }, this.debounceMs);
    this.pending.set(e.path, cancel);
  }

  /** Resolves when every debounced event that has fired has been fully processed. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Workspace rescan diffed by hash, logged with its reason and the count of events suppressed since the last one. */
  async rescan(reason: string): Promise<void> {
    if (this.closed) return;
    this.stats.rescans++;
    const suppressed = this.suppressedSinceRescan;
    this.suppressedSinceRescan = 0;
    this.log.info('watch.rescan', { workspace: this.root, reason, suppressed_events: suppressed });
    await this.guard?.idle(); // let in-flight writes finish so the scan sees their result
    await this.idx.scan(reason);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.pending.values()) cancel();
    this.pending.clear();
    this.cancelDirRescan?.();
    this.cancelDirRescan = null;
    await Promise.allSettled([...this.inflight]);
    await this.handle?.close().catch(() => undefined);
    this.handle = null;
  }

  private onError(err: unknown): void {
    this.log.warn('watch.error', { workspace: this.root, error: err instanceof Error ? err.message : String(err) });
    this.track(this.rescan('watcher_error'));
  }

  private relOf(abs: string): string | null {
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  private track(p: Promise<unknown>): void {
    const t = p.catch((e) => this.log.error('watch.failed', { workspace: this.root, error: (e as Error).message })).finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }

  /** One debounced event: stat, read, hash; drop if the model already has these bytes; otherwise upsert or remove. */
  private async sync(abs: string, rel: string): Promise<void> {
    if (this.closed) return;
    await this.idx.ready;
    await this.guard?.settled(this.root, rel); // a daemon write in flight updates the model itself
    if (this.closed) return;
    let bytes: Buffer;
    try {
      const st = await fs.promises.lstat(abs);
      if (!st.isFile()) {
        // A symlink or directory where an item file was: not an item.
        this.drop(rel, 'not_a_file');
        return;
      }
      this.stats.reads++;
      bytes = await fs.promises.readFile(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.drop(rel, 'deleted');
        return;
      }
      this.log.warn('watch.read_failed', { workspace: this.root, path: rel, error: (e as Error).message });
      await this.rescan('read_failed');
      return;
    }
    if (this.closed) return;
    const hash = contentHash(bytes);
    const known = this.idx.entryByPath(rel);
    if (known && known.hash === hash) {
      this.stats.suppressed++;
      this.suppressedSinceRescan++;
      this.log.debug('watch.suppressed', {
        workspace: this.root,
        path: rel,
        reason: this.guard?.isSelfWrite(this.root, rel, hash) ? 'self_write' : 'unchanged',
      });
      return;
    }
    const existed = !!known;
    this.idx.upsertFile(rel, bytes);
    const now = this.idx.entryByPath(rel);
    this.log.info(existed ? 'item.changed' : 'item.added', { workspace: this.root, id: now?.id, path: rel, hash });
  }

  private drop(rel: string, why: string): void {
    const entry = this.idx.entryByPath(rel);
    if (this.idx.removeFile(rel)) this.log.info('item.removed', { workspace: this.root, id: entry?.id, path: rel, reason: why });
  }
}
