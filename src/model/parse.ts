// The native-format parser (spec section 3). Pure: bytes in, immutable parse result out. No filesystem,
// no clock, no path knowledge (so one result can be shared by every workspace that holds the same bytes).
//
// Offsets in the result index into `text`, which is the file decoded as UTF-8 with any BOM removed and
// every line ending left exactly as it was on disk. `text.slice(a, b)` therefore reproduces file content
// byte-faithfully, which is what the minimal-diff editor (ticket 06) relies on.

import { createHash } from 'node:crypto';

export const KINDS = ['map', 'spec', 'ticket', 'container', 'component'] as const;
export const ELEMENT_KINDS = ['container', 'component'] as const;
export const REVIEWS = ['proposed', 'accepted'] as const;
export const STATUSES = ['open', 'claimed', 'resolved', 'closed'] as const;
export const TYPES = ['research', 'prototype', 'grilling', 'task'] as const;
export type Kind = (typeof KINDS)[number];
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type Review = (typeof REVIEWS)[number];
/** What a file's path says it is: an effort's map, spec or ticket, or an architecture element (kind comes from frontmatter). */
export type LayoutKind = 'map' | 'spec' | 'ticket' | 'element';

export const isElementKind = (k: string | undefined): k is ElementKind => k === 'container' || k === 'component';

/** One entry of an element's `uses` list. */
export interface Use {
  to: string;
  label?: string;
}
export type Status = (typeof STATUSES)[number];
export type ItemType = (typeof TYPES)[number];

/** A scalar or list value as read from frontmatter (nested maps are kept only as their raw text). */
export type FmValue = string | number | boolean | null | FmValue[];

/** One top-level frontmatter key, with where it lives so edits can patch it in place. */
export interface FrontmatterEntry {
  key: string;
  value: FmValue;
  /** Offset of the first character of the key's first line. */
  start: number;
  /** Offset just past the key's last line, excluding its line ending. */
  end: number;
  /** The key's raw text, `text.slice(start, end)`, including list continuation lines and inline comments. */
  raw: string;
}

export interface Section {
  /** Heading text without the `## ` marker, trimmed. */
  heading: string;
  /** Offset of the `## ` heading line. */
  start: number;
  /** Offset of the first character after the heading line (and its line ending). */
  contentStart: number;
  /** Offset where the next `## ` heading starts, or the end of the text. */
  end: number;
}

export interface AcceptanceCriterion {
  /** The `#N` number, or null for a hand-added AC without one. */
  n: number | null;
  text: string;
  checked: boolean;
  /** Offset of the `- [ ]` line start and its end excluding the line ending. */
  start: number;
  end: number;
}

export type EolStyle = 'lf' | 'crlf' | 'mixed' | 'none';

export interface ParsedFields {
  kind: Kind;
  title: string;
  /** Absent on elements, which carry `review` instead. */
  status?: Status;
  type?: ItemType;
  claimedBy?: string;
  /** As written: numbers are same-effort ticket numbers, strings are `effort/NN`. Resolved by the index. */
  blockedBy: Array<number | string>;
  tags: string[];
  created?: string;
  updated?: string;
  /** Tickets only, when the key is present: bare element slugs as written. */
  components?: string[];
  /** Elements only. */
  review?: Review;
  parent?: string;
  uses?: Use[];
  code?: string[];
}

interface Common {
  /** Content hash of the exact file bytes (hex sha256): the concurrency token and the store key. */
  hash: string;
  /** Whether the file started with a UTF-8 BOM (stripped from `text`). */
  bom: boolean;
  eol: EolStyle;
  /** The decoded file without BOM; all offsets index into this. */
  text: string;
}

export interface ValidParse extends Common {
  ok: true;
  fields: ParsedFields;
  /** Every top-level frontmatter key in file order, known and unknown. */
  entries: FrontmatterEntry[];
  /** Unknown (non-schema) keys and their values, preserved. Convenience view of `entries`. */
  extra: Record<string, FmValue>;
  /** Offset just past the closing `---` line (and its line ending); the body starts here. */
  bodyStart: number;
  /** `text.slice(bodyStart)`. */
  body: string;
  /** `##` sections in file order, unknown ones included. Text before the first heading is the preamble. */
  sections: Section[];
  /** ACs from the `## Acceptance criteria` section, in file order. */
  acs: AcceptanceCriterion[];
}

export interface InvalidParse extends Common {
  ok: false;
  error: string;
}

export type ParseResult = ValidParse | InvalidParse;

export const contentHash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const AC_SECTION = 'acceptance criteria';
const TAG_RE = /^[a-z0-9-]+$/;

function detectEol(text: string): EolStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text[i - 1] === '\r') crlf++;
    else lf++;
  }
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

interface Line {
  start: number;
  /** End excluding the line ending. */
  end: number;
  /** Offset of the next line (after the line ending). */
  next: number;
  text: string;
}

function* lines(text: string, from = 0): Generator<Line> {
  let pos = from;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl === -1 ? text.length : nl + 1;
    let end = nl === -1 ? text.length : nl;
    if (nl !== -1 && end > pos && text[end - 1] === '\r') end--;
    yield { start: pos, end, next, text: text.slice(pos, end) };
    pos = next;
  }
}

export function scalar(raw: string): FmValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Strips a trailing ` # comment` that is outside quotes. */
export function stripComment(v: string): string {
  let quote: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(v[i - 1]!))) {
      return v.slice(0, i);
    }
  }
  return v;
}

/** Splits the inside of an inline `[a, b]` list on commas outside quotes. */
export function splitInline(inner: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '' || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p, i, a) => p !== '' || i < a.length - 1);
}

function parseFrontmatter(
  text: string,
  start: number,
): { entries: FrontmatterEntry[]; bodyStart: number } | { error: string } {
  const entries: FrontmatterEntry[] = [];
  const seen = new Set<string>();
  const all = [...lines(text, start)];
  let i = 0;
  while (i < all.length) {
    const ln = all[i]!;
    if (ln.text.trimEnd() === '---') {
      return { entries, bodyStart: ln.next };
    }
    if (ln.text.trim() === '' || ln.text.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/.exec(ln.text);
    if (!m) return { error: `frontmatter line ${i + 2} is not "key: value": ${JSON.stringify(ln.text.slice(0, 60))}` };
    const key = m[1]!;
    if (seen.has(key)) return { error: `frontmatter key "${key}" appears twice` };
    seen.add(key);
    const first = stripComment(m[2] ?? '').trim();
    // Continuation lines: indented lines, or `- item` lines at column 0 (block list under an empty value).
    let j = i + 1;
    const cont: Line[] = [];
    while (j < all.length) {
      const nx = all[j]!;
      if (nx.text.trimEnd() === '---') break;
      const indented = /^\s+\S/.test(nx.text);
      const dash = first === '' && /^-(\s|$)/.test(nx.text);
      const blankInside = nx.text.trim() === '' && (all[j + 1] ? /^\s+\S/.test(all[j + 1]!.text) : false);
      if (indented || dash || blankInside) {
        cont.push(nx);
        j++;
      } else break;
    }
    let value: FmValue;
    if (first.startsWith('[') && first.endsWith(']')) {
      value = splitInline(first.slice(1, -1)).map(scalar);
    } else if (first.startsWith('[') || first.startsWith('{')) {
      value = first; // multi-line flow collection or map: kept raw
    } else if (first === '' && cont.length > 0 && cont.every((c) => c.text.trim() === '' || /^\s*-(\s|$)/.test(c.text))) {
      value = cont.filter((c) => c.text.trim() !== '').map((c) => scalar(stripComment(c.text.replace(/^\s*-\s*/, ''))));
    } else if (cont.length > 0) {
      value = [m[2] ?? '', ...cont.map((c) => c.text)].join('\n').trim(); // block scalar or nested map: raw text
    } else {
      value = scalar(first);
    }
    const last = cont.length > 0 ? cont[cont.length - 1]! : ln;
    entries.push({ key, value, start: ln.start, end: last.end, raw: text.slice(ln.start, last.end) });
    i = j;
  }
  return { error: 'frontmatter is not closed; add a closing "---" line' };
}

function asList(v: FmValue | undefined): FmValue[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Splits `text` on top-level commas (outside quotes, braces and brackets). */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => p.trim());
}

function usesFromPairs(pairs: Array<[string, FmValue]>): Use | string {
  const use: Use = { to: '' };
  for (const [k, v] of pairs) {
    if (k === 'to' && typeof v === 'string' && v.trim() !== '') use.to = v.trim();
    else if (k === 'label' && (typeof v === 'string' || typeof v === 'number')) use.label = String(v);
    else if (k === 'label' && v === null) continue;
    else return `"uses" entries are {to, label?}; got ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  }
  return use.to === '' ? '"uses" entries need a non-empty "to" (an element slug)' : use;
}

function pairOf(text: string): [string, FmValue] | null {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/.exec(text.trim());
  return m ? [m[1]!, scalar(stripComment(m[2] ?? ''))] : null;
}

function flowMap(text: string): Use | string {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return `"uses" entries are {to, label?}; got ${JSON.stringify(t)}`;
  const pairs: Array<[string, FmValue]> = [];
  for (const part of splitTop(t.slice(1, -1))) {
    const p = pairOf(part);
    if (!p) return `"uses" entries are {to, label?}; got ${JSON.stringify(t)}`;
    pairs.push(p);
  }
  return usesFromPairs(pairs);
}

/** Parses the raw text of a `uses:` entry (block list of `to:`/`label:` maps, or an inline list of `{to: x}`). */
function parseUses(raw: string): Use[] | string {
  const ls = raw.split(/\r?\n/);
  const rest = stripComment(ls[0]!.replace(/^uses:/, '')).trim();
  const out: Use[] = [];
  const push = (u: Use | string): string | null => {
    if (typeof u === 'string') return u;
    out.push(u);
    return null;
  };
  if (rest !== '') {
    const flat = [rest, ...ls.slice(1).map((l) => stripComment(l).trim())].join(' ').trim();
    if (flat === 'null' || flat === '~') return [];
    if (!flat.startsWith('[') || !flat.endsWith(']')) return `"uses" must be a list of {to, label?}; got ${JSON.stringify(flat.slice(0, 60))}`;
    for (const part of splitTop(flat.slice(1, -1))) {
      const err = push(part.startsWith('{') ? flowMap(part) : usesFromPairs([['to', scalar(part)]]));
      if (err) return err;
    }
    return out;
  }
  let pairs: Array<[string, FmValue]> | null = null;
  const flush = (): string | null => {
    if (!pairs) return null;
    const err = push(usesFromPairs(pairs));
    pairs = null;
    return err;
  };
  for (const line of ls.slice(1)) {
    const body = stripComment(line);
    if (body.trim() === '') continue;
    const dash = /^\s*-(?:\s+(.*))?$/.exec(body);
    if (dash) {
      const err = flush();
      if (err) return err;
      const item = (dash[1] ?? '').trim();
      if (item.startsWith('{')) {
        const e2 = push(flowMap(item));
        if (e2) return e2;
      } else {
        const p = pairOf(item);
        // A bare scalar (`- slug`) is read as the target.
        pairs = p ? [p] : [['to', scalar(item)]];
      }
      continue;
    }
    const p = pairOf(body);
    if (!p || !pairs) return `"uses" entries are {to, label?}; could not read ${JSON.stringify(body.trim().slice(0, 60))}`;
    pairs.push(p);
  }
  const err = flush();
  return err ?? out;
}

function buildFields(map: Map<string, FmValue>, usesRaw?: string): ParsedFields | string {
  const kind = map.get('kind');
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return `"kind" must be one of ${KINDS.join(', ')}; got ${JSON.stringify(kind ?? null)}`;
  }
  const title = map.get('title');
  if (typeof title !== 'string' || title.trim() === '') return '"title" is required and must be non-empty text';
  const element = isElementKind(kind);
  const status = map.get('status');
  if (!element && (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status))) {
    return `"status" must be one of ${STATUSES.join(', ')}; got ${JSON.stringify(status ?? null)}`;
  }
  const type = map.get('type');
  if (type !== undefined && type !== null && (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type))) {
    return `"type" must be one of ${TYPES.join(', ')} when present; got ${JSON.stringify(type)}`;
  }
  const blockedBy: Array<number | string> = [];
  for (const b of asList(map.get('blocked_by'))) {
    if (typeof b === 'number' || (typeof b === 'string' && b !== '')) blockedBy.push(b);
    else return `"blocked_by" entries must be numbers or "effort/NN" strings; got ${JSON.stringify(b)}`;
  }
  const tags: string[] = [];
  for (const t of asList(map.get('tags'))) {
    if (typeof t === 'string' || typeof t === 'number') tags.push(String(t));
    else return `"tags" entries must be text; got ${JSON.stringify(t)}`;
  }
  const claimed = map.get('claimed_by');
  const created = map.get('created');
  const updated = map.get('updated');
  const f: ParsedFields = {
    kind: kind as Kind,
    title: title.trim(),
    blockedBy,
    tags,
  };
  if (!element) f.status = status as Status;
  if (typeof type === 'string') f.type = type as ItemType;
  if (kind === 'ticket' && map.has('components')) {
    const components: string[] = [];
    for (const c of asList(map.get('components'))) {
      if (typeof c === 'string' && c.trim() !== '') components.push(c.trim());
      else return `"components" entries must be element slugs (text); got ${JSON.stringify(c)}`;
    }
    f.components = components;
  }
  if (element) {
    const review = map.get('review') ?? 'proposed';
    if (typeof review !== 'string' || !(REVIEWS as readonly string[]).includes(review)) {
      return `"review" must be one of ${REVIEWS.join(', ')}; got ${JSON.stringify(review)}`;
    }
    f.review = review as Review;
    const parent = map.get('parent');
    if (parent !== undefined && parent !== null) {
      if (typeof parent !== 'string' || parent.trim() === '') return `"parent" must be a container slug; got ${JSON.stringify(parent)}`;
      f.parent = parent.trim();
    }
    const code: string[] = [];
    for (const c of asList(map.get('code'))) {
      if (typeof c === 'string' && c.trim() !== '') code.push(c.trim());
      else return `"code" entries must be repo-relative paths (text); got ${JSON.stringify(c)}`;
    }
    f.code = code;
    if (usesRaw !== undefined) {
      const uses = parseUses(usesRaw);
      if (typeof uses === 'string') return uses;
      f.uses = uses;
    } else f.uses = [];
  }
  if (claimed !== undefined && claimed !== null && claimed !== '') f.claimedBy = String(claimed);
  if (created !== undefined && created !== null) f.created = String(created);
  if (updated !== undefined && updated !== null) f.updated = String(updated);
  return f;
}

const KNOWN_KEYS = new Set(['kind', 'title', 'status', 'type', 'claimed_by', 'blocked_by', 'tags', 'created', 'updated', 'components', 'review', 'parent', 'uses', 'code']);

/** True when `tag` follows the native tag rule (lowercase `[a-z0-9-]`). Reads are lenient; writes enforce it. */
export const isValidTag = (tag: string): boolean => TAG_RE.test(tag);

function parseSections(body: string, bodyStart: number): Section[] {
  const out: Section[] = [];
  let fence: string | null = null;
  for (const ln of lines(body)) {
    const fm = /^\s*(```+|~~~+)/.exec(ln.text);
    if (fm) {
      const marker = fm[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^##[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(ln.text);
    if (h && !ln.text.startsWith('###')) {
      const prev = out[out.length - 1];
      if (prev) prev.end = bodyStart + ln.start;
      out.push({ heading: h[1]!.trim(), start: bodyStart + ln.start, contentStart: bodyStart + ln.next, end: bodyStart + body.length });
    }
  }
  return out;
}

function parseAcs(text: string, sections: Section[]): AcceptanceCriterion[] {
  const sec = sections.find((s) => s.heading.toLowerCase() === AC_SECTION);
  if (!sec) return [];
  const acs: AcceptanceCriterion[] = [];
  for (const ln of lines(text.slice(sec.contentStart, sec.end))) {
    const m = /^- \[([ xX])\]\s?(?:#(\d+)\b\s?)?(.*)$/.exec(ln.text);
    if (!m) continue;
    acs.push({
      n: m[2] === undefined ? null : Number(m[2]),
      text: m[3]!,
      checked: m[1] !== ' ',
      start: sec.contentStart + ln.start,
      end: sec.contentStart + ln.end,
    });
  }
  return acs;
}

/** Parses one item file. Never throws: a file that does not parse comes back `{ok: false, error}`. */
export function parseItem(bytes: Uint8Array | string): ParseResult {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hash = contentHash(buf);
  let text = buf.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const common: Common = { hash, bom, eol: detectEol(text), text };
  const invalid = (error: string): InvalidParse => ({ ...common, ok: false, error });

  const first = /^---[ \t]*(\r?\n|$)/.exec(text);
  if (!first) return invalid('the file does not start with a "---" frontmatter line; add frontmatter');
  const fmResult = parseFrontmatter(text, first[0].length);
  if ('error' in fmResult) return invalid(fmResult.error);

  const map = new Map(fmResult.entries.map((e) => [e.key, e.value] as const));
  const fields = buildFields(map, fmResult.entries.find((e) => e.key === 'uses')?.raw);
  if (typeof fields === 'string') return invalid(fields);

  const bodyStart = fmResult.bodyStart;
  const body = text.slice(bodyStart);
  const sections = parseSections(body, bodyStart);
  const extra: Record<string, FmValue> = {};
  for (const e of fmResult.entries) if (!KNOWN_KEYS.has(e.key)) extra[e.key] = e.value;
  return { ...common, ok: true, fields, entries: fmResult.entries, extra, bodyStart, body, sections, acs: parseAcs(text, sections) };
}
