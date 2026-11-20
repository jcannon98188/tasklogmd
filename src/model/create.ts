// Pure rendering of new item files (spec section 3: "New files use LF and canonical key order") and the
// numbering and slug rules. No I/O; `daemon/writes.ts` does the writing.

import { TaskLogError } from '../errors.ts';
import { ARCHITECTURE_DIR } from './index.ts';
import { checkNoHeading, normalizeBlockedBy, normalizeTags, renderString } from './edit.ts';
import { TYPES } from './parse.ts';

export const MAP_HEADINGS = ['Destination', 'Notes', 'Decisions so far', 'Not yet specified', 'Out of scope'] as const;

const bad = (message: string, details?: Record<string, unknown>): TaskLogError => new TaskLogError('bad_request', { message, details });

/** Lowercase kebab-case, `[a-z0-9-]` only; '' when nothing usable remains. */
export function slugify(s: string, max = 60): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '');
}

/** Effort names are directory names: lowercase kebab-case, so they are safe and unambiguous on any file system. */
export function checkEffortName(effort: unknown): string {
  if (typeof effort !== 'string' || effort.trim() === '') throw bad('effort is required: the name of the effort (a lowercase kebab-case directory name such as "billing-v2").');
  if (effort === ARCHITECTURE_DIR) throw bad(`"${ARCHITECTURE_DIR}" is reserved for the architecture elements; pick another effort name.`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(effort)) {
    throw bad(`effort ${JSON.stringify(effort)} must be lowercase kebab-case ([a-z0-9-], not starting with "-"); try ${JSON.stringify(slugify(effort) || 'my-effort')}.`);
  }
  return effort;
}

export function checkTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim() === '') throw bad('title is required and must not be empty.');
  if (/[\r\n]/.test(title)) throw bad('title must be a single line.');
  return title.trim();
}

/** `YYYY-MM-DD` (UTC) for `created` and `updated`. */
export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function frontmatter(pairs: Array<[string, string | undefined]>): string {
  return `---\n${pairs.filter((p): p is [string, string] => p[1] !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
}

const trimBlock = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');

export function renderMap(title: string, destination: string | undefined, date: string): string {
  const dest = destination === undefined ? '' : trimBlock(destination);
  if (dest) checkNoHeading(dest);
  const fm = frontmatter([
    ['kind', 'map'],
    ['title', renderString(title, 'plain')],
    ['status', 'open'],
    ['created', date],
    ['updated', date],
  ]);
  const sections = MAP_HEADINGS.map((h) => (h === 'Destination' && dest ? `## ${h}\n\n${dest}\n` : `## ${h}\n`));
  return `${fm}\n${sections.join('\n')}`;
}

export function renderSpec(title: string, date: string): string {
  return `${frontmatter([
    ['kind', 'spec'],
    ['title', renderString(title, 'plain')],
    ['status', 'open'],
    ['created', date],
    ['updated', date],
  ])}\n`;
}

export interface NewTicket {
  effort: string;
  number: number;
  title: string;
  type?: string | null;
  question: string;
  blocked_by?: Array<number | string>;
  tags?: string[];
}

export const ticketId = (effort: string, n: number): string => `${effort}/${String(n).padStart(2, '0')}`;

/** File name `NN-slug.md` (`NN.md` when the title has no usable characters). */
export function ticketFileName(n: number, title: string): string {
  const slug = slugify(title);
  return `${String(n).padStart(2, '0')}${slug ? `-${slug}` : ''}.md`;
}

export function renderTicket(t: NewTicket, date: string): string {
  const question = trimBlock(t.question ?? '');
  if (question === '') throw bad('question is required and must not be empty.');
  checkNoHeading(question);
  if (t.type != null && !(TYPES as readonly string[]).includes(t.type)) throw bad(`type must be one of ${TYPES.join(', ')}, or omitted.`);
  const tags = t.tags ? normalizeTags(t.tags) : [];
  const blocked = t.blocked_by ? normalizeBlockedBy(t.blocked_by, { id: ticketId(t.effort, t.number), effort: t.effort }) : [];
  const item = (v: number | string): string => (typeof v === 'number' ? String(v) : JSON.stringify(v));
  const fm = frontmatter([
    ['kind', 'ticket'],
    ['title', renderString(t.title, 'plain')],
    ['status', 'open'],
    ['type', t.type ?? undefined],
    ['blocked_by', blocked.length > 0 ? `[${blocked.map(item).join(', ')}]` : undefined],
    ['tags', tags.length > 0 ? `[${tags.join(', ')}]` : undefined],
    ['created', date],
    ['updated', date],
  ]);
  return `${fm}\n## Question\n\n${question}\n`;
}
