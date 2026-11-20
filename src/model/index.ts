// The workspace index (spec section 4): per workspace, `path -> {hash}` plus ID and effort lookups. It is the
// only layer that knows paths. Parse results live in the shared ParsedItemStore and are referenced by hash.

import fs from 'node:fs';
import path from 'node:path';
import { TaskLogError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { isElementKind, KINDS, STATUSES, TYPES, type FmValue, type Kind, type LayoutKind, type ParseResult, type ValidParse } from './parse.ts';
import { makeSnippet, matchItem, parseQuery, type SearchField } from './search.ts';
import type { ParsedItemStore } from './store.ts';

export const TASKLOG_DIR = '.tasklog';
/** The reserved effort name: `.tasklog/architecture/` holds elements, never an effort's map, spec or tickets. */
export const ARCHITECTURE_DIR = 'architecture';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export type ItemFlag = 'invalid' | 'conflicted' | 'dangling';

/** One indexed file. `parse` is the shared, immutable store result for `hash`. */
export interface IndexEntry {
  /** Workspace-relative, forward slashes, e.g. `.tasklog/demo/tickets/01-first.md`. */
  path: string;
  /** Item ID derived from the path: `effort/NN`, `effort/map` or `effort/spec`. */
  id: string;
  effort: string;
  /** Kind implied by the path (map.md, spec.md, tickets/, or `element` under architecture/). */
  layoutKind: LayoutKind;
  /** Ticket number, for tickets. */
  number?: number;
  hash: string;
  parse: ParseResult;
  /** For an invalid file that used to parse: the hash of its last good content. */
  lastGoodHash?: string;
  /** When this entry was first seen in its current form (ms epoch). */
  since: number;
}

export interface ListQuery {
  effort?: string;
  kind?: Kind;
  /** Tickets linked to any of these element slugs (compared lowercased). */
  components?: string[];
  status?: string;
  type?: string;
  tags_all?: string[];
  tags_any?: string[];
  tags_none?: string[];
  /** Free-text query: words (AND, prefix), "phrases", -exclusions. */
  text?: string;
  /** With `text`: add a ~160-character excerpt to each row. */
  snippet?: boolean;
  limit?: number;
  cursor?: string;
}

/** One row of `list_items`. */
export interface ListedItem {
  id: string;
  title: string;
  kind: Kind;
  status: string | null;
  type: string | null;
  tags: string[];
  claimed_by: string | null;
  /** Full Item IDs (same-effort numbers resolved against the item's effort). */
  blocked_by: string[];
  hash: string;
  flags: ItemFlag[];
  /** Workspace-relative path; the only way to tell apart the files of a conflicted ID. */
  path: string;
  /** Fields that hit `text` (empty without `text`). */
  matched_in: SearchField[];
  /** With `text` and `snippet: true`. */
  snippet?: string;
  /** Present on invalid items: why the file does not parse. */
  error?: string;
}

export interface ListResult {
  items: ListedItem[];
  /** Matching items before paging. */
  total: number;
  cursor?: string;
}

/** Result of `get`: the model's view of one valid, unconflicted item. */
export interface ItemView {
  id: string;
  path: string;
  hash: string;
  frontmatter: Record<string, FmValue>;
  body: string;
  acs: Array<{ n: number | null; text: string; checked: boolean }>;
  flags: ItemFlag[];
  /** The parse result, for callers (the editor) that need offsets. */
  parse: ValidParse;
}

export interface Problem {
  type: ItemFlag;
  id: string;
  /** The file (for a conflict, the first of `paths`). */
  path: string;
  paths: string[];
  error: string;
  /** ISO time the problem was first seen. */
  since: string;
}

export interface Counts {
  items: number;
  invalid: number;
  /** Number of Item IDs claimed by more than one file. */
  conflicted: number;
  efforts: number;
  by_kind: Record<string, number>;
  by_status: Record<string, number>;
}

export interface ArchitectureCounts {
  containers: number;
  components: number;
  proposed: number;
  accepted: number;
  /** Dangling `components` references: one per (ticket, unknown slug) pair. */
  warnings: number;
}

export interface DanglingComponent {
  /** The ticket's Item ID. */
  id: string;
  slug: string;
}

export const pad = (n: number): string => String(n).padStart(2, '0');

/** Normalises an Item ID so `eff/5` and `eff/05` are the same item: numbers are zero-padded to two digits. */
export function normalizeId(id: string): string {
  const s = id.trim();
  const i = s.lastIndexOf('/');
  if (i <= 0) return s;
  const effort = s.slice(0, i);
  const tail = s.slice(i + 1);
  return /^\d+$/.test(tail) ? `${effort}/${pad(Number(tail))}` : `${effort}/${tail.toLowerCase()}`;
}

/** Maps a path relative to `.tasklog/` (forward slashes) to its identity, or null when it is not an item file. */
export function identify(relToTasklog: string): { effort: string; id: string; layoutKind: LayoutKind; number?: number } | null {
  const parts = relToTasklog.split('/');
  const effort = parts[0];
  if (!effort || effort.startsWith('.')) return null;
  if (effort === ARCHITECTURE_DIR) {
    const m = parts.length === 2 ? /^([a-z0-9][a-z0-9-]*)\.md$/.exec(parts[1]!) : null;
    return m ? { effort, id: `${effort}/${m[1]}`, layoutKind: 'element' } : null;
  }
  if (parts.length === 2 && parts[1] === 'map.md') return { effort, id: `${effort}/map`, layoutKind: 'map' };
  if (parts.length === 2 && parts[1] === 'spec.md') return { effort, id: `${effort}/spec`, layoutKind: 'spec' };
  if (parts.length === 3 && parts[1] === 'tickets') {
    const m = /^(\d+)(?:-.*)?\.md$/.exec(parts[2]!);
    if (m) return { effort, id: `${effort}/${pad(Number(m[1]))}`, layoutKind: 'ticket', number: Number(m[1]) };
  }
  return null;
}

/**
 * The path decides the item's identity, the frontmatter its kind. When they disagree (a `kind: spec` file under
 * `tickets/`, say) the entry is invalid, so tools that need a `ticket` never see it. The shared store result is
 * untouched: only this path's entry carries the invalid view.
 */
function disagreesWithLayout(parse: ParseResult, layoutKind: LayoutKind): ParseResult {
  if (!parse.ok) return parse;
  if (layoutKind === 'element' ? isElementKind(parse.fields.kind) : parse.fields.kind === layoutKind) return parse;
  const where = layoutKind === 'ticket' ? 'under tickets/' : layoutKind === 'element' ? 'under architecture/' : `as ${layoutKind}.md`;
  const want = layoutKind === 'element' ? 'container or component' : layoutKind;
  return {
    ok: false,
    hash: parse.hash,
    bom: parse.bom,
    eol: parse.eol,
    text: parse.text,
    error: `the file is ${where} but its frontmatter says "kind: ${parse.fields.kind}"; set kind to ${want} or move the file`,
  };
}

/** Full Item IDs of an entry's `blocked_by`: same-effort numbers are resolved against the entry's effort. */
export function resolveBlockers(e: IndexEntry): string[] {
  if (!e.parse.ok) return [];
  return e.parse.fields.blockedBy.map((b) => {
    if (typeof b === 'number') return `${e.effort}/${pad(b)}`;
    return /^\d+$/.test(b) ? `${e.effort}/${pad(Number(b))}` : normalizeId(b);
  });
}

const kindRank = (e: IndexEntry): number => (e.layoutKind === 'map' ? -2 : e.layoutKind === 'spec' ? -1 : (e.number ?? 0)); // elements have no number: they sort by path

function compareEntries(a: IndexEntry, b: IndexEntry): number {
  if (a.effort !== b.effort) return a.effort < b.effort ? -1 : 1;
  const r = kindRank(a) - kindRank(b);
  if (r !== 0) return r;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export interface IndexOptions {
  log: Logger;
  now?: () => number;
  /** Test seam: awaited at the start of every scan (e.g. to hold the initial scan open). */
  beforeScan?: () => Promise<void>;
}

export interface ScanStats {
  files: number;
  added: number;
  changed: number;
  removed: number;
  durationMs: number;
}

export class WorkspaceIndex {
  readonly root: string;
  private state_: 'indexing' | 'ready' = 'indexing';
  private version = 0;
  private readonly byPath = new Map<string, IndexEntry>();
  private readonly byId = new Map<string, IndexEntry[]>();
  private resolveReady!: () => void;
  /** Resolves when the first full scan has finished. */
  readonly ready: Promise<void> = new Promise((r) => (this.resolveReady = r));
  private readonly now: () => number;

  constructor(
    root: string,
    private readonly store: ParsedItemStore,
    private readonly opts: IndexOptions,
  ) {
    this.root = root;
    this.now = opts.now ?? Date.now;
  }

  get state(): 'indexing' | 'ready' {
    return this.state_;
  }

  /** Bumped on every change to the model; list cursors are only valid for the version that issued them. */
  get modelVersion(): number {
    return this.version;
  }

  get size(): number {
    return this.byPath.size;
  }

  // ---- mutation -------------------------------------------------------------------------------------------

  /**
   * Records the bytes of one file (workspace-relative path). Files outside the layout are ignored (returns
   * null). Identical bytes are a no-op. Returns whether the model changed.
   */
  upsertFile(relPath: string, bytes: Uint8Array): boolean | null {
    const ident = identify(relPath.replace(/^\.tasklog\//, ''));
    if (!ident) return null;
    const p = relPath.startsWith(`${TASKLOG_DIR}/`) ? relPath : `${TASKLOG_DIR}/${relPath}`;
    const old = this.byPath.get(p);
    const stored = this.store.acquire(bytes);
    const parse = disagreesWithLayout(stored, ident.layoutKind);
    if (old && old.hash === stored.hash) {
      this.store.release(stored.hash); // already held by `old`
      return false;
    }
    const entry: IndexEntry = { path: p, ...ident, hash: stored.hash, parse, since: this.now() };
    if (!parse.ok && old) entry.lastGoodHash = old.parse.ok ? old.hash : old.lastGoodHash;
    if (old) this.detach(old);
    this.attach(entry);
    this.version++;
    this.logTransition(old, entry);
    return true;
  }

  /** Forgets one file. Returns whether it was indexed. */
  removeFile(relPath: string): boolean {
    const p = relPath.startsWith(`${TASKLOG_DIR}/`) ? relPath : `${TASKLOG_DIR}/${relPath}`;
    const old = this.byPath.get(p);
    if (!old) return false;
    this.detach(old);
    this.version++;
    this.logTransition(old, undefined);
    return true;
  }

  private attach(e: IndexEntry): void {
    this.byPath.set(e.path, e);
    const list = this.byId.get(e.id);
    if (list) list.push(e);
    else this.byId.set(e.id, [e]);
  }

  private detach(e: IndexEntry): void {
    this.byPath.delete(e.path);
    const list = this.byId.get(e.id);
    if (list) {
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byId.delete(e.id);
    }
    this.store.release(e.hash);
  }

  private logTransition(old: IndexEntry | undefined, next: IndexEntry | undefined): void {
    const { log } = this.opts;
    const w = this.root;
    if (next && !next.parse.ok) log.warn('item.invalid', { workspace: w, id: next.id, path: next.path, error: next.parse.error });
    else if (old && !old.parse.ok) log.info('item.valid', { workspace: w, id: old.id, path: old.path });
    if (next && (this.byId.get(next.id)?.length ?? 0) > 1) log.warn('item.conflicted', { workspace: w, id: next.id });
  }

  /**
   * Full scan of `.tasklog/`, diffed by hash against the current model: new files are added, changed ones
   * re-parsed, vanished ones removed. The first scan flips the workspace to `ready`. Never throws.
   */
  async scan(reason = 'initial'): Promise<ScanStats> {
    const { log } = this.opts;
    const t0 = this.now();
    log.info('scan.start', { workspace: this.root, reason });
    const stats: ScanStats = { files: 0, added: 0, changed: 0, removed: 0, durationMs: 0 };
    try {
      await this.opts.beforeScan?.();
      const found = await listItemFiles(path.join(this.root, TASKLOG_DIR));
      const seen = new Set<string>();
      for (let i = 0; i < found.length; i += 32) {
        const batch = found.slice(i, i + 32);
        const read = await Promise.all(
          batch.map(async (f) => {
            try {
              return { f, bytes: await fs.promises.readFile(path.join(this.root, TASKLOG_DIR, ...f.split('/'))) };
            } catch (e) {
              log.warn('scan.read_failed', { workspace: this.root, path: f, error: (e as Error).message });
              // A file that exists but cannot be read right now (EBUSY/EPERM) keeps its indexed entry; only ENOENT means gone.
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') seen.add(`${TASKLOG_DIR}/${f}`);
              return null;
            }
          }),
        );
        for (const r of read) {
          if (!r) continue;
          const rel = `${TASKLOG_DIR}/${r.f}`;
          seen.add(rel);
          stats.files++;
          const existed = this.byPath.has(rel);
          const changed = this.upsertFile(rel, r.bytes);
          if (changed) existed ? stats.changed++ : stats.added++;
        }
      }
      for (const p of [...this.byPath.keys()]) {
        if (!seen.has(p)) {
          this.removeFile(p);
          stats.removed++;
        }
      }
    } catch (e) {
      log.error('scan.failed', { workspace: this.root, reason, error: (e as Error).message });
    }
    stats.durationMs = this.now() - t0;
    if (this.state_ !== 'ready') {
      this.state_ = 'ready';
      this.resolveReady();
    }
    log.info('scan.finished', { workspace: this.root, reason, ...stats, items: this.byPath.size, invalid: this.counts().invalid, conflicted: this.counts().conflicted });
    return stats;
  }

  /** Releases every store reference. The index is unusable afterwards. */
  dispose(): void {
    for (const e of [...this.byPath.values()]) this.detach(e);
    this.version++;
  }

  // ---- reads ----------------------------------------------------------------------------------------------

  entries(): IndexEntry[] {
    return [...this.byPath.values()].sort(compareEntries);
  }

  entryByPath(relPath: string): IndexEntry | undefined {
    return this.byPath.get(relPath);
  }

  /** Every entry (more than one when conflicted) for an Item ID. */
  entriesForId(id: string): IndexEntry[] {
    return [...(this.byId.get(normalizeId(id)) ?? [])];
  }

  private isConflicted(e: IndexEntry): boolean {
    return (this.byId.get(e.id)?.length ?? 0) > 1;
  }

  private flagsOf(e: IndexEntry): ItemFlag[] {
    const f: ItemFlag[] = [];
    if (!e.parse.ok) f.push('invalid');
    if (this.isConflicted(e)) f.push('conflicted');
    if (this.danglingSlugs(e).length > 0) f.push('dangling');
    return f;
  }

  /**
   * Looks up one item by ID. Errors: `not_found`; `conflicted` (details list every path); `invalid_item`
   * (details carry path and parse error). Returns the model's parse result, so reads never touch the disk.
   */
  get(id: string): ItemView {
    const norm = normalizeId(id);
    const list = this.byId.get(norm) ?? [];
    if (list.length === 0) {
      throw new TaskLogError('not_found', { message: `No item "${id}"; check the Item ID with list_items.`, details: { id } });
    }
    if (list.length > 1) {
      const paths = list.map((e) => e.path).sort();
      throw new TaskLogError('conflicted', {
        message: `Item ID "${norm}" is claimed by ${paths.length} files (${paths.join(', ')}); resolve the duplicate on disk.`,
        details: { id: norm, paths },
      });
    }
    const e = list[0]!;
    if (!e.parse.ok) {
      throw new TaskLogError('invalid_item', {
        message: `Item "${norm}" (${e.path}) does not parse: ${e.parse.error}; fix it on disk.`,
        details: { id: norm, path: e.path, error: e.parse.error },
      });
    }
    const p = e.parse;
    const fm: Record<string, FmValue> = {};
    for (const entry of p.entries) fm[entry.key] = entry.value;
    return {
      id: e.id,
      path: e.path,
      hash: e.hash,
      frontmatter: fm,
      body: p.body,
      acs: p.acs.map((a) => ({ n: a.n, text: a.text, checked: a.checked })),
      flags: [],
      parse: p,
    };
  }

  /** Slugs in a ticket's `components` that name no element file. Dangling names are warnings, never invalid tickets. */
  private danglingSlugs(e: IndexEntry): string[] {
    if (!e.parse.ok || e.layoutKind !== 'ticket') return [];
    return (e.parse.fields.components ?? []).filter((slug) => !this.byPath.has(`${TASKLOG_DIR}/${ARCHITECTURE_DIR}/${slug}.md`));
  }

  /** Every (ticket, slug) pair whose element does not exist, in ticket order. */
  danglingComponents(): DanglingComponent[] {
    const out: DanglingComponent[] = [];
    for (const e of this.entries()) for (const slug of this.danglingSlugs(e)) out.push({ id: e.id, slug });
    return out;
  }

  /** Element counts for `workspace_status`; invalid element files are reported under `problems` instead. */
  architectureCounts(): ArchitectureCounts {
    const c: ArchitectureCounts = { containers: 0, components: 0, proposed: 0, accepted: 0, warnings: this.danglingComponents().length };
    for (const e of this.byPath.values()) {
      if (e.layoutKind !== 'element' || !e.parse.ok) continue;
      const f = e.parse.fields;
      if (f.kind === 'container') c.containers++;
      else c.components++;
      if (f.review === 'accepted') c.accepted++;
      else c.proposed++;
    }
    return c;
  }

  private toListed(e: IndexEntry, fallbackKind?: Kind): ListedItem {
    const flags = this.flagsOf(e);
    if (!e.parse.ok) {
      return {
        id: e.id,
        title: e.path.split('/').pop() ?? e.path,
        kind: e.layoutKind === 'element' ? (fallbackKind ?? 'component') : e.layoutKind,
        status: null,
        type: null,
        tags: [],
        claimed_by: null,
        blocked_by: [],
        hash: e.hash,
        flags,
        path: e.path,
        matched_in: [],
        error: e.parse.error,
      };
    }
    const f = e.parse.fields;
    return {
      id: e.id,
      title: f.title,
      kind: f.kind,
      status: f.status ?? null,
      type: f.type ?? null,
      tags: f.tags,
      claimed_by: f.claimedBy ?? null,
      blocked_by: resolveBlockers(e),
      hash: e.hash,
      flags,
      path: e.path,
      matched_in: [],
    };
  }

  /**
   * Structured listing: filters AND together; order is effort, then map, spec, tickets by number. Invalid
   * items match only `effort` and `kind` (taken from their path) and `tags_none`; they carry flag `invalid`.
   * Paging: `limit` default 50, capped at 200; `cursor` is only valid for the model version that issued it
   * (`stale_cursor` otherwise).
   */
  list(q: ListQuery = {}): ListResult {
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const lc = (xs?: string[]) => (xs ?? []).map((t) => t.toLowerCase());
    const all = lc(q.tags_all);
    const any = lc(q.tags_any);
    const none = lc(q.tags_none);
    for (const [k, allowed] of [['kind', KINDS], ['status', STATUSES], ['type', TYPES]] as const) {
      const v = q[k];
      if (v !== undefined && !(allowed as readonly string[]).includes(v)) {
        throw new TaskLogError('bad_request', { message: `"${k}" must be one of ${allowed.join(', ')}; got "${v}".` });
      }
    }
    const query = q.text !== undefined ? parseQuery(q.text) : undefined;
    const textQuery = query && !query.empty ? query : undefined;
    const comps = lc(q.components);
    const filterKey = JSON.stringify([q.effort, q.kind, q.status, q.type, all, any, none, q.text ?? null, comps]);

    let offset = 0;
    if (q.cursor !== undefined) {
      let c: { v: number; o: number; k: string };
      try {
        c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
        if (typeof c.v !== 'number' || typeof c.o !== 'number' || typeof c.k !== 'string' || c.o < 0) throw new Error('shape');
      } catch {
        throw new TaskLogError('bad_request', { message: 'The cursor is not valid; use the cursor from a previous list_items result.' });
      }
      if (c.v !== this.version) throw new TaskLogError('stale_cursor', { details: { issued_for: c.v, current: this.version } });
      if (c.k !== filterKey) throw new TaskLogError('bad_request', { message: 'The cursor belongs to different filters; repeat the same filters or start without a cursor.' });
      offset = c.o;
    }

    const matches: IndexEntry[] = [];
    const textMatch = new Map<IndexEntry, { score: number; matched_in: SearchField[] }>();
    for (const e of this.entries()) {
      if (q.effort !== undefined && e.effort !== q.effort) continue;
      const f = e.parse.ok ? e.parse.fields : null;
      if (e.layoutKind === 'element') {
        // Elements are hidden unless a container or component kind is asked for.
        if (!isElementKind(q.kind) || (f && f.kind !== q.kind)) continue;
      } else if (q.kind !== undefined && (f?.kind ?? e.layoutKind) !== q.kind) continue;
      if (comps.length && !comps.some((c) => f?.components?.includes(c))) continue;
      if (q.status !== undefined && f?.status !== q.status) continue;
      if (q.type !== undefined && f?.type !== q.type) continue;
      const tags = f?.tags ?? [];
      if (all.length && !all.every((t) => tags.includes(t))) continue;
      if (any.length && !any.some((t) => tags.includes(t))) continue;
      if (none.length && none.some((t) => tags.includes(t))) continue;
      if (textQuery) {
        const m = matchItem(textQuery, this.store.search(e.hash), e.id);
        if (!m) continue;
        textMatch.set(e, m);
      }
      matches.push(e);
    }
    // Best score first; the sort is stable, so ties keep effort-then-ticket-number order.
    if (textQuery) matches.sort((a, b) => textMatch.get(b)!.score - textMatch.get(a)!.score);
    const page = matches.slice(offset, offset + limit);
    const next = offset + limit;
    const items = page.map((e) => {
      const row = this.toListed(e, q.kind);
      const m = textMatch.get(e);
      if (m) {
        row.matched_in = m.matched_in;
        if (q.snippet && e.parse.ok) row.snippet = makeSnippet(textQuery!, e.parse.fields.title, e.parse.body);
      }
      return row;
    });
    const result: ListResult = { items, total: matches.length };
    if (next < matches.length) {
      result.cursor = Buffer.from(JSON.stringify({ v: this.version, o: next, k: filterKey })).toString('base64url');
    }
    return result;
  }

  counts(): Counts {
    const by_kind: Record<string, number> = {};
    const by_status: Record<string, number> = {};
    const efforts = new Set<string>();
    let invalid = 0;
    let elements = 0;
    for (const e of this.byPath.values()) {
      if (e.layoutKind === 'element') {
        // Elements are not part of any effort: architectureCounts() counts them; only their parse errors count here.
        elements++;
        if (!e.parse.ok) invalid++;
        continue;
      }
      efforts.add(e.effort);
      by_kind[e.layoutKind] = (by_kind[e.layoutKind] ?? 0) + 1;
      if (e.parse.ok && e.parse.fields.status) by_status[e.parse.fields.status] = (by_status[e.parse.fields.status] ?? 0) + 1;
      else if (!e.parse.ok) invalid++;
    }
    let conflicted = 0;
    for (const list of this.byId.values()) if (list.length > 1) conflicted++;
    return { items: this.byPath.size - elements, invalid, conflicted, efforts: efforts.size, by_kind, by_status };
  }

  /** Current invalid and conflicted items (ticket 11 extends this into `workspace_status.problems[]`). */
  problems(): Problem[] {
    const out: Problem[] = [];
    for (const e of this.entries()) {
      if (!e.parse.ok) out.push({ type: 'invalid', id: e.id, path: e.path, paths: [e.path], error: e.parse.error, since: new Date(e.since).toISOString() });
    }
    for (const [id, list] of [...this.byId.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (list.length > 1) {
        out.push({
          type: 'conflicted',
          id,
          path: list.map((e) => e.path).sort()[0]!,
          paths: list.map((e) => e.path).sort(),
          error: `${id} is claimed by ${list.length} files; resolve the duplicate on disk.`,
          since: new Date(Math.max(...list.map((e) => e.since))).toISOString(),
        });
      }
    }
    return out;
  }
}

/** Lists item files under `.tasklog/` relative to it (forward slashes): `E/map.md`, `E/spec.md`, `E/tickets/NN-x.md`. */
async function listItemFiles(tasklogDir: string): Promise<string[]> {
  const out: string[] = [];
  const readdir = async (dir: string) => {
    try {
      return await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const eff of await readdir(tasklogDir)) {
    if (!eff.isDirectory() || eff.isSymbolicLink() || eff.name.startsWith('.')) continue;
    if (eff.name === ARCHITECTURE_DIR) {
      // Elements are flat: `architecture/<slug>.md`. Nothing else here is an item (the `ignore` file is not markdown).
      for (const f of await readdir(path.join(tasklogDir, eff.name))) if (f.isFile() && identify(`${eff.name}/${f.name}`)) out.push(`${eff.name}/${f.name}`);
      continue;
    }
    for (const f of await readdir(path.join(tasklogDir, eff.name))) {
      if (f.isFile() && (f.name === 'map.md' || f.name === 'spec.md')) out.push(`${eff.name}/${f.name}`);
      else if (f.isDirectory() && !f.isSymbolicLink() && f.name === 'tickets') {
        for (const t of await readdir(path.join(tasklogDir, eff.name, 'tickets'))) {
          if (t.isFile() && identify(`${eff.name}/tickets/${t.name}`)) out.push(`${eff.name}/tickets/${t.name}`);
        }
      }
    }
  }
  return out.sort();
}
