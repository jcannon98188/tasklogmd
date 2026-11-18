// Text search (spec section 6): tokenisation computed once per distinct file content (held by the parsed-item
// store), a query parser, linear-scan matching and field-weighted scoring. Pure: no filesystem, no clock.

import type { ParseResult } from './parse.ts';

export type SearchField = 'title' | 'id' | 'tags' | 'question' | 'answer' | 'body';

/** Higher is better. Title > tag > Question/Answer > other body (spec section 6); the ID sits between tag and Q/A. */
const WEIGHT: Record<SearchField, number> = { title: 100, tags: 40, id: 30, question: 10, answer: 10, body: 1 };
const FIELD_ORDER: SearchField[] = ['title', 'id', 'tags', 'question', 'answer', 'body'];

/** Token data for one field. `parts` is the ordered token sequence ('' separates independent runs). */
export interface FieldTokens {
  parts: string[];
  /** Identifier-like chunks kept whole (`list_items`, `07-daemon`, `alpha/03`). */
  wholes: string[];
}

export type SearchData = Partial<Record<SearchField, FieldTokens>>;

/** Lowercases and folds diacritics. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

const IDENT = /^[\p{L}\p{N}]+(?:[_\-./][\p{L}\p{N}]+)+$/u;

export function tokenize(text: string): FieldTokens {
  const f = fold(text);
  const parts = f.match(/[\p{L}\p{N}]+/gu) ?? [];
  const wholes: string[] = [];
  for (const chunk of f.split(/\s+/)) {
    const c = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (IDENT.test(c)) wholes.push(c);
  }
  return { parts, wholes };
}

function merge(chunks: string[]): FieldTokens {
  const out: FieldTokens = { parts: [], wholes: [] };
  for (const c of chunks) {
    const t = tokenize(c);
    if (out.parts.length) out.parts.push('');
    out.parts.push(...t.parts);
    out.wholes.push(...t.wholes);
  }
  return out;
}

/** Builds the per-file token data (everything except the ID, which comes from the path). Invalid files have none. */
export function buildSearchData(p: ParseResult): SearchData | null {
  if (!p.ok) return null;
  const body = p.body;
  const sections = p.sections;
  const bodyChunks: string[] = [];
  const question: string[] = [];
  const answer: string[] = [];
  if (sections.length === 0) bodyChunks.push(body);
  else {
    bodyChunks.push(p.text.slice(p.bodyStart, sections[0]!.start));
    for (const s of sections) {
      const text = p.text.slice(s.start, s.end);
      const h = s.heading.trim().toLowerCase();
      (h === 'question' ? question : h === 'answer' ? answer : bodyChunks).push(text);
    }
  }
  return {
    title: merge([p.fields.title]),
    tags: merge(p.fields.tags),
    question: merge(question),
    answer: merge(answer),
    body: merge(bodyChunks),
  };
}

// ---- queries -------------------------------------------------------------------------------------------------

type Term =
  | { neg: boolean; kind: 'word'; w: string }
  | { neg: boolean; kind: 'ident'; whole: string; parts: string[] }
  | { neg: boolean; kind: 'phrase'; parts: string[] };

export interface ParsedQuery {
  terms: Term[];
  /** True when the query has no usable token (the text filter is then ignored). */
  empty: boolean;
}

/** `word`, `"exact phrase"`, `-excluded`, `-"excluded phrase"`; several terms AND together. */
export function parseQuery(text: string): ParsedQuery {
  const terms: Term[] = [];
  for (const m of text.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    if (m[2] !== undefined) {
      const parts = tokenize(m[2]).parts;
      if (parts.length) terms.push({ neg: m[1] === '-', kind: 'phrase', parts });
      continue;
    }
    let raw = m[3]!;
    let neg = false;
    if (raw.startsWith('-') && raw.length > 1) {
      neg = true;
      raw = raw.slice(1);
    }
    const t = tokenize(raw);
    if (t.wholes.length === 1) terms.push({ neg, kind: 'ident', whole: t.wholes[0]!, parts: t.parts });
    else for (const w of t.parts) terms.push({ neg, kind: 'word', w });
  }
  return { terms, empty: terms.length === 0 };
}

function hasSequence(hay: string[], needle: string[], prefixLast: boolean): boolean {
  const n = needle.length;
  outer: for (let i = 0; i + n <= hay.length; i++) {
    for (let j = 0; j < n; j++) {
      const h = hay[i + j]!;
      const q = needle[j]!;
      if (j === n - 1 && prefixLast ? !h.startsWith(q) : h !== q) continue outer;
    }
    return true;
  }
  return false;
}

function termHits(t: Term, f: FieldTokens | undefined): boolean {
  if (!f) return false;
  switch (t.kind) {
    case 'word':
      return f.parts.some((p) => p.startsWith(t.w));
    case 'ident':
      return f.wholes.some((w) => w.startsWith(t.whole)) || hasSequence(f.parts, t.parts, true);
    case 'phrase':
      return hasSequence(f.parts, t.parts, false);
  }
}

export interface TextMatch {
  score: number;
  matched_in: SearchField[];
}

/** Returns null when the item does not match; `data` is the stored token data plus the ID's tokens. */
export function matchItem(q: ParsedQuery, stored: SearchData | null, id: string): TextMatch | null {
  if (!stored) return null;
  const data: SearchData = { ...stored, id: tokenize(id) };
  let score = 0;
  const hit = new Set<SearchField>();
  for (const t of q.terms) {
    let best = 0;
    for (const field of FIELD_ORDER) {
      if (!termHits(t, data[field])) continue;
      if (t.neg) return null;
      best = Math.max(best, WEIGHT[field]);
      hit.add(field);
    }
    if (!t.neg) {
      if (best === 0) return null;
      score += best;
    }
  }
  return { score, matched_in: FIELD_ORDER.filter((f) => hit.has(f)) };
}

// ---- snippets ------------------------------------------------------------------------------------------------

export const SNIPPET_LENGTH = 160;

/** Folds `s` character by character, keeping an index map back into the original so offsets stay valid. */
function foldWithMap(s: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  return { folded, map };
}

/** About 160 characters of `body` around the first positive term (or the title/start when the body has no hit). */
export function makeSnippet(q: ParsedQuery, title: string, body: string): string {
  const { folded, map } = foldWithMap(body);
  let at = -1;
  for (const t of q.terms) {
    if (t.neg) continue;
    const needle = t.kind === 'word' ? t.w : t.kind === 'ident' ? t.whole : t.parts.join(' ');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[^\\p{L}\\p{N}]+')}`, 'u');
    const m = re.exec(folded);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat ? clip(flat, 0) : title;
  }
  const start = Math.max(0, (map[at] ?? 0) - 40);
  return clip(body, start);
}

function clip(text: string, start: number): string {
  const flat = text.slice(start).replace(/\s+/g, ' ');
  const lead = start > 0 ? '…' : '';
  const trimmed = (start > 0 ? flat.trimStart() : flat).trim();
  return trimmed.length > SNIPPET_LENGTH ? `${lead}${trimmed.slice(0, SNIPPET_LENGTH).trimEnd()}…` : `${lead}${trimmed}`;
}
