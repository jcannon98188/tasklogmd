import fs from 'node:fs';
import path from 'node:path';
import { TaskLogError } from './errors.ts';
import { writeFileAtomic } from './fsutil.ts';
import type { Logger } from './log.ts';
import type { DataPaths } from './paths.ts';

export const TASKLOG_DIR = '.tasklog';

/** Realpath plus Windows case-folding: the registry key for a workspace root. */
export function canonicalize(p: string): string {
  const real = fs.realpathSync.native(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function hasTasklogDir(root: string): boolean {
  try {
    return fs.statSync(path.join(root, TASKLOG_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/** Walks up from `start` to the nearest ancestor containing `.tasklog/`; null if none. */
export function findWorkspaceRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (hasTasklogDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface WorkspaceRecord {
  root: string;
  state: 'indexing' | 'ready';
}

/**
 * The persistent workspace registry. The daemon is its only writer.
 * `workspaces.json` is `{version: 1, workspaces: [root, ...]}`.
 */
export class WorkspaceRegistry {
  private roots = new Set<string>();
  /** Hooks wired by the daemon: workspace model lifecycle and indexing state. */
  onRegister?: (root: string) => void;
  onUnregister?: (root: string) => void;
  stateOf?: (root: string) => 'indexing' | 'ready';

  constructor(
    private readonly paths: DataPaths,
    private readonly log: Logger,
  ) {}

  /** Loads the registry; a corrupt file is set aside as `.bak` and rebuilt empty. Prunes vanished roots. */
  load(): void {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.paths.workspacesJson, 'utf8');
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { workspaces?: unknown };
        if (!parsed || !Array.isArray(parsed.workspaces) || !parsed.workspaces.every((w) => typeof w === 'string')) {
          throw new Error('unexpected shape');
        }
        for (const w of parsed.workspaces as string[]) this.roots.add(w);
      } catch (e) {
        const bak = `${this.paths.workspacesJson}.bak`;
        try {
          fs.rmSync(bak, { force: true });
          fs.renameSync(this.paths.workspacesJson, bak);
        } catch {
          /* ignore */
        }
        this.roots.clear();
        this.log.warn('workspaces.corrupt', { error: (e as Error).message, backup: bak });
        this.persist();
      }
    }
    this.prune();
  }

  private persist(): void {
    writeFileAtomic(this.paths.workspacesJson, JSON.stringify({ version: 1, workspaces: [...this.roots].sort() }, null, 2) + '\n');
  }

  /** Drops roots whose directory (or `.tasklog/`) disappeared. */
  prune(): void {
    let changed = false;
    for (const r of [...this.roots]) {
      if (!hasTasklogDir(r)) {
        this.roots.delete(r);
        changed = true;
        this.log.info('workspace.pruned', { workspace: r });
        this.onUnregister?.(r); // release the index and watcher so a recreated workspace is indexed afresh
      }
    }
    if (changed) this.persist();
  }

  /**
   * Validates (absolute, exists, contains `.tasklog/`), canonicalizes and registers. Idempotent.
   * With `init`, creates `.tasklog/` first.
   */
  register(root: string, opts: { init?: boolean } = {}): string {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new TaskLogError('bad_request', { message: `Workspace root must be an absolute path; got "${String(root)}".` });
    }
    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) {
      throw new TaskLogError('no_workspace', { message: `Workspace root "${root}" does not exist; check the path.`, details: { root } });
    }
    if (opts.init) fs.mkdirSync(path.join(root, TASKLOG_DIR), { recursive: true });
    if (!hasTasklogDir(root)) {
      throw new TaskLogError('no_workspace', { details: { root, hint: 'init' } });
    }
    const canon = canonicalize(root);
    if (!this.roots.has(canon)) {
      this.roots.add(canon);
      this.persist();
      this.log.info('workspace.registered', { workspace: canon, init: !!opts.init });
    }
    this.onRegister?.(canon);
    return canon;
  }

  unregister(root: string): boolean {
    let key = root;
    try {
      key = canonicalize(root);
    } catch {
      /* vanished: match as given */
    }
    const had = this.roots.delete(key);
    if (had) {
      this.persist();
      this.log.info('workspace.unregistered', { workspace: key });
      this.onUnregister?.(key);
    }
    return had;
  }

  list(): WorkspaceRecord[] {
    this.prune();
    return [...this.roots].sort().map((root) => ({ root, state: this.stateOf?.(root) ?? ('ready' as const) }));
  }
}
