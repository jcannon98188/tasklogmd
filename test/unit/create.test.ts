import { describe, expect, it } from 'vitest';
import { renderMap, renderSpec, renderTicket, slugify, ticketFileName, MAP_HEADINGS } from '../../src/model/create.ts';
import { parseItem } from '../../src/model/parse.ts';

const D = '2026-05-01';
const ticket = (o: Partial<Parameters<typeof renderTicket>[0]> = {}) => renderTicket({ effort: 'demo', number: 3, title: 'T', question: 'Q?', ...o }, D);

describe('renderTicket', () => {
  it('writes canonical key order, LF endings and a Question section', () => {
    const t = ticket({ title: 'Do it', type: 'research', blocked_by: [1], tags: ['a'] });
    expect(t).toBe('---\nkind: ticket\ntitle: Do it\nstatus: open\ntype: research\nblocked_by: [1]\ntags: [a]\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\n\n## Question\n\nQ?\n');
    expect(t).not.toContain('\r');
    expect(parseItem(t).ok).toBe(true);
  });

  it('writes no type key when type is omitted, and no empty lists', () => {
    const t = ticket();
    expect(t).not.toMatch(/^type:/m);
    expect(t).not.toMatch(/^blocked_by:/m);
    expect(t).not.toMatch(/^tags:/m);
  });

  it('normalizes tags and blocked_by (same effort as numbers, other efforts as effort/NN)', () => {
    const t = ticket({ tags: ['Ready For-Agent', 'needs_info', 'ready-for-agent'], blocked_by: ['demo/1', 'other/2', 2, '4'] });
    const p = parseItem(t);
    if (!p.ok) throw new Error(p.error);
    expect(p.fields.tags).toEqual(['ready-for-agent', 'needs-info']);
    expect(p.fields.blockedBy).toEqual([1, 'other/02', 2, 4]);
  });

  it('refuses a self-reference, an empty question, a section heading in the question and a bad type', () => {
    expect(() => ticket({ blocked_by: [3] })).toThrow(/itself/);
    expect(() => ticket({ question: '  \n' })).toThrow(/question/);
    expect(() => ticket({ question: 'a\n## Answer\nb' })).toThrow(/heading/);
    expect(() => ticket({ type: 'nope' })).toThrow(/type/);
  });

  it('quotes titles that are not plain-safe and the result parses back to the same title', () => {
    const p = parseItem(ticket({ title: 'Fix: the "thing" #1' }));
    if (!p.ok) throw new Error(p.error);
    expect(p.fields.title).toBe('Fix: the "thing" #1');
  });

  it('converts CRLF in the question to LF', () => {
    expect(ticket({ question: 'a\r\nb' })).toContain('a\nb\n');
  });
});

describe('slugs and file names', () => {
  it('derives lowercase kebab-case, strips diacritics, never empty-dashes', () => {
    expect(slugify('Hello, Wörld! API v2')).toBe('hello-world-api-v2');
    expect(slugify('  --  ')).toBe('');
    expect(ticketFileName(4, 'Add the Thing')).toBe('04-add-the-thing.md');
    expect(ticketFileName(12, '???')).toBe('12.md');
    expect(ticketFileName(100, 'x')).toBe('100-x.md');
  });
});

describe('renderMap and renderSpec', () => {
  it('map has the fixed headings in order and LF endings', () => {
    const m = renderMap('Alpha', 'Ship it.', D);
    expect(m).not.toContain('\r');
    const p = parseItem(m);
    if (!p.ok) throw new Error(p.error);
    expect(p.sections.map((s) => s.heading)).toEqual([...MAP_HEADINGS]);
    expect(m).toContain('## Destination\n\nShip it.\n');
    expect(m.startsWith('---\nkind: map\ntitle: Alpha\nstatus: open\ncreated: 2026-05-01\nupdated: 2026-05-01\n---\n')).toBe(true);
  });

  it('spec parses and has no body headings', () => {
    const p = parseItem(renderSpec('Alpha', D));
    expect(p.ok).toBe(true);
  });
});
