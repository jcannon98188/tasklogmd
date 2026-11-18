// The write protocol (spec section 4): one `WriteService` per daemon, the only code that writes item files.
//
// For one edit of one item, inside that file's serial queue:
//   1. read the file from disk and hash it; a client hash that differs is rejected `stale_hash` (the model
//      is caught up to what is on disk as a side effect, so the next read is fresh);
//   2. apply the edit to the parse of those exact bytes (`model/edit.ts`, a minimal in-place patch);
//   3. write the result to a temp file in the same directory (`.<name>.<rand>.tasklog-tmp`);
//   4. test hook `beforeRename`, then re-check the disk hash one last time;
//   5. atomically rename over the original;
//   6. register the new bytes with the workspace index (which acquires the parse result in the store) and
//      remember the hash as a self-write for the watcher (ticket 07).
// Any failure removes the temp file and leaves the original untouched.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TaskLogError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { applyEdit, type Edit, type EditOp } from '../model/edit.ts';
import { TASKLOG_DIR, type WorkspaceIndex } from '../model/index.ts';
import { contentHash, parseItem } from '../model/parse.ts';
import type { ModelManager } from './models.ts';

export const TEMP_SUFFIX = '.tasklog-tmp';

/** Describes the write that a `beforeRename` hook is holding. */
export interface PendingWrite {
  root: string;
  id: string;
  /** Workspace-relative path of the file being written. */
  path: string;
  op: EditOp;
}

export interface WriteResult {
  id: string;
  /** Hash of the file on disk after the write (unchanged for a no-op edit). */
  hash: string;
  /** False when the edit changed nothing; the file was not touched. */
  changed: boolean;
  /** AC number touched or created (AC operations). */
  n?: number;
  /** Workspace-relative path. */
  path: string;
}

/**
 * Removes leftover temp files under `<root>/.tasklog/` (a crash between writing the temp file and renaming
 * it). Runs when a workspace is first indexed, before any write can be in flight. Returns how many it removed.
 */
export function sweepTempFiles(root: string, log?: Logger): number {
  let removed = 0;
  const walk = (dir: string, depth: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isFile() && d.name.endsWith(TEMP_SUFFIX)) {
        try {
          fs.rmSync(p, { force: true });
          removed++;
        } catch (e) {
          log?.warn('tmp.sweep_failed', { workspace: root, path: p, error: (e as Error).message });
        }
      } else if (d.isDirectory() && !d.isSymbolicLink() && depth < 3 && !d.name.startsWith('.')) walk(p, depth + 1);
    }
  };
  walk(path.join(root, TASKLOG_DIR), 0);
  if (removed > 0) log?.info('tmp.swept', { workspace: root, removed });
  return removed;
}

const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      // On Windows a reader (antivirus, indexer) can briefly hold the target; retry a few times.
      if (attempt >= 8 || !RENAME_RETRY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

export interface WriteServiceOptions {
  /** Test hook: awaited after the temp file is written and before the final hash check and rename. */
  beforeRename?: (w: PendingWrite) => Promise<void> | void;
}

export class WriteService {
  /** Test hook, settable at any time. See `WriteServiceOptions.beforeRename`. */
  beforeRename?: (w: PendingWrite) => Promise<void> | void;
  private readonly queues = new Map<string, Promise<unknown>>();
  /** `root\0relPath -> hash` of the last bytes this service wrote. The watcher (ticket 07) drops events whose hash matches. */
  private readonly selfWrites = new Map<string, string>();

  constructor(
    private readonly models: ModelManager,
    private readonly log: Logger,
    opts: WriteServiceOptions = {},
  ) {
    this.beforeRename = opts.beforeRename;
  }

  /** True when `hash` is what this service last wrote to `relPath` (workspace-relative, forward slashes). */
  isSelfWrite(root: string, relPath: string, hash: string): boolean {
    return this.selfWrites.get(`${root}\0${relPath}`) === hash;
  }

  /** Resolves when every queued write has finished. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()]);
  }

  /**
   * Applies one edit to the item `id` of workspace `root`, requiring the caller's content `hash` to match
   * the file on disk. Errors: `not_found`, `conflicted`, `invalid_item` (the item cannot be written),
   * `stale_hash`, `bad_request`, `not_found` (AC), `bad_transition`, `indexing`.
   */
  async edit(root: string, id: string, hash: string, edit: Edit): Promise<WriteResult> {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new TaskLogError('bad_request', { message: 'hash must be the 64-character hash returned by get_item or the last write.' });
    }
    const idx = await this.models.ready(root);
    const first = idx.get(id); // throws not_found, conflicted or invalid_item before we queue
    const abs = path.join(root, ...first.path.split('/'));
    return this.enqueue(abs, () => this.run(root, idx, id, hash, edit));
  }

  private enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  private async run(root: string, idx: WorkspaceIndex, id: string, hash: string, edit: Edit): Promise<WriteResult> {
    const view = idx.get(id); // re-check under the queue: an earlier write may have made it invalid, or a duplicate may have appeared
    const rel = view.path;
    const abs = path.join(root, ...rel.split('/'));
    let before: Buffer;
    try {
      before = await fs.promises.readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        idx.removeFile(rel);
        throw new TaskLogError('not_found', { message: `The file for "${id}" no longer exists on disk; check the Item ID with list_items.`, details: { id } });
      }
      throw e;
    }
    const diskHash = contentHash(before);
    if (diskHash !== hash) {
      idx.upsertFile(rel, before); // catch the model up to the external edit
      this.log.info('item.stale_hash', { workspace: root, id, operation: edit.op });
      throw new TaskLogError('stale_hash', { details: { id } });
    }
    const parse = parseItem(before);
    if (!parse.ok) {
      idx.upsertFile(rel, before);
      throw new TaskLogError('invalid_item', {
        message: `Item "${id}" (${rel}) does not parse: ${parse.error}; fix it on disk.`,
        details: { id, path: rel, error: parse.error },
      });
    }

    const result = applyEdit(parse, edit, { id: view.id, effort: view.id.split('/')[0]! });
    if (result.text === parse.text) {
      if (diskHash !== view.hash) idx.upsertFile(rel, before);
      return { id: view.id, hash: diskHash, changed: false, ...(result.n !== undefined ? { n: result.n } : {}), path: rel };
    }
    const after = Buffer.from((parse.bom ? '﻿' : '') + result.text, 'utf8');
    const newHash = contentHash(after);

    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`);
    try {
      const fh = await fs.promises.open(tmp, 'wx');
      try {
        await fh.writeFile(after);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await this.beforeRename?.({ root, id: view.id, path: rel, op: edit.op });
      // Last look before the swap: an external writer may have got in during the pause.
      const now = await fs.promises.readFile(abs);
      if (contentHash(now) !== diskHash) {
        idx.upsertFile(rel, now);
        throw new TaskLogError('stale_hash', { details: { id } });
      }
      await renameWithRetry(tmp, abs);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }

    idx.upsertFile(rel, after);
    this.selfWrites.set(`${root}\0${rel}`, newHash);
    this.log.info('item.write', { workspace: root, id: view.id, operation: edit.op, hash: newHash });
    return { id: view.id, hash: newHash, changed: true, ...(result.n !== undefined ? { n: result.n } : {}), path: rel };
  }
}
