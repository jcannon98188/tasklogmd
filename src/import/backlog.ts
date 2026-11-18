// Backlog layout loader (spec section 9): `backlog/{tasks,drafts,completed,archive/...}` with YAML frontmatter
// and sentinel-wrapped body sections.
//
// Task files are located by walking the known directories for every `.md` file and reading `id` from the
// frontmatter. The filename is never used to identify a task, so a changed `task_prefix` (files named
// `task-5 - x.md` next to `back-6 - y.md`) misses nothing.

import fs from 'node:fs';
import path from 'node:path';
import type { ItemType, Status } from '../model/parse.ts';
import type { Candidate, LoadResult, Warning } from './types.ts';
import { slugify } from '../model/create.ts';
import { asList, normalizeText, splitFrontmatter, type YEntry, type YValue } from './yaml.ts';

export interface BacklogOptions {
  root: string;
  /** Absolute path of the `backlog/` directory. */
  backlogDir: string;
  /** Force everything into this effort. */
  effort?: string;
  /** `none` puts everything in the `backlog` effort instead of splitting by milestone. */
  groupBy?: 'milestone' | 'none';
}

type Origin = 'tasks' | 'completed' | 'archive' | 'drafts' | 'archive-drafts';

const GROUPS: Array<{ dir: string; origin: Origin }> = [
  { dir: 'tasks', origin: 'tasks' },
  { dir: 'completed', origin: 'completed' },
  { dir: 'archive/tasks', origin: 'archive' },
  { dir: 'drafts', origin: 'drafts' },
  { dir: 'archive/drafts', origin: 'archive-drafts' },
];
const SKIPPED_DIRS = ['decisions', 'milestones', 'archive/docs', 'archive/decisions', 'archive/milestones'];
const WAYFINDER_TYPE_RE = /^wayfinder[-:_ ]?(research|prototype|grilling|task)$/i;
const WAYFINDER_DOC_RE = /^wayfinder[-:_ ]?(map|spec)$/i;
const DEFAULT_STATUSES = ['To Do', 'In Progress', 'Done'];
const CONSUMED = new Set(['id', 'title', 'status', 'created_date', 'updated_date', 'labels', 'dependencies', 'milestone', 'parent_task_id']);
const RESERVED = new Set(['kind', 'type', 'claimed_by', 'blocked_by', 'tags', 'created', 'updated', 'imported_from']);

const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

export function isBacklogDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'config.yml'));
}

function readStatuses(backlogDir: string): string[] {
  try {
    const raw = normalizeText(fs.readFileSync(path.join(backlogDir, 'config.yml'), 'utf8'));
    const sp = splitFrontmatter(`---\n${raw}\n---\n`);
    if (typeof sp !== 'string') {
      const e = sp.entries.find((x) => x.key === 'statuses');
      const list = e ? asList(e.value).map(String).filter(Boolean) : [];
      if (list.length > 0) return list;
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_STATUSES;
}

/** Milestone id or title (lowercased) to its title, from `milestones/*.md`. */
function readMilestones(backlogDir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const dir of ['milestones', 'archive/milestones']) {
    for (const f of mdFiles(path.join(backlogDir, dir))) {
      try {
        const sp = splitFrontmatter(fs.readFileSync(f, 'utf8'));
        if (typeof sp === 'string') continue;
        const get = (k: string) => {
          const v = sp.entries.find((e) => e.key === k)?.value;
          return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
        };
        const title = get('title');
        if (title && get('id')) m.set(get('id').toLowerCase(), title);
      } catch {
        /* unreadable milestone files are just not used for naming */
      }
    }
  }
  return m;
}

const numKeyOf = (id: string): string | null => /(\d+(?:\.\d+)*)$/.exec(id.trim())?.[1] ?? null;

function cmpNumKey(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

const SENTINEL_RE = /^\s*<!--\s*(?:SECTION:[A-Z_]+:(?:BEGIN|END)|AC:(?:BEGIN|END)|DOD:(?:BEGIN|END))\s*-->\s*$/;
const SECTION_MAP: Record<string, string> = {
  description: 'Question',
  question: 'Question',
  resolution: 'Answer',
  answer: 'Answer',
  'acceptance criteria': 'Acceptance criteria',
  'implementation plan': 'Implementation plan',
  'implementation notes': 'Implementation notes',
  'final summary': 'Final summary',
};
const CANON = ['Question', 'Acceptance criteria', 'Implementation plan', 'Implementation notes', 'Final summary'];

const trimBlank = (s: string): string => s.replace(/^\s*\n/, '').replace(/\s+$/, '');

/** Strips sentinels, renames the known sections, numbers unnumbered ACs and puts sections in canonical order. */
export function convertBacklogBody(body: string, done = false): string {
  const lines = body.split('\n').filter((l) => !SENTINEL_RE.test(l));
  const pre: string[] = [];
  const secs: Array<{ name: string; known: boolean; lines: string[] }> = [];
  let fence: string | null = null;
  for (const ln of lines) {
    const fm = /^\s*(```+|~~~+)/.exec(ln);
    if (fm) {
      const marker = fm[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
    const h = fence === null ? /^##[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(ln) : null;
    if (h && !ln.startsWith('###')) {
      const mapped = SECTION_MAP[h[1]!.toLowerCase()];
      secs.push({ name: mapped ?? h[1]!, known: mapped !== undefined, lines: [] });
    } else if (secs.length === 0) pre.push(ln);
    else secs[secs.length - 1]!.lines.push(ln);
  }

  const out: string[] = [];
  const emit = (name: string, content: string) => out.push(`## ${name}\n\n${content}`.replace(/\s+$/, ''));

  const q = [trimBlank(pre.join('\n')), ...secs.filter((s) => s.name === 'Question' && s.known).map((s) => trimBlank(s.lines.join('\n')))].filter(Boolean).join('\n\n');
  emit('Question', q || 'Imported from backlog.md without a description.');

  const acLines = secs.filter((s) => s.name === 'Acceptance criteria' && s.known).flatMap((s) => s.lines);
  if (acLines.some((l) => /^- \[[ xX]\]/.test(l))) {
    let max = 0;
    for (const l of acLines) {
      const m = /^- \[[ xX]\]\s?#(\d+)\b/.exec(l);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const numbered = acLines.map((l) => {
      const m = /^- \[([ xX])\]\s?(?:#(\d+)\b\s?)?(.*)$/.exec(l);
      if (!m) return l;
      return `- [${m[1]}] #${m[2] ?? ++max} ${m[3]}`;
    });
    emit('Acceptance criteria', trimBlank(numbered.join('\n')));
  }
  // A finished task's Final summary (else its Implementation notes) is its Answer, unless it already has one.
  const text = (name: string) =>
    secs
      .filter((x) => x.name === name && x.known)
      .map((s) => trimBlank(s.lines.join('\n')))
      .filter(Boolean)
      .join('\n\n');
  let answer = text('Answer');
  let promoted: string | null = null;
  if (done && !answer) {
    promoted = text('Final summary') ? 'Final summary' : text('Implementation notes') ? 'Implementation notes' : null;
    if (promoted) answer = text(promoted);
  }
  for (const name of CANON.slice(2)) {
    if (name === promoted) continue;
    const c = text(name);
    if (c) emit(name, c);
  }
  if (answer) emit('Answer', answer);
  for (const s of secs.filter((x) => !x.known)) emit(s.name, trimBlank(s.lines.join('\n')));
  return out.join('\n\n');
}

interface Raw {
  file: string;
  src: string;
  origin: Origin;
  entries: YEntry[];
  body: string;
  id: string;
  numKey: string;
  fm: Map<string, YValue>;
}

export function loadBacklog(opts: BacklogOptions): LoadResult {
  const skipped: LoadResult['skipped'] = [];
  const warnings: Warning[] = [];
  const notImported: LoadResult['notImported'] = [];
  const statuses = readStatuses(opts.backlogDir);
  const milestones = readMilestones(opts.backlogDir);
  const norm = (s: string) => s.trim().toLowerCase();
  const first = norm(statuses[0]!);
  const last = norm(statuses[statuses.length - 1]!);

  const raws: Raw[] = [];
  for (const g of GROUPS) {
    for (const file of mdFiles(path.join(opts.backlogDir, g.dir))) {
      const src = rel(opts.root, file);
      let sp: ReturnType<typeof splitFrontmatter>;
      try {
        sp = splitFrontmatter(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        skipped.push({ source: src, reason: `cannot read: ${(e as Error).message}` });
        continue;
      }
      if (typeof sp === 'string') {
        skipped.push({ source: src, reason: sp });
        continue;
      }
      const fm = new Map(sp.entries.map((e) => [e.key, e.value] as const));
      const idv = fm.get('id');
      const id = typeof idv === 'string' || typeof idv === 'number' ? String(idv) : '';
      const numKey = id ? numKeyOf(id) : null;
      if (!id || !numKey) {
        skipped.push({ source: src, reason: id ? `task id "${id}" has no number` : 'frontmatter has no "id"' });
        continue;
      }
      raws.push({ file, src, origin: g.origin, entries: sp.entries, body: sp.body, id, numKey, fm });
    }
  }
  raws.sort((a, b) => GROUPS.findIndex((g) => g.origin === a.origin) - GROUPS.findIndex((g) => g.origin === b.origin) || cmpNumKey(a.numKey, b.numKey) || (a.src < b.src ? -1 : 1));

  for (const d of SKIPPED_DIRS) {
    for (const f of mdFiles(path.join(opts.backlogDir, d))) {
      const reason = d.endsWith('milestones') ? `backlog ${d.replace('archive/', 'archive ')} are not imported as files; their titles name the efforts` : `backlog ${d.replace('archive/', 'archive ')} are not imported`;
      notImported.push({ path: rel(opts.root, f), reason });
    }
  }

  const byId = new Map<string, Raw[]>();
  for (const r of raws) byId.set(norm(r.id), [...(byId.get(norm(r.id)) ?? []), r]);

  const milestoneSlug = (r: Raw): string => {
    const v = r.fm.get('milestone');
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    const s = String(v).trim();
    return slugify(milestones.get(s.toLowerCase()) ?? s);
  };
  const parentOf = (r: Raw): Raw | undefined => {
    const pv = r.fm.get('parent_task_id');
    const pid = typeof pv === 'string' ? norm(pv) : '';
    const hit = pid ? byId.get(pid)?.[0] : undefined;
    if (hit) return hit;
    if (!r.numKey.includes('.')) return undefined;
    const top = r.numKey.split('.')[0]!;
    return raws.find((x) => x.numKey === top);
  };
  const effortOf = (r: Raw, depth = 0): string => {
    if (opts.effort) return opts.effort;
    if (opts.groupBy === 'none') return 'backlog';
    const ms = milestoneSlug(r);
    if (ms) return ms;
    const p = depth < 5 ? parentOf(r) : undefined;
    return p && p !== r ? effortOf(p, depth + 1) : 'backlog';
  };

  const candidates: Candidate[] = [];
  const rawOf = new Map<Candidate, Raw>();
  for (const r of raws) {
    const isSub = r.numKey.includes('.');
    const tags: string[] = [];
    const addTag = (t: string) => {
      const s = slugify(t);
      if (s && !tags.includes(s)) tags.push(s);
    };
    let type: ItemType | undefined;
    for (const l of asList(r.fm.get('labels'))) {
      const w = WAYFINDER_TYPE_RE.exec(String(l).trim());
      if (w) type ??= w[1]!.toLowerCase() as ItemType; // wayfinder-<type> labels become the native type
      else addTag(String(l));
    }

    // Status
    let status: Status;
    let claimedBy: string | undefined;
    const sv = r.fm.get('status');
    const sname = typeof sv === 'string' ? sv.trim() : '';
    if (r.origin === 'archive' || r.origin === 'archive-drafts') {
      status = 'closed';
      addTag('archived');
    } else if (r.origin === 'completed') status = 'resolved';
    else if (r.origin === 'drafts') status = 'open';
    else if (norm(sname) === last && statuses.length > 1) status = 'resolved';
    else if (norm(sname) === first || sname === '') status = 'open';
    else if (statuses.some((s) => norm(s) === norm(sname))) {
      status = 'claimed';
      const a = asList(r.fm.get('assignee'))[0];
      claimedBy = a !== undefined && a !== null && String(a).trim() ? String(a).trim() : 'imported';
      addTag(sname);
    } else {
      status = 'open';
      addTag(sname);
      warnings.push({ kind: 'dropped_value', source: r.src, message: `status "${sname}" is not in config.yml statuses; imported as open` });
    }
    if (r.origin === 'drafts' || r.origin === 'archive-drafts') addTag('draft');

    const pr = r.fm.get('priority');
    if (typeof pr === 'string' || typeof pr === 'number') addTag(`priority-${pr}`);
    if (isSub) addTag(`parent-${r.numKey.split('.')[0]}`);

    const extras: string[] = [];
    for (const e of r.entries) {
      if (CONSUMED.has(e.key)) continue;
      if (e.key === 'assignee' && asList(e.value).length === 0) continue; // `assignee: []` carries no information
      extras.push(RESERVED.has(e.key) ? e.raw.replace(/^[A-Za-z_][A-Za-z0-9_-]*/, `backlog_${e.key}`) : e.raw);
    }

    const base = path.basename(r.file, '.md');
    const tv = r.fm.get('title');
    const title = typeof tv === 'string' && tv.trim() ? tv.trim() : base.replace(/^.*? - /, '').trim() || r.id;
    const date = (v: YValue | undefined): string | undefined => (typeof v === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(v)?.[0] : undefined);
    const mtime = fs.statSync(r.file).mtime.toISOString().slice(0, 10);
    const created = date(r.fm.get('created_date')) ?? mtime;
    const updated = date(r.fm.get('updated_date')) ?? created;

    const c: Candidate = {
      srcPath: r.src,
      kind: 'ticket',
      effort: effortOf(r),
      wantNum: isSub ? null : Number(r.numKey),
      fresh: isSub,
      slug: slugify(title) || 'task',
      title,
      status,
      type,
      claimedBy,
      tags,
      created,
      updated,
      refs: asList(r.fm.get('dependencies')).map((d) => String(d).trim()).filter(Boolean),
      extras,
      body: convertBacklogBody(r.body, status === 'resolved' || status === 'closed'),
      label: r.id,
    };
    candidates.push(c);
    rawOf.set(c, r);
  }

  // Documents tagged `wayfinder:map` / `wayfinder:spec` become the effort's map/spec; the rest are reported.
  const efforts = [...new Set(candidates.map((c) => c.effort))];
  const claimedDoc = new Set<string>();
  for (const file of mdFiles(path.join(opts.backlogDir, 'docs'))) {
    const src = rel(opts.root, file);
    let sp: ReturnType<typeof splitFrontmatter> | undefined;
    try {
      sp = splitFrontmatter(fs.readFileSync(file, 'utf8'));
    } catch {
      /* reported below as not imported */
    }
    const fm = sp && typeof sp !== 'string' ? new Map(sp.entries.map((e) => [e.key, e.value] as const)) : undefined;
    const tagged = fm ? [...asList(fm.get('tags')), ...asList(fm.get('labels'))].map((t) => WAYFINDER_DOC_RE.exec(String(t).trim())) : [];
    const kind = (tagged.find(Boolean)?.[1]?.toLowerCase() ?? '') as 'map' | 'spec' | '';
    if (!sp || typeof sp === 'string' || !fm || !kind) {
      notImported.push({ path: src, reason: 'backlog docs are not imported unless tagged wayfinder:map or wayfinder:spec' });
      continue;
    }
    const tv = fm.get('title');
    const title = typeof tv === 'string' && tv.trim() ? tv.trim() : path.basename(file, '.md').replace(/^.*? - /, '').trim();
    const tslug = slugify(title).replace(/-(map|spec)$/, '');
    const fslug = slugify(path.basename(file, '.md').replace(/^.*? - /, '')).replace(/-(map|spec)$/, '');
    const effort = opts.effort ?? (opts.groupBy === 'none' ? 'backlog' : efforts.find((e) => e === tslug || e === fslug) ?? (efforts.length === 1 ? efforts[0] : undefined));
    if (!effort) {
      const message = `${kind} document "${title}" matches no effort (${efforts.join(', ') || 'none'}) and was not imported; rerun with --effort <name> to place it`;
      warnings.push({ kind: 'dropped_value', source: src, message });
      notImported.push({ path: src, reason: `wayfinder:${kind} document with no matching effort` });
      continue;
    }
    if (claimedDoc.has(`${effort}/${kind}`)) {
      warnings.push({ kind: 'not_overwritten', source: src, message: `${effort}/${kind}.md was already taken by another document; not imported` });
      notImported.push({ path: src, reason: `second wayfinder:${kind} document for effort "${effort}"` });
      continue;
    }
    claimedDoc.add(`${effort}/${kind}`);
    const date = (v: YValue | undefined): string | undefined => (typeof v === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(v)?.[0] : undefined);
    const created = date(fm.get('created_date')) ?? fs.statSync(file).mtime.toISOString().slice(0, 10);
    candidates.push({
      srcPath: src,
      kind,
      effort,
      wantNum: null,
      fresh: false,
      slug: '',
      title,
      status: 'open',
      tags: [],
      created,
      updated: date(fm.get('updated_date')) ?? created,
      refs: [],
      extras: [],
      body: normalizeText(sp.body).split('\n').filter((l) => !SENTINEL_RE.test(l)).join('\n').trim(),
      rewriteLinks: true,
      label: `${effort}/${kind}`,
    });
  }

  const byIdC = new Map<string, Candidate[]>();
  const byNumC = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const r = rawOf.get(c);
    if (!r) continue; // map/spec documents are not dependency targets
    byIdC.set(norm(r.id), [...(byIdC.get(norm(r.id)) ?? []), c]);
    byNumC.set(r.numKey, [...(byNumC.get(r.numKey) ?? []), c]);
  }
  const pick = (list: Candidate[] | undefined, from: Candidate): Candidate | null | 'ambiguous' => {
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0]!;
    const same = list.filter((x) => x.effort === from.effort);
    return same.length === 1 ? same[0]! : 'ambiguous';
  };

  return {
    candidates,
    skipped,
    notImported,
    warnings,
    resolve(ref, from) {
      const exact = pick(byIdC.get(norm(ref)), from);
      if (exact !== null) return exact;
      const nk = numKeyOf(ref);
      return nk ? pick(byNumC.get(nk), from) : null;
    },
  };
}
