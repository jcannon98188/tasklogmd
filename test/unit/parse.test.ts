import { describe, expect, it } from 'vitest';
import { contentHash, parseItem, type ValidParse } from '../../src/model/parse.ts';

const ticket = (extraFm = '', body = '## Question\n\nWhat?\n') =>
  `---\nkind: ticket\ntitle: A title\nstatus: open\n${extraFm}---\n\n${body}`;

function valid(input: string | Uint8Array): ValidParse {
  const r = parseItem(input);
  if (!r.ok) throw new Error(`expected valid, got: ${r.error}`);
  return r;
}

describe('parseItem: fields', () => {
  it('reads the schema fields', () => {
    const p = valid(
      ticket('type: research\nclaimed_by: agent-1\nblocked_by: [1, 2, "other/03"]\ntags: [a, b-c]\ncreated: 2026-01-01\nupdated: 2026-01-02\n').replace('open', 'claimed'),
    );
    expect(p.fields).toEqual({
      kind: 'ticket',
      title: 'A title',
      status: 'claimed',
      type: 'research',
      claimedBy: 'agent-1',
      blockedBy: [1, 2, 'other/03'],
      tags: ['a', 'b-c'],
      created: '2026-01-01',
      updated: '2026-01-02',
    });
  });

  it('reads block-list tags and an empty inline list', () => {
    expect(valid(ticket('tags:\n  - x\n  - y\nblocked_by: []\n')).fields).toMatchObject({ tags: ['x', 'y'], blockedBy: [] });
    expect(valid(ticket('tags:\n- x\n- y\n')).fields.tags).toEqual(['x', 'y']);
  });

  it('omits type and claimed_by when absent', () => {
    const f = valid(ticket()).fields;
    expect(f).not.toHaveProperty('type');
    expect(f).not.toHaveProperty('claimedBy');
  });

  it('unquotes titles and ignores trailing comments', () => {
    expect(valid(ticket('').replace('A title', '"Quoted: title"')).fields.title).toBe('Quoted: title');
    expect(valid(ticket('tags: [a]   # note\n')).fields.tags).toEqual(['a']);
  });
});

describe('parseItem: invalid files', () => {
  it.each([
    ['no frontmatter', '# heading\n', /does not start with/],
    ['unclosed frontmatter', '---\nkind: ticket\ntitle: x\nstatus: open\n', /not closed/],
    ['bad status', ticket().replace('status: open', 'status: doing'), /"status"/],
    ['bad kind', ticket().replace('kind: ticket', 'kind: epic'), /"kind"/],
    ['missing title', '---\nkind: ticket\nstatus: open\n---\n', /"title"/],
    ['bad type', ticket('type: nope\n'), /"type"/],
    ['duplicate key', ticket('status: open\n'), /appears twice/],
    ['garbage line', ticket('this is not yaml\n'), /not "key: value"/],
  ])('%s', (_name, input, error) => {
    const r = parseItem(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it('still hashes and keeps the text of an invalid file', () => {
    const r = parseItem('# nope\n');
    expect(r.hash).toBe(contentHash('# nope\n'));
    expect(r.text).toBe('# nope\n');
  });
});

describe('parseItem: preservation', () => {
  it('preserves unknown frontmatter keys, in order, with raw text', () => {
    const p = valid(ticket("owner: 'jason'\npriority: high   # why\nextra:\n  - 1\n  - 2\n"));
    expect(p.extra).toEqual({ owner: 'jason', priority: 'high', extra: [1, 2] });
    expect(p.entries.map((e) => e.key)).toEqual(['kind', 'title', 'status', 'owner', 'priority', 'extra']);
    expect(p.entries.find((e) => e.key === 'priority')!.raw).toBe('priority: high   # why');
    expect(p.entries.find((e) => e.key === 'extra')!.raw).toBe('extra:\n  - 1\n  - 2');
  });

  it('keeps entry offsets pointing at the exact text', () => {
    const p = valid(ticket('tags: [a]\n'));
    for (const e of p.entries) expect(p.text.slice(e.start, e.end)).toBe(e.raw);
  });

  it('keeps CRLF text byte-identical and reports crlf', () => {
    const src = ticket('tags: [a]\n').replace(/\n/g, '\r\n');
    const p = valid(src);
    expect(p.eol).toBe('crlf');
    expect(p.text).toBe(src);
    expect(p.fields.title).toBe('A title');
    expect(p.body.startsWith('\r\n## Question')).toBe(true);
  });

  it('reports lf, mixed and none', () => {
    expect(valid(ticket()).eol).toBe('lf');
    expect(valid(ticket().replace('open\n', 'open\r\n')).eol).toBe('mixed');
    expect(valid('---\nkind: map\ntitle: t\nstatus: open\n---').eol).toBe('lf');
  });

  it('strips a UTF-8 BOM from the text, flags it, and still hashes the original bytes', () => {
    const bytes = Buffer.from('﻿' + ticket(), 'utf8');
    const p = valid(bytes);
    expect(p.bom).toBe(true);
    expect(p.text.startsWith('---')).toBe(true);
    expect(p.hash).toBe(contentHash(bytes));
    expect(p.hash).not.toBe(contentHash(ticket()));
  });

  it('records every section, unknown ones included, in file order', () => {
    const p = valid(ticket('', '## Question\n\nQ\n\n## Implementation plan\n\nplan\n\n## Comments\n\nnote\n'));
    expect(p.sections.map((s) => s.heading)).toEqual(['Question', 'Implementation plan', 'Comments']);
    const plan = p.sections[1]!;
    expect(p.text.slice(plan.start, plan.end)).toBe('## Implementation plan\n\nplan\n\n');
    expect(p.text.slice(plan.contentStart, plan.end)).toBe('\nplan\n\n');
  });

  it('does not treat ### headings or fenced "## " lines as sections', () => {
    const p = valid(ticket('', '## Question\n\n### Sub\n\n```\n## not a heading\n```\n'));
    expect(p.sections.map((s) => s.heading)).toEqual(['Question']);
  });
});

describe('parseItem: acceptance criteria', () => {
  it('parses numbered, unnumbered and checked ACs with offsets', () => {
    const body = '## Acceptance criteria\n\n- [ ] #1 First\n- [x] #2 Second\n- [ ] Hand-added\n- not an ac\n\n## Answer\n\n- [ ] #9 outside\n';
    const p = valid(ticket('', body));
    expect(p.acs.map(({ n, text, checked }) => ({ n, text, checked }))).toEqual([
      { n: 1, text: 'First', checked: false },
      { n: 2, text: 'Second', checked: true },
      { n: null, text: 'Hand-added', checked: false },
    ]);
    for (const a of p.acs) expect(p.text.slice(a.start, a.end).startsWith('- [')).toBe(true);
  });
});
