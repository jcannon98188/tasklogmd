// The minimal-diff editor (spec sections 3 and 5). Pure: a valid parse result plus one edit in, new file
// text out. Every edit patches the original text in place using the offsets the parser recorded, so CRLF,
// key order, comments, quoting, blank lines and unknown sections survive byte-for-byte, and a one-field
// edit changes exactly one line. No filesystem, no clock: the write protocol lives in `daemon/writes.ts`.
//
// Every edit is wrapped by two housekeeping steps: hand-added ACs without a number get the next free one
// (before and after the edit), and the result must still parse, otherwise the edit is refused.

import { TaskLogError } from '../errors.ts';
import { isElementKind, isValidTag, parseItem, REVIEWS, TYPES, type Use, type ValidParse } from './parse.ts';
import { normalizeRepoPath } from './repo-path.ts';

export type Edit =
  | {
      op: 'set_fields';
      title?: string;
      type?: string | null;
      tags?: string[];
      blocked_by?: Array<number | string>;
      reopen?: boolean;
      /** Tickets only. */
      components?: string[];
      /** Elements only: */
      review?: string;
      parent?: string | null;
      uses?: Array<{ to: string; label?: string }>;
      code?: string[];
    }
  | { op: 'replace_section'; heading: string; content: string }
  | { op: 'append_to_section'; heading: string; content: string }
  | { op: 'add_ac'; text: string; checked?: boolean }
  | { op: 'edit_ac'; n: number; text: string }
  | { op: 'toggle_ac'; n: number; checked?: boolean }
  | { op: 'remove_ac'; n: number }
  // Internal: only the workflow tools (claim, release, resolve, close, triage) construct this; no generic tool exposes it.
  | { op: 'set_state'; status?: 'open' | 'claimed' | 'resolved' | 'closed'; claimed_by?: string | null; updated?: string; answer?: string; tags?: string[] };

export type EditOp = Edit['op'];

/** What the editor needs to know about the item beyond its parse result. */
export interface EditContext {
  /** Full Item ID (`effort/NN`). */
  id: string;
  effort: string;
  /** Whether `slug` names an existing container element (the writer supplies it; unit tests may omit it). */
  isContainer?: (slug: string) => boolean;
}

export interface EditResult {
  /** The new file text (without BOM; the writer re-adds it). Equal to the input text for a no-op. */
  text: string;
  /** The AC number the operation touched or created (AC operations only). */
  n?: number;
}

const bad = (message: string, details?: Record<string, unknown>): TaskLogError => new TaskLogError('bad_request', { message, details });

// ---- small text helpers ---------------------------------------------------------------------------------

const splice = (text: string, start: number, end: number, repl: string): string => text.slice(0, start) + repl + text.slice(end);

/** The line ending in use near `pos` (the nearest one before it, else the first in the file, else LF). */
function eolNear(text: string, pos: number): string {
  let i = text.lastIndexOf('\n', Math.max(0, pos - 1));
  if (i === -1) i = text.indexOf('\n');
  if (i === -1) return '\n';
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/** Offset just past the line ending that follows `end` (a line end excluding its EOL). */
function pastEol(text: string, end: number): number {
  if (text[end] === '\r' && text[end + 1] === '\n') return end + 2;
  if (text[end] === '\n') return end + 1;
  return end;
}

interface TextLine {
  start: number;
  end: number;
  text: string;
}

function textLines(text: string, from: number, to: number): TextLine[] {
  const out: TextLine[] = [];
  let pos = from;
  while (pos < to) {
    const nl = text.indexOf('\n', pos);
    const next = nl === -1 || nl >= to ? to : nl + 1;
    let end = nl === -1 || nl >= to ? to : nl;
    if (end > pos && text[end - 1] === '\r' && end < next) end--;
    out.push({ start: pos, end, text: text.slice(pos, end) });
    pos = next;
  }
  return out;
}

function reparse(text: string, what: string): ValidParse {
  const r = parseItem(text);
  if (!r.ok) throw bad(`The ${what} would leave the file unparseable (${r.error}); nothing was written. Adjust the content and retry.`);
  return r;
}

function singleLine(value: string, what: string): string {
  const v = value.trim();
  if (v === '') throw bad(`${what} must not be empty.`);
  if (/[\r\n]/.test(v)) throw bad(`${what} must be a single line.`);
  return v;
}

// ---- frontmatter ----------------------------------------------------------------------------------------

const CANON = ['kind', 'title', 'status', 'review', 'type', 'parent', 'claimed_by', 'blocked_by', 'uses', 'code', 'tags', 'components', 'created', 'updated'];

function isPlainSafe(s: string): boolean {
  if (s === '' || s !== s.trim()) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/: |:$| #/.test(s)) return false;
  if (/^-?\d+$/.test(s) || /^(true|false|null|~)$/.test(s)) return false;
  return true;
}

type Style = 'plain' | 'dq' | 'sq';

export function renderString(s: string, style: Style): string {
  if (/[\r\n]/.test(s)) throw bad('Frontmatter values must be a single line.');
  if (style === 'sq') return `'${s.replace(/'/g, "''")}'`;
  if (style === 'dq' || !isPlainSafe(s)) return JSON.stringify(s);
  return s;
}

const renderItem = (v: number | string): string => (typeof v === 'number' ? String(v) : renderString(v, 'plain'));

function styleOf(valueText: string): Style {
  if (valueText.startsWith('"')) return 'dq';
  if (valueText.startsWith("'")) return 'sq';
  return 'plain';
}

/** Index where a trailing ` # comment` starts outside quotes, or -1. */
function commentStart(v: string): number {
  let quote: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(v[i - 1]!))) return i;
  }
  return -1;
}

type NewValue = string | Array<number | string> | { lines: string[] } | undefined;

const isLines = (v: NewValue): v is { lines: string[] } => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Sets (or with `undefined`, removes) one top-level frontmatter key, in place. An existing entry keeps its
 * position, spacing after the colon, quote style, list style and trailing comment; a new key goes after the
 * nearest preceding key in canonical order.
 */
function setKey(p: ValidParse, key: string, value: NewValue): string {
  const { text } = p;
  const entry = p.entries.find((e) => e.key === key);
  const eol = eolNear(text, entry?.start ?? p.bodyStart);

  if (value === undefined) {
    if (!entry) return text;
    return splice(text, entry.start, pastEol(text, entry.end), '');
  }

  if (!entry) {
    const line = isLines(value) ? value.lines.join(eol) : `${key}: ${Array.isArray(value) ? renderInline(value) : renderString(value, 'plain')}`;
    const idx = CANON.indexOf(key);
    let anchor = p.entries[p.entries.length - 1];
    for (const e of p.entries) {
      const ci = CANON.indexOf(e.key);
      if (ci !== -1 && ci < idx) anchor = e;
    }
    if (!anchor) throw bad('The frontmatter is empty; the file cannot be edited.');
    return splice(text, anchor.end, anchor.end, eol + line);
  }

  if (isLines(value)) return splice(text, entry.start, entry.end, value.lines.join(eol));

  const firstLine = entry.raw.split(/\r?\n/, 1)[0]!;
  const m = /^[A-Za-z_][A-Za-z0-9_-]*:(\s*)(.*)$/.exec(firstLine)!;
  const spacing = m[1] || ' ';
  const rest = m[2]!;
  const cAt = commentStart(rest);
  const valuePart = (cAt === -1 ? rest : rest.slice(0, cAt)).trimEnd();
  const comment = cAt === -1 ? '' : rest.slice(rest.slice(0, cAt).trimEnd().length);
  const multiline = entry.raw.length > firstLine.length;

  let replacement: string;
  if (Array.isArray(value)) {
    if (multiline && valuePart === '') {
      const dash = /^(\s*)-/.exec(entry.raw.split(/\r?\n/)[1] ?? '');
      const indent = dash ? dash[1]! : '  ';
      replacement = value.length === 0 ? `${key}:${spacing}[]${comment}` : [`${key}:${comment}`, ...value.map((v) => `${indent}- ${renderItem(v)}`)].join(eol);
    } else {
      replacement = `${key}:${spacing}${renderInline(value)}${comment}`;
    }
  } else {
    replacement = `${key}:${spacing}${renderString(value, styleOf(valuePart))}${comment}`;
  }
  return splice(text, entry.start, entry.end, replacement);
}

function renderInline(v: Array<number | string>): string {
  return `[${v.map(renderItem).join(', ')}]`;
}

/** Lowercases and reduces a tag to `[a-z0-9-]`; returns '' when nothing usable is left. */
export function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const n = normalizeTag(String(t));
    if (n === '') throw bad(`Tag ${JSON.stringify(t)} has no usable characters; tags are lowercase letters, digits and "-".`);
    if (!isValidTag(n)) throw bad(`Tag ${JSON.stringify(t)} is not valid.`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function normalizeBlockedBy(list: Array<number | string>, ctx: EditContext): Array<number | string> {
  const out: Array<number | string> = [];
  const add = (v: number | string) => {
    if (!out.includes(v)) out.push(v);
  };
  for (const raw of list) {
    let v: number | string = typeof raw === 'string' ? raw.trim() : raw;
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 1) throw bad(`blocked_by entry ${v} must be a positive ticket number or "effort/NN".`);
      if (`${ctx.effort}/${String(v).padStart(2, '0')}` === ctx.id) throw bad('An item cannot be blocked by itself.');
      add(v);
      continue;
    }
    const m = /^([^/\s]+)\/(\d+)$/.exec(v);
    if (!m) throw bad(`blocked_by entry ${JSON.stringify(raw)} must be a ticket number or "effort/NN".`);
    const num = Number(m[2]);
    if (`${m[1]}/${String(num).padStart(2, '0')}` === ctx.id) throw bad('An item cannot be blocked by itself.');
    add(m[1] === ctx.effort ? num : `${m[1]}/${m[2]!.padStart(2, '0')}`);
  }
  return out;
}

const slugOf = (id: string): string => id.slice(id.indexOf('/') + 1);

function normalizeComponents(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const slug = normalizeTag(String(raw));
    if (slug === '') throw bad(`components entry ${JSON.stringify(raw)} has no usable characters; components are element slugs (lowercase letters, digits and "-").`);
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Normalises `code` roots. They are never globs, but real names may contain `[ ] { } * ?` (a `[id]` route directory), so those characters are kept. */
export function normalizeCode(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const p = normalizeRepoPath(String(raw));
    if (p === null) throw bad(`code entry ${JSON.stringify(raw)} is not a repo-relative path inside the workspace; use paths like "src/daemon" (or "." for the workspace root).`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function normalizeUses(list: Array<{ to: string; label?: string }>, self: string): Use[] {
  const out: Use[] = [];
  for (const u of list) {
    const to = normalizeTag(String(u?.to ?? ''));
    if (to === '') throw bad('Each uses entry needs "to": the slug of the element it uses.');
    if (to === self) throw bad(`An element cannot use itself (uses entry "${u.to}").`);
    const label = u.label === undefined ? '' : singleLine(String(u.label), 'uses label');
    if (!out.some((x) => x.to === to)) out.push(label === '' ? { to } : { to, label });
  }
  return out;
}

function usesLines(uses: Use[]): string[] {
  return ['uses:', ...uses.flatMap((u) => [`  - to: ${renderString(u.to, 'plain')}`, ...(u.label === undefined ? [] : [`    label: ${renderString(u.label, 'plain')}`])])];
}

function setFields(p0: ValidParse, e: Extract<Edit, { op: 'set_fields' }>, ctx: EditContext): string {
  const KEYS = ['title', 'type', 'tags', 'blocked_by', 'reopen', 'components', 'review', 'parent', 'uses', 'code'] as const;
  const keys = KEYS.filter((k) => e[k] !== undefined);
  if (keys.length === 0) throw bad('set_fields needs at least one of title, type, tags, blocked_by, reopen, components (tickets) or review, parent, uses, code (elements).');
  const kind = p0.fields.kind;
  const isElement = isElementKind(kind);
  const wrongFor = (what: string, only: string) => bad(`${what} can only be set on ${only}; ${ctx.id} is a ${kind}.`);
  for (const k of ['type', 'tags', 'blocked_by', 'reopen'] as const) {
    if (e[k] !== undefined && isElement) throw bad(`${k} cannot be set on an element; elements have title, review, parent, uses and code. ${ctx.id} is a ${kind}.`);
  }
  if (e.components !== undefined && kind !== 'ticket') throw wrongFor('components', 'tickets');
  for (const k of ['review', 'parent', 'uses', 'code'] as const) {
    if (e[k] !== undefined && !isElement) throw wrongFor(k, 'elements (containers and components)');
  }
  // Validate everything before the first patch, so an invalid edit changes nothing.
  const review = e.review;
  if (review !== undefined && !(REVIEWS as readonly string[]).includes(review)) throw bad(`review must be one of ${REVIEWS.join(', ')}; got ${JSON.stringify(review)}.`);
  let parent: string | null | undefined;
  if (e.parent !== undefined) {
    if (e.parent === null || String(e.parent).trim() === '') parent = null;
    else {
      parent = normalizeTag(String(e.parent));
      if (kind !== 'component') throw bad('Only components have a parent; a container sits at the top of the tree.');
      if (parent === '' || (ctx.isContainer && !ctx.isContainer(parent))) {
        throw bad(`parent ${JSON.stringify(e.parent)} is not an existing container; use a container's slug (list them with list_items kind: container).`);
      }
    }
  }
  const uses = e.uses === undefined ? undefined : normalizeUses(e.uses, slugOf(ctx.id));
  const code = e.code === undefined ? undefined : normalizeCode(e.code);
  const components = e.components === undefined ? undefined : normalizeComponents(e.components);
  let p = p0;
  let text = p.text;
  const step = (fn: (p: ValidParse) => string) => {
    text = fn(p);
    if (text !== p.text) p = reparse(text, 'edit');
  };

  if (e.title !== undefined) {
    const title = singleLine(e.title, 'title');
    step((q) => setKey(q, 'title', title));
  }
  if (e.type !== undefined) {
    if (e.type === null || e.type === '') {
      step((q) => setKey(q, 'type', undefined));
    } else {
      if (!(TYPES as readonly string[]).includes(e.type)) throw bad(`type must be one of ${TYPES.join(', ')}; got ${JSON.stringify(e.type)}.`);
      if (p.fields.kind !== 'ticket') throw bad('Only tickets have a type.');
      step((q) => setKey(q, 'type', e.type!));
    }
  }
  if (e.tags !== undefined) {
    const tags = normalizeTags(e.tags);
    step((q) => (tags.length === 0 && !q.entries.some((x) => x.key === 'tags') ? q.text : setKey(q, 'tags', tags)));
  }
  if (e.blocked_by !== undefined) {
    const list = normalizeBlockedBy(e.blocked_by, ctx);
    step((q) => (list.length === 0 && !q.entries.some((x) => x.key === 'blocked_by') ? q.text : setKey(q, 'blocked_by', list)));
  }
  if (review !== undefined) step((q) => setKey(q, 'review', review));
  if (parent !== undefined) step((q) => setKey(q, 'parent', parent === null ? undefined : parent));
  if (uses !== undefined) {
    step((q) => (uses.length === 0 ? (q.entries.some((x) => x.key === 'uses') ? setKey(q, 'uses', []) : q.text) : setKey(q, 'uses', { lines: usesLines(uses) })));
  }
  if (code !== undefined) step((q) => setKey(q, 'code', code));
  if (components !== undefined) {
    step((q) => (components.length === 0 && !q.entries.some((x) => x.key === 'components') ? q.text : setKey(q, 'components', components)));
  }
  if (e.reopen !== undefined) {
    if (e.reopen !== true) throw bad('reopen can only be true; status is otherwise changed by claim, resolve and close.');
    if (p.fields.status === 'open') throw new TaskLogError('bad_transition', { message: 'The item is already open; nothing to reopen.', details: { id: ctx.id, status: 'open' } });
    step((q) => setKey(q, 'status', 'open'));
    step((q) => setKey(q, 'claimed_by', undefined));
  }
  return text;
}

/** Internal workflow edit: Answer, tags, status, claimed_by and updated in one atomic patch. */
function setState(p0: ValidParse, e: Extract<Edit, { op: 'set_state' }>): string {
  let p = p0;
  let text = p.text;
  const step = (fn: (p: ValidParse) => string) => {
    text = fn(p);
    if (text !== p.text) p = reparse(text, 'edit');
  };
  if (e.answer !== undefined) step((q) => replaceSection(q, { op: 'replace_section', heading: 'Answer', content: e.answer! }));
  if (e.tags !== undefined) {
    const tags = normalizeTags(e.tags);
    step((q) => (tags.length === 0 && !q.entries.some((x) => x.key === 'tags') ? q.text : setKey(q, 'tags', tags)));
  }
  if (e.status !== undefined) step((q) => setKey(q, 'status', e.status!));
  if (e.claimed_by !== undefined) {
    const who = e.claimed_by === null ? undefined : singleLine(e.claimed_by, 'claimed_by');
    step((q) => setKey(q, 'claimed_by', who));
  }
  if (e.updated !== undefined) step((q) => setKey(q, 'updated', e.updated!));
  return text;
}

// ---- sections -------------------------------------------------------------------------------------------

/** Drops a closing hash sequence, but only when whitespace precedes it (so `C#` stays `C#`). */
const stripClosingHashes = (h: string): string => h.replace(/[ \t]+#+$/, '');

const normHeading = (h: string): string => stripClosingHashes(h.replace(/^#+\s*/, '').trim()).trim().toLowerCase();

function findSection(p: ValidParse, heading: string) {
  return p.sections.find((s) => normHeading(s.heading) === normHeading(heading));
}

function checkHeading(heading: string): string {
  const h = heading.replace(/^#+\s*/, '').trim();
  if (h === '') throw bad('heading must not be empty.');
  if (/[\r\n]/.test(h)) throw bad('heading must be a single line.');
  return h;
}

/** Rejects content that would start a new `##` section (outside code fences), which would restructure the file. */
export function checkNoHeading(content: string): void {
  let fence: string | null = null;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fm = /^\s*(```+|~~~+)/.exec(line);
    if (fm) {
      const marker = fm[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null && /^##[ \t]/.test(line)) {
      const shown = JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}...` : line);
      throw bad(
        `Section content must not contain a "## " heading line (line ${i + 1}: ${shown}); write each section separately with replace_section, or pass resolve an answer_sections map. Use ### for sub-headings.`,
      );
    }
  }
}

/** Splits content into lines, dropping blank lines at the end (and at the start when `trimStart`). */
function contentLines(content: string, trimStart: boolean): string[] {
  const lines = content.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  if (trimStart) while (lines.length && lines[0]!.trim() === '') lines.shift();
  if (lines.length === 0) throw bad('content must not be empty.');
  return lines;
}

/** Adds a new section: before `## Answer` for the acceptance criteria, otherwise at the end of the file. */
function addSection(p: ValidParse, heading: string, lines: string[]): string {
  const { text } = p;
  const eol = eolNear(text, text.length);
  const block = [`## ${heading}`, '', ...lines].join(eol) + eol;
  if (normHeading(heading) === 'acceptance criteria') {
    const answer = findSection(p, 'Answer');
    if (answer) return splice(text, answer.start, answer.start, block + eol);
  }
  let prefix = '';
  if (text.length > p.bodyStart) {
    if (!text.endsWith('\n')) prefix = eol + eol;
    else if (!/\n\r?\n$/.test(text)) prefix = eol;
  }
  return text + prefix + block;
}

function replaceSection(p: ValidParse, e: Extract<Edit, { op: 'replace_section' }>): string {
  const heading = checkHeading(e.heading);
  checkNoHeading(e.content);
  const lines = e.content.trim() === '' ? [] : contentLines(e.content, true);
  const sec = findSection(p, heading);
  if (!sec) {
    if (lines.length === 0) return p.text;
    return addSection(p, heading, lines);
  }
  const { text } = p;
  const eol = eolNear(text, sec.start);
  const isLast = sec.end >= text.length;
  const body = textLines(text, sec.contentStart, sec.end);
  const nonBlank = body.filter((l) => l.text.trim() !== '');
  if (nonBlank.length === 0) {
    if (lines.length === 0) return text;
    return splice(text, sec.contentStart, sec.end, eol + lines.join(eol) + eol + (isLast ? '' : eol));
  }
  const first = nonBlank[0]!;
  const last = nonBlank[nonBlank.length - 1]!;
  if (lines.length === 0) return splice(text, sec.contentStart, sec.end, eol + (isLast ? '' : eol));
  return splice(text, first.start, last.end, lines.join(eol));
}

function appendToSection(p: ValidParse, e: Extract<Edit, { op: 'append_to_section' }>): string {
  const heading = checkHeading(e.heading);
  checkNoHeading(e.content);
  const lines = contentLines(e.content, false);
  return appendLines(p, heading, lines);
}

function appendLines(p: ValidParse, heading: string, lines: string[]): string {
  const sec = findSection(p, heading);
  if (!sec) return addSection(p, heading, lines.filter((l, i) => l.trim() !== '' || lines.slice(0, i).some((x) => x.trim() !== '')));
  const { text } = p;
  const eol = eolNear(text, sec.start);
  const nonBlank = textLines(text, sec.contentStart, sec.end).filter((l) => l.text.trim() !== '');
  if (nonBlank.length === 0) {
    const isLast = sec.end >= text.length;
    return splice(text, sec.contentStart, sec.end, eol + lines.join(eol) + eol + (isLast ? '' : eol));
  }
  const last = nonBlank[nonBlank.length - 1]!;
  return splice(text, last.end, last.end, eol + lines.join(eol));
}

// ---- acceptance criteria --------------------------------------------------------------------------------

/** Gives every hand-added AC without a number the next free one, in file order. */
function renumber(p: ValidParse): string {
  if (!p.acs.some((a) => a.n === null)) return p.text;
  let next = Math.max(0, ...p.acs.map((a) => a.n ?? 0)) + 1;
  let out = '';
  let pos = 0;
  for (const a of p.acs) {
    if (a.n !== null) continue;
    const line = p.text.slice(a.start, a.end);
    const rest = line.slice(5);
    const body = rest.startsWith(' ') ? rest.slice(1) : rest;
    out += p.text.slice(pos, a.start) + `${line.slice(0, 5)} #${next++}${body === '' ? '' : ` ${body}`}`;
    pos = a.end;
  }
  return out + p.text.slice(pos);
}

function acText(text: string): string {
  const v = singleLine(text, 'text');
  if (/^#\d+\b/.test(v)) throw bad('AC text must not start with "#N"; the number is assigned automatically.');
  return v;
}

function findAc(p: ValidParse, n: number, ctx: EditContext) {
  if (!Number.isInteger(n) || n < 1) throw bad('n must be a positive AC number.');
  const hits = p.acs.filter((a) => a.n === n);
  if (hits.length === 0) throw new TaskLogError('not_found', { message: `${ctx.id} has no acceptance criterion #${n}; check the numbers with get_item.`, details: { id: ctx.id, n } });
  if (hits.length > 1) throw bad(`${ctx.id} has ${hits.length} acceptance criteria numbered #${n}; fix the duplicate numbers on disk first.`, { id: ctx.id, n });
  return hits[0]!;
}

function addAc(p: ValidParse, e: Extract<Edit, { op: 'add_ac' }>): EditResult {
  const text = acText(e.text);
  const n = Math.max(0, ...p.acs.map((a) => a.n ?? 0)) + 1;
  const line = `- [${e.checked ? 'x' : ' '}] #${n} ${text}`;
  const last = p.acs[p.acs.length - 1];
  if (last) return { text: splice(p.text, last.end, last.end, eolNear(p.text, last.end) + line), n };
  return { text: appendLines(p, 'Acceptance criteria', [line]), n };
}

function editAc(p: ValidParse, e: Extract<Edit, { op: 'edit_ac' }>, ctx: EditContext): EditResult {
  const text = acText(e.text);
  const ac = findAc(p, e.n, ctx);
  const from = ac.end - ac.text.length;
  // An AC with empty text has nothing after "#N" to separate the new text from it.
  const sep = ac.n !== null && from > 0 && !/\s/.test(p.text[from - 1]!) ? ' ' : '';
  return { text: splice(p.text, from, ac.end, sep + text), n: e.n };
}

function toggleAc(p: ValidParse, e: Extract<Edit, { op: 'toggle_ac' }>, ctx: EditContext): EditResult {
  const ac = findAc(p, e.n, ctx);
  const checked = e.checked ?? !ac.checked;
  if (checked === ac.checked) return { text: p.text, n: e.n };
  return { text: splice(p.text, ac.start + 3, ac.start + 4, checked ? 'x' : ' '), n: e.n };
}

function removeAc(p: ValidParse, e: Extract<Edit, { op: 'remove_ac' }>, ctx: EditContext): EditResult {
  const ac = findAc(p, e.n, ctx);
  const { text } = p;
  const after = pastEol(text, ac.end);
  if (after === ac.end && ac.start > 0) {
    // Last line of the file with no line ending: drop the line ending before it instead.
    const before = text.slice(0, ac.start).replace(/\r?\n$/, '');
    return { text: before + text.slice(after), n: e.n };
  }
  return { text: splice(text, ac.start, after, ''), n: e.n };
}

// ---- entry point ----------------------------------------------------------------------------------------

/**
 * Applies one edit to a valid parse result and returns the new text. Throws `bad_request` for invalid
 * arguments, `not_found` for a missing AC, `bad_transition` for a reopen of an open item. An edit that
 * changes nothing returns the input text unchanged.
 */
export function applyEdit(parse: ValidParse, edit: Edit, ctx: EditContext): EditResult {
  let p = parse;
  const pre = renumber(p);
  if (pre !== p.text) p = reparse(pre, 'AC numbering');

  let res: EditResult;
  switch (edit.op) {
    case 'set_fields':
      res = { text: setFields(p, edit, ctx) };
      break;
    case 'set_state':
      res = { text: setState(p, edit) };
      break;
    case 'replace_section':
      res = { text: replaceSection(p, edit) };
      break;
    case 'append_to_section':
      res = { text: appendToSection(p, edit) };
      break;
    case 'add_ac':
      res = addAc(p, edit);
      break;
    case 'edit_ac':
      res = editAc(p, edit, ctx);
      break;
    case 'toggle_ac':
      res = toggleAc(p, edit, ctx);
      break;
    case 'remove_ac':
      res = removeAc(p, edit, ctx);
      break;
  }
  const checked = reparse(res.text, 'edit');
  const text = renumber(checked);
  if (text !== checked.text) reparse(text, 'AC numbering');
  return { ...res, text };
}
