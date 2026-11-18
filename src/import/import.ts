// `tasklog import` (spec section 9): detect the source layout, map everything onto the native format,
// validate the result with the real parser, stage it, and move it into `.tasklog/` in one step.
// Runs in-process (no daemon) and never touches the source tree.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseItem } from '../model/parse.ts';
import { isBacklogDir, loadBacklog } from './backlog.ts';
import { loadScratch } from './scratch.ts';
import type { Candidate, LoadResult, Warning } from './types.ts';
import { yamlStr } from './yaml.ts';

export class ImportUsageError extends Error {}

export interface ImportOptions {
  /** The path given on the command line (absolute, or relative to `cwd`). */
  path: string;
  cwd: string;
  dryRun?: boolean;
  /** Force everything into this effort. */
  effort?: string;
  groupBy?: 'milestone' | 'none';
}

export interface ImportReport {
  layout: 'backlog' | 'scratch' | 'backlog+scratch';
  /** Workspace root the `.tasklog/` directory belongs to. */
  workspace: string;
  dry_run: boolean;
  efforts: string[];
  imported: Array<{ source: string; id: string; path: string }>;
  /** Items skipped because they were imported on an earlier run (left untouched). */
  already_imported: Array<{ source: string; id: string }>;
  /** Source files that could not be imported. Any entry here makes the command exit 1. */
  skipped: Array<{ source: string; reason: string }>;
  /** Source files intentionally left out (backlog docs, decisions, milestones). Not a failure. */
  not_imported: Array<{ path: string; reason: string }>;
  warnings: Warning[];
}

interface Source {
  layout: 'backlog' | 'scratch';
  dir: string;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function detectSources(p: string): { root: string; sources: Source[] } {
  if (!isDir(p)) throw new ImportUsageError(`${p} is not a directory`);
  const sources: Source[] = [];
  let root = p;
  if (isBacklogDir(p)) {
    root = path.dirname(p);
    sources.push({ layout: 'backlog', dir: p });
  } else if (path.basename(p) === '.scratch') {
    root = path.dirname(p);
    sources.push({ layout: 'scratch', dir: p });
  } else if (path.basename(path.dirname(p)) === '.scratch') {
    root = path.dirname(path.dirname(p));
    sources.push({ layout: 'scratch', dir: p });
  } else {
    if (isBacklogDir(path.join(p, 'backlog'))) sources.push({ layout: 'backlog', dir: path.join(p, 'backlog') });
    if (isDir(path.join(p, '.scratch'))) sources.push({ layout: 'scratch', dir: path.join(p, '.scratch') });
  }
  if (sources.length === 0) {
    throw new ImportUsageError(`no backlog layout (backlog/config.yml) or scratch layout (.scratch/<effort>/) found at ${p}`);
  }
  return { root, sources };
}

const pad = (n: number): string => String(n).padStart(2, '0');

interface Existing {
  importedFrom: Map<string, { effort: string; num: number | null }>;
  numbers: Map<string, Set<number>>;
  files: Set<string>;
  efforts: Set<string>;
  foreign: Set<string>;
}

function scanTarget(target: string): Existing {
  const ex: Existing = { importedFrom: new Map(), numbers: new Map(), files: new Set(), efforts: new Set(), foreign: new Set() };
  if (!isDir(target)) return ex;
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const effort = e.name;
    ex.efforts.add(effort);
    ex.numbers.set(effort, new Set());
    const consider = (file: string, relName: string, num: number | null) => {
      ex.files.add(`${effort}/${relName}`);
      if (num !== null) ex.numbers.get(effort)!.add(num);
      let from: string | undefined;
      try {
        const r = parseItem(fs.readFileSync(file));
        if (r.ok && typeof r.extra.imported_from === 'string') from = r.extra.imported_from;
      } catch {
        /* unreadable: counts as foreign */
      }
      if (from) ex.importedFrom.set(from, { effort, num });
      else ex.foreign.add(effort);
    };
    for (const k of ['map', 'spec']) {
      const f = path.join(target, effort, `${k}.md`);
      if (fs.existsSync(f)) consider(f, `${k}.md`, null);
    }
    const tdir = path.join(target, effort, 'tickets');
    if (isDir(tdir)) {
      for (const n of fs.readdirSync(tdir)) {
        const m = /^(\d+)(?:-.*)?\.md$/i.exec(n);
        if (m) consider(path.join(tdir, n), `tickets/${n}`, Number(m[1]));
      }
    }
  }
  return ex;
}

function render(c: Candidate, blocked: Array<number | string>): string {
  const fm: string[] = [`kind: ${c.kind}`, `title: ${yamlStr(c.title)}`, `status: ${c.status}`];
  if (c.type) fm.push(`type: ${c.type}`);
  if (c.claimedBy) fm.push(`claimed_by: ${yamlStr(c.claimedBy)}`);
  if (blocked.length > 0) fm.push(`blocked_by: [${blocked.map((b) => (typeof b === 'number' ? String(b) : JSON.stringify(b))).join(', ')}]`);
  if (c.tags.length > 0) fm.push('tags:', ...c.tags.map((t) => `  - ${t}`));
  fm.push(`created: ${c.created}`, `updated: ${c.updated}`, `imported_from: ${yamlStr(c.srcPath)}`, ...c.extras);
  return `---\n${fm.join('\n')}\n---\n${c.body ? `\n${c.body}\n` : ''}`;
}

export function runImport(opts: ImportOptions): ImportReport {
  const abs = path.resolve(opts.cwd, opts.path);
  const { root, sources } = detectSources(abs);
  const target = path.join(root, '.tasklog');

  const loads: LoadResult[] = [];
  const owner = new Map<Candidate, LoadResult>();
  for (const s of sources) {
    const l =
      s.layout === 'backlog'
        ? loadBacklog({ root, backlogDir: s.dir, effort: opts.effort, groupBy: opts.groupBy })
        : loadScratch({ root, scratchDir: s.dir, effort: opts.effort });
    loads.push(l);
    for (const c of l.candidates) owner.set(c, l);
  }
  const skipped = loads.flatMap((l) => l.skipped);
  const notImported = loads.flatMap((l) => l.notImported);
  const warnings: Warning[] = loads.flatMap((l) => l.warnings);
  const candidates = loads.flatMap((l) => l.candidates);

  const ex = scanTarget(target);
  const imported: ImportReport['imported'] = [];
  const already: ImportReport['already_imported'] = [];

  // Assign numbers. Items imported before keep their place; free requested numbers are claimed first, in source
  // order; everything left (collisions, subtasks) takes max+1, collisions before subtasks.
  const assigned = new Map<Candidate, number>();
  const taken = new Map<string, Set<number>>();
  const occupied = (effort: string): Set<number> => {
    let s = taken.get(effort);
    if (!s) {
      s = new Set(ex.numbers.get(effort) ?? []);
      taken.set(effort, s);
    }
    return s;
  };
  const isNew = new Set<Candidate>();
  for (const c of candidates) {
    const prev = ex.importedFrom.get(c.srcPath);
    if (prev) {
      if (c.kind === 'ticket' && prev.num !== null) assigned.set(c, prev.num);
      already.push({ source: c.srcPath, id: c.kind === 'ticket' ? `${prev.effort}/${pad(prev.num ?? 0)}` : `${prev.effort}/${c.kind}` });
      continue;
    }
    isNew.add(c);
  }
  const claimedFiles = new Set<string>();
  const dropMapSpec = new Set<Candidate>();
  const collided: Candidate[] = [];
  const subs: Candidate[] = [];
  for (const c of candidates) {
    if (!isNew.has(c)) continue;
    if (c.kind !== 'ticket') {
      const key = `${c.effort}/${c.kind}.md`;
      if (ex.files.has(key) || claimedFiles.has(key)) {
        dropMapSpec.add(c);
        warnings.push({
          kind: 'not_overwritten',
          source: c.srcPath,
          message: ex.files.has(key) ? `${c.effort}/${c.kind}.md already exists and is not from this source; not overwritten` : `${c.effort}/${c.kind}.md was already taken by another source; not imported`,
        });
      } else claimedFiles.add(key);
      continue;
    }
    if (c.fresh || c.wantNum === null) {
      subs.push(c);
      continue;
    }
    const occ = occupied(c.effort);
    if (occ.has(c.wantNum)) collided.push(c);
    else {
      occ.add(c.wantNum);
      assigned.set(c, c.wantNum);
    }
  }
  for (const c of [...collided, ...subs]) {
    const occ = occupied(c.effort);
    const n = Math.max(0, ...occ) + 1;
    occ.add(n);
    assigned.set(c, n);
    if (collided.includes(c)) {
      warnings.push({
        kind: 'id_collision',
        source: c.srcPath,
        message: `${c.label} wants number ${c.wantNum} in effort "${c.effort}" but it is taken; imported as ${c.effort}/${pad(n)}`,
      });
    }
  }
  for (const e of new Set(candidates.filter((c) => isNew.has(c) && !dropMapSpec.has(c)).map((c) => c.effort))) {
    if (ex.foreign.has(e)) {
      warnings.push({ kind: 'existing_effort', source: `.tasklog/${e}`, message: `effort "${e}" already has items that were not created by import; only missing items are added` });
    }
  }

  // Render and validate.
  const idOf = (c: Candidate): string => (c.kind === 'ticket' ? `${c.effort}/${pad(assigned.get(c)!)}` : `${c.effort}/${c.kind}`);
  const dest = (c: Candidate): string =>
    c.kind === 'ticket' ? `${c.effort}/tickets/${pad(assigned.get(c)!)}${c.slug ? `-${c.slug}` : ''}.md` : `${c.effort}/${c.kind}.md`;
  const rendered = new Map<string, string>();
  const dependencyTarget = (c: Candidate): Candidate | undefined => (assigned.has(c) ? c : undefined);
  for (const c of candidates) {
    if (!isNew.has(c) || dropMapSpec.has(c)) continue;
    if (c.kind === 'ticket' && !assigned.has(c)) continue;
    const blocked: Array<number | string> = [];
    for (const ref of c.refs) {
      const hit = owner.get(c)!.resolve(ref, c);
      if (hit === 'ambiguous') {
        warnings.push({ kind: 'ambiguous_dependency', source: c.srcPath, message: `${c.label}: dependency "${ref}" matches more than one task; dropped from blocked_by` });
        continue;
      }
      const t = hit && hit !== c ? dependencyTarget(hit) : undefined;
      if (!t) {
        if (hit !== c) warnings.push({ kind: 'dropped_dependency', source: c.srcPath, message: `${c.label}: dependency "${ref}" does not resolve to an imported task; dropped from blocked_by` });
        continue;
      }
      const v = t.effort === c.effort ? assigned.get(t)! : `${t.effort}/${pad(assigned.get(t)!)}`;
      if (!blocked.some((b) => b === v)) blocked.push(v);
    }
    const text = render(c, blocked);
    const parsed = parseItem(text);
    if (!parsed.ok) {
      skipped.push({ source: c.srcPath, reason: `the converted file does not parse: ${parsed.error}` });
      continue;
    }
    rendered.set(dest(c), text);
    imported.push({ source: c.srcPath, id: idOf(c), path: `.tasklog/${dest(c)}` });
  }

  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  imported.sort((a, b) => order(a.path, b.path));
  const efforts = [...new Set(imported.map((i) => i.id.split('/')[0]!))].sort();

  if (!opts.dryRun && rendered.size > 0) commit(target, rendered);

  const report: ImportReport = {
    layout: sources.length === 2 ? 'backlog+scratch' : sources[0]!.layout,
    workspace: root,
    dry_run: opts.dryRun === true,
    efforts,
    imported,
    already_imported: already,
    skipped,
    not_imported: notImported,
    warnings,
  };
  return report;
}

/** Writes everything into a staging directory inside `.tasklog/`, then moves it into place. */
function commit(target: string, files: Map<string, string>): void {
  fs.mkdirSync(target, { recursive: true });
  const stage = path.join(target, `.import-${process.pid}-${randomBytes(4).toString('hex')}`);
  const moved: string[] = [];
  const createdDirs: string[] = [];
  try {
    for (const [rel, text] of files) {
      const f = path.join(stage, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    for (const effort of fs.readdirSync(stage)) {
      const dir = path.join(target, effort);
      if (!fs.existsSync(dir)) {
        fs.renameSync(path.join(stage, effort), dir);
        createdDirs.push(dir);
        continue;
      }
      for (const [rel] of files) {
        if (!rel.startsWith(`${effort}/`)) continue;
        const to = path.join(target, rel);
        if (fs.existsSync(to)) throw new Error(`${rel} appeared while importing; refusing to overwrite it`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(path.join(stage, rel), to);
        moved.push(to);
      }
    }
  } catch (e) {
    for (const f of moved) fs.rmSync(f, { force: true });
    for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function formatReport(r: ImportReport): string {
  const out: string[] = [];
  const verb = r.dry_run ? 'would import' : 'imported';
  out.push(`${r.layout} layout at ${r.workspace}${r.dry_run ? ' (dry run, nothing written)' : ''}`);
  out.push(`${verb} ${r.imported.length} item(s) into ${r.efforts.length} effort(s): ${r.efforts.join(', ') || 'none'}`);
  for (const i of r.imported) out.push(`  + ${i.id}  <- ${i.source}`);
  if (r.already_imported.length > 0) out.push(`already imported (left untouched): ${r.already_imported.length}`);
  if (r.skipped.length > 0) {
    out.push(`skipped ${r.skipped.length} file(s):`);
    for (const s of r.skipped) out.push(`  ! ${s.source}: ${s.reason}`);
  }
  if (r.not_imported.length > 0) {
    out.push(`not imported (${r.not_imported.length}):`);
    for (const s of r.not_imported) out.push(`  - ${s.path}: ${s.reason}`);
  }
  if (r.warnings.length > 0) {
    out.push(`warnings (${r.warnings.length}):`);
    for (const w of r.warnings) out.push(`  ~ ${w.message} [${w.source}]`);
  }
  return out.join('\n');
}
