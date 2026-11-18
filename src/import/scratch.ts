// Scratch layout loader (spec section 9): `.scratch/<effort>/{map.md,spec.md,issues/NN-*.md}` with
// `Type:`, `Status:`, `Blocked by:` and `Label:` header lines instead of frontmatter.

import fs from 'node:fs';
import path from 'node:path';
import { TYPES, type ItemType, type Status } from '../model/parse.ts';
import type { Candidate, LoadResult, Warning } from './types.ts';
import { normalizeText, slugify } from './yaml.ts';

export const TRIAGE_ROLES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human'] as const;

export interface ScratchOptions {
  /** Absolute workspace root; `imported_from` is relative to it. */
  root: string;
  /** Absolute path of the `.scratch` directory, or of a single effort directory inside it. */
  scratchDir: string;
  /** Force everything into this effort. */
  effort?: string;
}

const HEADER_RE = /^\**(type|status|blocked by|label)\**\s*:\**\s*(.*?)\s*$/i;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');
const isoDate = (file: string): string => fs.statSync(file).mtime.toISOString().slice(0, 10);

/** Lists the effort directories to import: either `scratchDir` itself (a single effort) or its children. */
export function scratchEfforts(scratchDir: string): string[] {
  const looksLikeEffort = (d: string) => isDir(path.join(d, 'issues')) || fs.existsSync(path.join(d, 'map.md')) || fs.existsSync(path.join(d, 'spec.md'));
  if (path.basename(path.dirname(scratchDir)) === '.scratch' && looksLikeEffort(scratchDir)) return [scratchDir];
  return fs
    .readdirSync(scratchDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => path.join(scratchDir, d.name))
    .filter(looksLikeEffort)
    .sort();
}

/** Splits `## ` sections out of a body, ignoring fenced code. Returns the preamble and the rest verbatim. */
function splitPreamble(lines: string[]): { pre: string[]; rest: string[] } {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const fm = /^\s*(```+|~~~+)/.exec(ln);
    if (fm) {
      const marker = fm[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null && /^##[ \t]+\S/.test(ln) && !ln.startsWith('###')) return { pre: lines.slice(0, i), rest: lines.slice(i) };
  }
  return { pre: lines, rest: [] };
}

/** Numbers `- [ ] text` lines in the Acceptance criteria section that have no `#N` yet. */
function numberAcs(lines: string[]): string[] {
  const out = [...lines];
  let inAc = false;
  let max = 0;
  const idx: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const h = /^##[ \t]+(.*?)[ \t]*$/.exec(out[i]!);
    if (h && !out[i]!.startsWith('###')) {
      inAc = h[1]!.toLowerCase() === 'acceptance criteria';
      continue;
    }
    if (!inAc) continue;
    const m = /^- \[([ xX])\]\s?(?:#(\d+)\b\s?)?(.*)$/.exec(out[i]!);
    if (!m) continue;
    if (m[2] !== undefined) max = Math.max(max, Number(m[2]));
    else idx.push(i);
  }
  for (const i of idx) {
    const m = /^- \[([ xX])\]\s?(.*)$/.exec(out[i]!)!;
    out[i] = `- [${m[1]}] #${++max} ${m[2]}`;
  }
  return out;
}

interface Header {
  type?: string;
  status?: string;
  blockedBy?: string;
}

function readHeader(pre: string[]): { header: Header; rest: string[]; h1?: string } {
  const header: Header = {};
  const rest: string[] = [];
  let h1: string | undefined;
  for (const ln of pre) {
    const hm = HEADER_RE.exec(ln.trim());
    if (hm) {
      const k = hm[1]!.toLowerCase();
      if (k === 'type') header.type = hm[2]!;
      else if (k === 'status') header.status = hm[2]!;
      else if (k === 'blocked by') header.blockedBy = hm[2]!;
      continue; // `Label:` and the others are folded into kind/type and dropped
    }
    const t = /^#[ \t]+(.+?)[ \t]*$/.exec(ln);
    if (t && h1 === undefined && rest.every((r) => r.trim() === '')) {
      h1 = t[1]!;
      continue;
    }
    rest.push(ln);
  }
  return { header, rest, h1 };
}

const trimBlank = (lines: string[]): string[] => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === '') a++;
  while (b > a && lines[b - 1]!.trim() === '') b--;
  return lines.slice(a, b);
};

export function loadScratch(opts: ScratchOptions): LoadResult {
  const candidates: Candidate[] = [];
  const skipped: LoadResult['skipped'] = [];
  const warnings: Warning[] = [];
  const notImported: LoadResult['notImported'] = [];
  const srcEffortOf = new Map<Candidate, string>();
  const srcNumOf = new Map<Candidate, number>();

  const add = (c: Candidate, srcEffort: string, num?: number) => {
    candidates.push(c);
    srcEffortOf.set(c, srcEffort);
    if (num !== undefined) srcNumOf.set(c, num);
  };

  for (const dir of scratchEfforts(opts.scratchDir)) {
    const srcEffort = path.basename(dir);
    const target = opts.effort ?? (slugify(srcEffort) || srcEffort);
    if (!opts.effort && target !== srcEffort) {
      warnings.push({ kind: 'dropped_value', source: rel(opts.root, dir), message: `effort name "${srcEffort}" is not kebab-case; imported as "${target}"` });
    }

    const files: Array<{ file: string; kind: 'map' | 'spec' | 'ticket' }> = [];
    for (const k of ['map', 'spec'] as const) {
      const f = path.join(dir, `${k}.md`);
      if (fs.existsSync(f)) files.push({ file: f, kind: k });
    }
    const issues = path.join(dir, 'issues');
    if (isDir(issues)) {
      for (const name of fs.readdirSync(issues).sort()) {
        const f = path.join(issues, name);
        if (!name.toLowerCase().endsWith('.md') || !fs.statSync(f).isFile()) continue;
        if (/^\d+/.test(name)) files.push({ file: f, kind: 'ticket' });
        else notImported.push({ path: rel(opts.root, f), reason: 'not a numbered ticket file' });
      }
    }

    for (const { file, kind } of files) {
      const src = rel(opts.root, file);
      let text: string;
      try {
        text = normalizeText(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        skipped.push({ source: src, reason: `cannot read: ${(e as Error).message}` });
        continue;
      }
      const lines = text.split('\n');
      const { pre, rest } = splitPreamble(lines);
      const { header, rest: preRest, h1 } = readHeader(pre);
      const preText = trimBlank(preRest);

      // Status
      let status: Status = 'open';
      const tags: string[] = [];
      const st = (header.status ?? '').trim().toLowerCase();
      if (st === 'open' || st === 'claimed' || st === 'resolved' || st === 'closed') status = st;
      else if (st === 'wontfix') {
        status = 'closed';
        tags.push('wontfix');
      } else if ((TRIAGE_ROLES as readonly string[]).includes(st)) tags.push(st);
      else if (st !== '') warnings.push({ kind: 'dropped_value', source: src, message: `unknown status "${header.status}" imported as open` });

      // Type (tickets only)
      let type: ItemType | undefined;
      if (kind === 'ticket' && header.type) {
        const t = header.type.trim().toLowerCase();
        if ((TYPES as readonly string[]).includes(t)) type = t as ItemType;
        else warnings.push({ kind: 'dropped_value', source: src, message: `unknown type "${header.type}" dropped` });
      }

      const base = path.basename(file, '.md');
      const num = kind === 'ticket' ? Number(/^\d+/.exec(base)![0]) : null;
      const slug = kind === 'ticket' ? base.replace(/^\d+-?/, '') : '';
      let title = h1?.replace(/^\d+:\s*/, '').trim() || '';
      if (!title) {
        if (kind === 'ticket') {
          const words = slug.replace(/-+/g, ' ').trim() || `ticket ${num}`;
          title = words.charAt(0).toUpperCase() + words.slice(1);
        } else title = kind === 'map' ? srcEffort : `${srcEffort} spec`;
      }

      // Body
      let bodyLines: string[];
      const hasQuestion = rest.some((l) => /^##[ \t]+question[ \t]*$/i.test(l));
      if (kind === 'ticket' && !hasQuestion && preText.length > 0) bodyLines = ['## Question', '', ...preText, '', ...rest];
      else bodyLines = [...(preText.length > 0 ? [...preText, ''] : []), ...rest];
      let body = numberAcs(bodyLines).join('\n');
      body = body.replace(/\]\((\.\/)?issues\/(\d+[^)\s]*\.md)/g, '](tickets/$2');
      body = trimBlank(body.split('\n')).join('\n');

      const refs =
        kind === 'ticket' && header.blockedBy
          ? header.blockedBy
              .split(/[,\s]+/)
              .map((t) => t.trim().toLowerCase())
              .filter((t) => /^([a-z0-9][a-z0-9-]*\/)?\d+$/.test(t))
          : [];

      const date = isoDate(file);
      add(
        {
          srcPath: src,
          kind,
          effort: target,
          wantNum: num,
          fresh: false,
          slug,
          title,
          status,
          type,
          claimedBy: status === 'claimed' ? 'imported' : undefined,
          tags,
          created: date,
          updated: date,
          refs,
          extras: [],
          body,
          label: kind === 'ticket' ? `${srcEffort}/${String(num).padStart(2, '0')}` : `${srcEffort}/${kind}`,
        },
        srcEffort,
        num ?? undefined,
      );
    }
  }

  const byKey = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.kind === 'ticket') byKey.set(`${srcEffortOf.get(c)}/${srcNumOf.get(c)}`, c);
  }
  return {
    candidates,
    skipped,
    notImported,
    warnings,
    resolve(ref, from) {
      const m = /^(?:(.+)\/)?(\d+)$/.exec(ref);
      if (!m) return null;
      const eff = m[1] ?? srcEffortOf.get(from)!;
      return byKey.get(`${eff}/${Number(m[2])}`) ?? null;
    },
  };
}
