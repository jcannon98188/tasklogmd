// Read-only workflow queries over a workspace index (spec section 5): `frontier` and `overview`.
// Pure with respect to the file system; the clock is passed in so staleness is testable.

import { TaskLogError } from '../errors.ts';
import { normalizeId, resolveBlockers, type IndexEntry, type WorkspaceIndex } from './index.ts';
import type { ValidParse } from './parse.ts';

export const DEFAULT_STALE_MS = 24 * 3600 * 1000;

const HOUR = 3600 * 1000;

/** Accepts hours as a number, or a string like "90m", "24h", "2d", "30s"; a bare numeric string is hours. */
export function parseStaleAfter(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_STALE_MS;
  const bad = () => new TaskLogError('bad_request', { message: `stale_after ${JSON.stringify(v)} must be a number of hours or a duration such as "90m", "24h" or "2d".` });
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw bad();
    return v * HOUR;
  }
  if (typeof v !== 'string') throw bad();
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)?\s*$/i.exec(v);
  if (!m) throw bad();
  const unit = (m[2] ?? 'h').toLowerCase();
  return Number(m[1]) * { s: 1000, m: 60_000, h: HOUR, d: 24 * HOUR }[unit]!;
}

export function formatAge(ms: number | null): string {
  if (ms === null) return 'unknown age';
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Milliseconds since `updated` (a date or a timestamp), or null when it is missing or unreadable. */
export function ageOf(updated: string | undefined, now: number): number | null {
  if (!updated) return null;
  const t = Date.parse(updated);
  return Number.isNaN(t) ? null : Math.max(0, now - t);
}

/** Text of one `##` section of a map or ticket (trimmed), or undefined when the section is missing. */
export function sectionText(p: ValidParse, heading: string): string | undefined {
  const want = heading.toLowerCase();
  const s = p.sections.find((x) => x.heading.replace(/^#+\s*/, '').trim().toLowerCase() === want);
  return s ? p.text.slice(s.contentStart, s.end).trim() : undefined;
}

export interface TicketRef {
  id: string;
  title: string;
  type: string | null;
  tags: string[];
  hash: string;
  blocked_by: string[];
}

export interface ClaimedRef extends TicketRef {
  claimed_by: string | null;
  age_seconds: number | null;
  age: string;
  stale: boolean;
}

export interface BlockReason {
  blocker: string;
  /** `open | claimed` (not done), or a problem: `missing | conflicted | invalid`. */
  state: string;
  title?: string;
  message: string;
}

export interface BlockedRef extends TicketRef {
  reasons: BlockReason[];
}

export interface Frontier {
  effort: string;
  ready: TicketRef[];
  claimed: ClaimedRef[];
  blocked: BlockedRef[];
}

export interface FrontierOptions {
  type?: string;
  tags?: string[];
  staleMs?: number;
  now: number;
}

function ticketEntries(idx: WorkspaceIndex, effort: string): IndexEntry[] {
  return idx.entries().filter((e) => e.effort === effort && e.layoutKind === 'ticket');
}

function ref(e: IndexEntry): TicketRef {
  const f = (e.parse as ValidParse).fields;
  return { id: e.id, title: f.title, type: f.type ?? null, tags: f.tags, hash: e.hash, blocked_by: resolveBlockers(e) };
}

/** Why one blocker keeps a ticket from being ready; null when it is resolved or closed. */
function blockReason(idx: WorkspaceIndex, blockerId: string): BlockReason | null {
  const list = idx.entriesForId(blockerId);
  if (list.length === 0) return { blocker: blockerId, state: 'missing', message: `${blockerId} does not exist; fix blocked_by or create it.` };
  if (list.length > 1) return { blocker: blockerId, state: 'conflicted', message: `${blockerId} is claimed by more than one file (${list.map((e) => e.path).join(', ')}); resolve the duplicate on disk.` };
  const e = list[0]!;
  if (!e.parse.ok) return { blocker: blockerId, state: 'invalid', message: `${blockerId} does not parse (${e.parse.error}); fix it on disk.` };
  const { status, title } = e.parse.fields;
  if (status === undefined) return { blocker: blockerId, state: 'invalid', message: `${blockerId} is a ${e.parse.fields.kind}, not a ticket; blocked_by takes ticket IDs.` };
  if (status === 'resolved' || status === 'closed') return null;
  return { blocker: blockerId, state: status, title, message: `${blockerId} "${title}" is ${status}.` };
}

/** Ready, claimed (with age and stale flag) and blocked tickets of one effort, in ticket-number order. */
export function computeFrontier(idx: WorkspaceIndex, effort: string, opts: FrontierOptions): Frontier {
  const all = idx.entries().filter((e) => e.effort === effort && e.layoutKind !== 'element');
  if (all.length === 0) throw new TaskLogError('not_found', { message: `No effort "${effort}"; check the name with list_items.`, details: { effort } });
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const tags = (opts.tags ?? []).map((t) => t.toLowerCase());
  const out: Frontier = { effort, ready: [], claimed: [], blocked: [] };
  for (const e of ticketEntries(idx, effort)) {
    if (!e.parse.ok || idx.entriesForId(e.id).length > 1) continue; // surfaced by list_items and workspace_status
    const f = e.parse.fields;
    if (opts.type !== undefined && f.type !== opts.type) continue;
    if (tags.length > 0 && !tags.every((t) => f.tags.includes(t))) continue;
    if (f.status === 'open') {
      const reasons = resolveBlockers(e).map((b) => blockReason(idx, b)).filter((r): r is BlockReason => r !== null);
      if (reasons.length === 0) out.ready.push(ref(e));
      else out.blocked.push({ ...ref(e), reasons });
    } else if (f.status === 'claimed') {
      const age = ageOf(f.updated, opts.now);
      out.claimed.push({ ...ref(e), claimed_by: f.claimedBy ?? null, age_seconds: age === null ? null : Math.round(age / 1000), age: formatAge(age), stale: age === null || age >= staleMs });
    }
  }
  return out;
}

// ---- overview -------------------------------------------------------------------------------------------

export interface DecisionLine {
  title: string;
  target: string;
  gist: string;
  /** The ticket it points at (when found in the effort). */
  ticket?: string;
}

export interface DriftFlag {
  type: 'resolved_without_decision' | 'decision_for_unresolved';
  id: string;
  message: string;
}

export interface EffortOverview {
  effort: string;
  title: string | null;
  destination: string | null;
  counts: Record<string, number>;
  /** `gist` is present only for a verbose overview. */
  done: Array<{ id: string; title: string; gist?: string | null }>;
  in_progress: ClaimedRef[];
  ready: TicketRef[];
  blocked: BlockedRef[];
  still_to_do: string | null;
  ruled_out: { closed: Array<{ id: string; title: string }>; out_of_scope: string | null };
  drift: DriftFlag[];
  warnings: string[];
}

export interface EffortLine {
  effort: string;
  title: string | null;
  counts: Record<string, number>;
  destination: string | null;
}

const LINE = /^\s*[-*]\s+\[([^\]]*)\]\(([^)\s]+)\)\s*:?\s*(.*)$/;

/** Parses `- [title](tickets/NN-slug.md): gist` lines of a map section. Other lines are ignored. */
export function parseLinkLines(section: string | undefined): DecisionLine[] {
  const out: DecisionLine[] = [];
  for (const line of (section ?? '').split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.push({ title: m[1]!, target: m[2]!, gist: m[3]!.trim() });
  }
  return out;
}

/** Link target (relative to the map's directory) of a ticket entry, e.g. `tickets/03-x.md`. */
export const targetOf = (e: IndexEntry): string => e.path.split('/').slice(2).join('/');

const normTarget = (t: string): string => t.replace(/^\.\//, '').replace(/[#?].*$/, '').toLowerCase();

function findTicket(tickets: IndexEntry[], target: string): IndexEntry | undefined {
  const t = normTarget(target);
  const exact = tickets.find((e) => targetOf(e).toLowerCase() === t);
  if (exact) return exact;
  const m = /^tickets\/(\d+)(?:-[^/]*)?\.md$/.exec(t);
  return m ? tickets.find((e) => e.number === Number(m[1])) : undefined;
}

const firstSentence = (s: string | null): string | null => {
  if (!s) return null;
  const flat = s.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  return (m ? m[1]! : flat.split('\n')[0]!) || null;
};

function countsOf(idx: WorkspaceIndex, effort: string): Record<string, number> {
  const c: Record<string, number> = { open: 0, claimed: 0, resolved: 0, closed: 0 };
  for (const e of ticketEntries(idx, effort)) {
    const st = e.parse.ok ? e.parse.fields.status : undefined;
    if (st) c[st] = (c[st] ?? 0) + 1;
  }
  return c;
}

function mapOf(idx: WorkspaceIndex, effort: string): { parse?: ValidParse; warning?: string } {
  const list = idx.entriesForId(`${effort}/map`);
  if (list.length === 0) return { warning: `${effort}/map does not exist.` };
  if (list.length > 1) return { warning: `${effort}/map is claimed by more than one file.` };
  const e = list[0]!;
  if (!e.parse.ok) return { warning: `${effort}/map does not parse (${e.parse.error}).` };
  return { parse: e.parse };
}

export function computeOverview(idx: WorkspaceIndex, effort: string, opts: { staleMs?: number; now: number; verbose?: boolean }): EffortOverview {
  const fr = computeFrontier(idx, effort, { staleMs: opts.staleMs, now: opts.now });
  const { parse: map, warning } = mapOf(idx, effort);
  const tickets = ticketEntries(idx, effort).filter((e) => e.parse.ok && idx.entriesForId(e.id).length === 1);
  const decisions = parseLinkLines(map ? sectionText(map, 'Decisions so far') : undefined);
  for (const d of decisions) d.ticket = findTicket(tickets, d.target)?.id;

  const done: EffortOverview['done'] = [];
  const drift: DriftFlag[] = [];
  const closed: EffortOverview['ruled_out']['closed'] = [];
  for (const e of tickets) {
    const f = (e.parse as ValidParse).fields;
    if (f.status === 'resolved') {
      const d = decisions.find((x) => x.ticket === e.id);
      done.push(opts.verbose ? { id: e.id, title: f.title, gist: d ? d.gist : null } : { id: e.id, title: f.title });
      if (!d && map) drift.push({ type: 'resolved_without_decision', id: e.id, message: `${e.id} is resolved but has no line in Decisions so far; add one with add_decision or retry resolve with a gist.` });
    } else if (f.status === 'closed') closed.push({ id: e.id, title: f.title });
  }
  for (const d of decisions) {
    if (!d.ticket) continue;
    const e = tickets.find((x) => x.id === d.ticket)!;
    const status = (e.parse as ValidParse).fields.status;
    if (status !== 'resolved') drift.push({ type: 'decision_for_unresolved', id: d.ticket, message: `Decisions so far has a line for ${d.ticket}, which is ${status}, not resolved; reopen-and-resolve it or remove the line by replacing the section.` });
  }

  const mapTitle = map?.fields.title ?? null;
  return {
    effort,
    title: mapTitle,
    destination: map ? sectionText(map, 'Destination') || null : null,
    counts: countsOf(idx, effort),
    done,
    in_progress: fr.claimed,
    ready: fr.ready,
    blocked: fr.blocked,
    still_to_do: map ? sectionText(map, 'Not yet specified') || null : null,
    ruled_out: { closed, out_of_scope: map ? sectionText(map, 'Out of scope') || null : null },
    drift,
    warnings: warning ? [warning] : [],
  };
}

export function computeEffortLines(idx: WorkspaceIndex): EffortLine[] {
  const efforts = [...new Set(idx.entries().filter((e) => e.layoutKind !== 'element').map((e) => e.effort))];
  return efforts.map((effort) => {
    const { parse: map } = mapOf(idx, effort);
    return { effort, title: map?.fields.title ?? null, counts: countsOf(idx, effort), destination: firstSentence(map ? sectionText(map, 'Destination') || null : null) };
  });
}

// ---- markdown -------------------------------------------------------------------------------------------

const countsLine = (c: Record<string, number>): string => `${c.open ?? 0} open, ${c.claimed ?? 0} claimed, ${c.resolved ?? 0} resolved, ${c.closed ?? 0} closed`;

export function overviewMarkdown(o: EffortOverview): string {
  const L: string[] = [`# ${o.title ?? o.effort} (${o.effort})`, ''];
  for (const w of o.warnings) L.push(`> Warning: ${w}`, '');
  L.push('## Destination', '', o.destination ?? '_none_', '', `**Counts:** ${countsLine(o.counts)}`, '');
  L.push('## Done', '');
  L.push(...(o.done.length ? o.done.map((d) => `- ${d.id} ${d.title}${d.gist === undefined ? '' : d.gist ? `: ${d.gist}` : ' (no Decisions line)'}`) : ['_none_']), '');
  L.push('## In progress', '');
  L.push(...(o.in_progress.length ? o.in_progress.map((c) => `- ${c.id} ${c.title} (claimed by ${c.claimed_by ?? 'unknown'}, ${c.age}${c.stale ? ', STALE' : ''})`) : ['_none_']), '');
  L.push('## Ready', '');
  L.push(...(o.ready.length ? o.ready.map((r) => `- ${r.id} ${r.title}${r.type ? ` [${r.type}]` : ''}`) : ['_none_']), '');
  L.push('## Blocked', '');
  L.push(...(o.blocked.length ? o.blocked.map((b) => `- ${b.id} ${b.title}: ${b.reasons.map((r) => (r.title ? `${r.blocker} "${r.title}" ${r.state}` : `${r.blocker} ${r.state}`)).join('; ')}`) : ['_none_']), '');
  L.push('## Still to do', '', o.still_to_do ?? '_none_', '');
  L.push('## Ruled out', '');
  L.push(...(o.ruled_out.closed.length ? o.ruled_out.closed.map((c) => `- ${c.id} ${c.title} (closed)`) : ['_no closed tickets_']), '');
  if (o.ruled_out.out_of_scope) L.push('Out of scope:', '', o.ruled_out.out_of_scope, '');
  if (o.drift.length) L.push('## Drift', '', ...o.drift.map((d) => `- ${d.message}`), '');
  return L.join('\n').replace(/\n+$/, '\n');
}

export function effortLinesMarkdown(lines: EffortLine[]): string {
  if (lines.length === 0) return 'No efforts yet. Start one with create_effort.\n';
  return lines.map((l) => `- ${l.effort}${l.title ? ` (${l.title})` : ''}: ${countsLine(l.counts)}${l.destination ? `. ${l.destination}` : ''}`).join('\n') + '\n';
}
