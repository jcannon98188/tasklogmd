import { TaskLogError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { WorkspaceIndex } from '../model/index.ts';
import { ParsedItemStore } from '../model/store.ts';
import type { WorkspaceRegistry } from '../workspaces.ts';
import { sweepTempFiles } from './writes.ts';

export const INDEX_WAIT_MS = 5000;

export interface ModelManagerOptions {
  /** How long a request waits on its workspace's initial scan before failing `indexing`. Default 5 s. */
  indexWaitMs?: number;
  /** Test seam: awaited at the start of each workspace's scan. */
  beforeScan?: (root: string) => Promise<void>;
}

/**
 * Owns the daemon-global parsed-item store and one WorkspaceIndex per registered workspace. Indexing starts
 * in the background as soon as a workspace is registered (daemon start or auto-register); requests wait on
 * their own workspace only.
 */
export class ModelManager {
  readonly store = new ParsedItemStore();
  private readonly indexes = new Map<string, WorkspaceIndex>();
  private readonly waitMs: number;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly log: Logger,
    private readonly opts: ModelManagerOptions = {},
  ) {
    this.waitMs = opts.indexWaitMs ?? INDEX_WAIT_MS;
    registry.stateOf = (root) => this.indexes.get(root)?.state ?? 'indexing';
    registry.onRegister = (root) => this.ensure(root);
    registry.onUnregister = (root) => this.drop(root);
  }

  /** Starts indexing every already-registered workspace (call once after `registry.load()`). */
  startAll(): void {
    for (const w of this.registry.list()) this.ensure(w.root);
  }

  /** The index for a registered workspace, created (and its background scan started) on first use. */
  ensure(root: string): WorkspaceIndex {
    let idx = this.indexes.get(root);
    if (!idx) {
      idx = new WorkspaceIndex(root, this.store, {
        log: this.log,
        beforeScan: this.opts.beforeScan ? () => this.opts.beforeScan!(root) : undefined,
      });
      this.indexes.set(root, idx);
      sweepTempFiles(root, this.log); // leftovers of a crashed write; no write can be in flight before the index exists
      void idx.scan('initial');
    }
    return idx;
  }

  /** The index, without waiting for the initial scan (used by `workspace_status`). */
  peek(root: string): WorkspaceIndex {
    return this.ensure(root);
  }

  /** The index once its initial scan is done; waits up to `indexWaitMs`, then fails with retryable `indexing`. */
  async ready(root: string): Promise<WorkspaceIndex> {
    const idx = this.ensure(root);
    if (idx.state === 'ready') return idx;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), this.waitMs);
    });
    try {
      const winner = await Promise.race([idx.ready.then(() => 'ready' as const), timeout]);
      if (winner === 'timeout') throw new TaskLogError('indexing', { details: { workspace: root } });
    } finally {
      clearTimeout(timer);
    }
    return idx;
  }

  drop(root: string): void {
    const idx = this.indexes.get(root);
    if (!idx) return;
    idx.dispose();
    this.indexes.delete(root);
  }

  disposeAll(): void {
    for (const root of [...this.indexes.keys()]) this.drop(root);
  }
}
