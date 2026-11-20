// Scan apply (slice 5): lists the workspace files, runs the pure detect + plan, and applies the plan with
// hashed per-element writes through the normal write path. No tool registration here: `architecture-tools.ts`
// registers `scan_architecture` and calls `scanArchitecture`; the `architecture` drift calls `computeScan`.
//
// Write safety (spec "Match and merge"): read every element with its hash once, compute the whole plan in
// memory, then write per element with that element's hash. A stale hash is skipped ("changed during scan"),
// never retried or overwritten. The scan is not transactional and a rerun is idempotent.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { detect } from '../architecture/detect.ts';
import { isManifestPath } from '../architecture/manifests.ts';
import { isUnder } from '../architecture/paths.ts';
import { plan, type PlanInput } from '../architecture/plan.ts';
import type { Candidate, Element, IgnoredReason, Plan, Use } from '../architecture/types.ts';
import { isTaskLogError } from '../errors.ts';
import { isoDate } from '../model/create.ts';
import { renderString } from '../model/edit.ts';
import { ARCHITECTURE_DIR, TASKLOG_DIR, type WorkspaceIndex } from '../model/index.ts';
import type { ModelManager } from './models.ts';
import type { WriteService } from './writes.ts';

const execFileP = promisify(execFile);

/** Directories skipped outside a git repo (inside one, git decides). `.tasklog` is always skipped. */
export const BUILTIN_IGNORE = ['.git', 'node_modules', 'dist', 'bin', 'obj', 'target', 'vendor', '.tasklog'];
const IGNORE_FILE = `${TASKLOG_DIR}/${ARCHITECTURE_DIR}/ignore`;
const IGNORED_REASONS: IgnoredReason[] = ['test', 'fixture-template', 'tooling', 'user', 'not-workspace-member'];

// ---- file listing ----------------------------------------------------------------------------------------

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const opts = { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true };
    const inside = await execFileP('git', ['rev-parse', '--is-inside-work-tree'], opts);
    if (inside.stdout.trim() !== 'true') return null;
    const split = (s: string) => s.split('\0').filter((x) => x !== '');
    const all = await execFileP('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], opts);
    const deleted = new Set(split((await execFileP('git', ['ls-files', '-z', '--deleted'], opts)).stdout));
    return split(all.stdout).filter((f) => !deleted.has(f));
  } catch {
    return null; // git missing or not a repository
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(BUILTIN_IGNORE);
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, ...(rel === '' ? [] : rel.split('/'))), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (!skip.has(d.name)) await walk(r);
      } else if (d.isFile()) out.push(r);
    }
  };
  await walk('');
  return out;
}

/** Git-tracked plus untracked-not-ignored files in a git repository, otherwise the built-in ignore list. Sorted, forward slashes. */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const listed = (await gitFiles(root)) ?? (await walkFiles(root));
  return listed
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f !== TASKLOG_DIR && !f.startsWith(`${TASKLOG_DIR}/`))
    .sort();
}

async function readUserIgnore(root: string): Promise<string[]> {
  try {
    return (await fs.promises.readFile(path.join(root, ...IGNORE_FILE.split('/')), 'utf8')).split(/\r?\n/);
  } catch {
    return [];
  }
}

// ---- compute ---------------------------------------------------------------------------------------------

export interface ScanComputation {
  plan: Plan;
  /** Existing valid elements as the planner saw them. */
  existing: Element[];
  /** Content hash of each existing element file, by slug, read in the same pass. */
  hashes: Map<string, string>;
  /** Every slug with an element file in the index, valid or not (new slugs must avoid them). */
  occupied: Set<string>;
  files: string[];
  /** Detection candidates, as proposed before matching. */
  detected: Candidate[];
}

const slugOfId = (id: string): string => id.slice(id.indexOf('/') + 1);

function readElements(idx: WorkspaceIndex): { existing: Element[]; hashes: Map<string, string>; occupied: Set<string> } {
  const existing: Element[] = [];
  const hashes = new Map<string, string>();
  const occupied = new Set<string>();
  for (const e of idx.entries()) {
    if (e.layoutKind !== 'element') continue;
    const slug = slugOfId(e.id);
    occupied.add(slug);
    if (!e.parse.ok) continue;
    const f = e.parse.fields;
    existing.push({
      slug,
      kind: f.kind as Element['kind'],
      title: f.title,
      review: f.review ?? 'proposed',
      ...(f.parent !== undefined ? { parent: f.parent } : {}),
      uses: (f.uses ?? []).map((u): Use => ({ ...u })),
      code: [...(f.code ?? [])],
    });
    hashes.set(slug, e.hash);
  }
  return { existing, hashes, occupied };
}

/**
 * Catches the model up with the element files on disk (hand edits and hand deletions the watcher may not have
 * reported yet), so the plan and the hashes it carries describe what is really there.
 */
async function syncElements(idx: WorkspaceIndex, root: string): Promise<void> {
  const dir = path.join(root, TASKLOG_DIR, ARCHITECTURE_DIR);
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
  } catch {
    /* no architecture directory yet */
  }
  const onDisk = new Set<string>();
  for (const n of names) {
    const rel = `${TASKLOG_DIR}/${ARCHITECTURE_DIR}/${n}`;
    try {
      idx.upsertFile(rel, await fs.promises.readFile(path.join(dir, n)));
      onDisk.add(rel);
    } catch {
      /* vanished meanwhile: treated as gone */
    }
  }
  for (const e of idx.entries()) {
    if (e.layoutKind === 'element' && !onDisk.has(e.path) && !fs.existsSync(path.join(root, ...e.path.split('/')))) idx.removeFile(e.path);
  }
}

/** Runs file listing, detection and planning read-only. Shared by `scan_architecture` and the `architecture` drift. */
export async function computeScan(models: ModelManager, root: string): Promise<ScanComputation> {
  const idx = await models.ready(root);
  await syncElements(idx, root);
  const { existing, hashes, occupied } = readElements(idx);
  const files = await listWorkspaceFiles(root);
  const manifests: Record<string, string> = {};
  await Promise.all(
    files.filter(isManifestPath).map(async (f) => {
      try {
        manifests[f] = await fs.promises.readFile(path.join(root, ...f.split('/')), 'utf8');
      } catch {
        /* unreadable: detect treats a missing entry as unreadable */
      }
    }),
  );
  const detection = detect({ files, manifests });
  const input: PlanInput = {
    existing,
    candidates: detection.candidates,
    files,
    ignored: detection.ignored,
    unowned: detection.unowned,
    userIgnore: await readUserIgnore(root),
  };
  return { plan: plan(input), existing, hashes, occupied, files, detected: detection.candidates };
}

// ---- result ----------------------------------------------------------------------------------------------

export interface ScanResult {
  dry_run: boolean;
  created: { id: string; kind: string; title: string; parent?: string; code: string[] }[];
  updated: { id: string; added: string[]; removed: string[] }[];
  unchanged: number;
  skipped: { id: string; reason: string }[];
  findings: { category: string; id?: string; path?: string; detail: string }[];
  ignored: Record<IgnoredReason, { count: number; paths: string[] }>;
}

export const SKIPPED_REASON = 'changed during scan';

/** New files use LF and canonical key order; Description and Responsibilities are written empty. */
export function renderElement(e: { kind: string; title: string; review: string; parent?: string; uses?: Use[]; code: string[] }, date: string): string {
  const lines = ['---', `kind: ${e.kind}`, `title: ${renderString(e.title, 'plain')}`, `review: ${e.review}`];
  if (e.parent !== undefined) lines.push(`parent: ${renderString(e.parent, 'plain')}`);
  if (e.uses && e.uses.length > 0) {
    lines.push('uses:');
    for (const u of e.uses) {
      lines.push(`  - to: ${renderString(u.to, 'plain')}`);
      if (u.label !== undefined) lines.push(`    label: ${renderString(u.label, 'plain')}`);
    }
  }
  lines.push('code:', ...e.code.map((c) => `  - ${renderString(c, 'plain')}`));
  lines.push(`created: ${date}`, `updated: ${date}`, '---', '', '## Description', '', '## Responsibilities', '');
  return lines.join('\n');
}

/** The element (by longest root) that owns most of a candidate's files, to resolve a matched candidate's slug. */
function matchedSlug(c: Candidate, existing: Element[]): string | undefined {
  const tally = new Map<string, number>();
  for (const f of c.files) {
    let best = -1;
    let owner: string | undefined;
    for (const e of existing) {
      if (e.kind !== c.kind) continue;
      for (const r of e.code) {
        if (!isUnder(f, r)) continue;
        const len = r === '.' ? 0 : r.length;
        if (len > best) {
          best = len;
          owner = e.slug;
        }
      }
    }
    if (owner) tally.set(owner, (tally.get(owner) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function toResult(comp: ScanComputation, dryRun: boolean): {
  result: ScanResult;
  toCreate: { id: string; slug: string; body: Candidate; text: (date: string) => string }[];
} {
  const { plan: p, existing, occupied } = comp;
  const taken = new Set(occupied);
  // Final slugs: a candidate whose slug collides with an unrelated existing element gets a numeric suffix.
  const finalSlug = new Map<string, string>(); // `kind:slug` of a created candidate -> its final slug
  const ordered = [...p.created].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'container' ? -1 : 1));
  for (const c of ordered) {
    let s = c.slug;
    for (let n = 2; taken.has(s); n++) s = `${c.slug}-${n}`;
    taken.add(s);
    finalSlug.set(`${c.kind}:${c.slug}`, s);
  }
  // A parent or uses target naming a created candidate gets its final slug; one that matched an existing element resolves to it.
  const resolveRef = (slug: string): string => {
    const f = finalSlug.get(`container:${slug}`);
    if (f !== undefined) return f;
    const c = comp.detected.find((x) => x.slug === slug && x.kind === 'container');
    return (c && matchedSlug(c, existing)) ?? slug;
  };

  const toCreate = ordered.map((c) => {
    const slug = finalSlug.get(`${c.kind}:${c.slug}`)!;
    const parent = c.parent === undefined ? undefined : resolveRef(c.parent);
    const uses = c.uses.map((u) => ({ ...u, to: resolveRef(u.to) }));
    return {
      id: `${ARCHITECTURE_DIR}/${slug}`,
      slug,
      body: { ...c, parent, uses } as Candidate,
      text: (date: string) => renderElement({ kind: c.kind, title: c.title, review: 'proposed', parent, uses, code: c.code }, date),
    };
  });

  const byReason = Object.fromEntries(IGNORED_REASONS.map((r) => [r, { count: 0, paths: [] as string[] }])) as ScanResult['ignored'];
  for (const i of p.ignored) {
    byReason[i.reason].count++;
    byReason[i.reason].paths.push(i.path);
  }
  const result: ScanResult = {
    dry_run: dryRun,
    created: toCreate.map(({ id, body }) => ({
      id,
      kind: body.kind,
      title: body.title,
      ...(body.parent !== undefined ? { parent: body.parent } : {}),
      code: body.code,
    })),
    updated: p.updated.map((u) => {
      const old = existing.find((e) => e.slug === u.slug)!.code;
      return {
        id: `${ARCHITECTURE_DIR}/${u.slug}`,
        added: u.code.filter((c) => !old.includes(c)),
        removed: old.filter((c) => !u.code.includes(c)),
      };
    }),
    unchanged: p.unchanged.length,
    skipped: [],
    findings: p.findings.map((f) => ({
      category: f.category,
      ...(f.element !== undefined ? { id: `${ARCHITECTURE_DIR}/${f.element}` } : {}),
      ...(f.path !== undefined ? { path: f.path } : {}),
      detail: f.message,
    })),
    ignored: byReason,
  };
  return { result, toCreate };
}

// ---- apply -----------------------------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/** Serialises writing scans per workspace, so racing scans see each other's elements instead of duplicating them. */
function exclusive<T>(root: string, job: () => Promise<T>): Promise<T> {
  const prev = locks.get(root) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => undefined);
  locks.set(root, tail);
  void tail.then(() => {
    if (locks.get(root) === tail) locks.delete(root);
  });
  return next;
}

export interface ScanDeps {
  models: ModelManager;
  writes: WriteService;
}

export async function scanArchitecture(deps: ScanDeps, root: string, dryRun = false): Promise<ScanResult> {
  const run = async (): Promise<ScanResult> => {
    const comp = await computeScan(deps.models, root);
    const { result, toCreate } = toResult(comp, dryRun);
    if (dryRun) return result;
    const date = isoDate(deps.writes.now());

    // Updates: only `code`, with the hash read at the start. A stale hash (or a vanished file) is skipped.
    const updatedOk = new Set<string>();
    for (const u of comp.plan.updated) {
      const id = `${ARCHITECTURE_DIR}/${u.slug}`;
      try {
        await deps.writes.edit(root, id, comp.hashes.get(u.slug)!, { op: 'set_fields', code: u.code });
        updatedOk.add(id);
      } catch (e) {
        if (isTaskLogError(e) && (e.code === 'stale_hash' || e.code === 'not_found')) result.skipped.push({ id, reason: SKIPPED_REASON });
        else throw e;
      }
    }
    result.updated = result.updated.filter((u) => updatedOk.has(u.id));

    // Creates: exclusive, so a slug someone else created meanwhile is theirs and ours is skipped.
    const createdOk = new Set<string>();
    for (const c of toCreate) {
      try {
        await deps.writes.createElementFile(root, c.slug, c.text(date));
        createdOk.add(c.id);
      } catch (e) {
        if (isTaskLogError(e) && e.code === 'bad_request' && (e.details as { exists?: boolean } | undefined)?.exists) {
          result.skipped.push({ id: c.id, reason: SKIPPED_REASON });
        } else throw e;
      }
    }
    result.created = result.created.filter((c) => createdOk.has(c.id));
    return result;
  };
  return dryRun ? run() : exclusive(root, run);
}
