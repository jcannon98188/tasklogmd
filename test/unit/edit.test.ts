import { describe, expect, it } from 'vitest';
import { applyEdit, normalizeTag, type Edit } from '../../src/model/edit.ts';
import { parseItem, type ValidParse } from '../../src/model/parse.ts';

const CTX = { id: 'demo/03', effort: 'demo' };

const TICKET = [
  '---',
  '# a leading comment',
  'kind: ticket',
  'title: "Quoted: title"',
  'status: open',
  "owner: 'jason'",
  'priority: high   # trailing comment',
  'tags: [one, two]',
  'created: 2026-01-01',
  'updated: 2026-01-02',
  '---',
  '',
  '## Question',
  '',
  'What now?',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] #1 First',
  '- [x] #2 Second',
  '',
  '## Comments',
  '',
  'Unknown section.',
  '',
].join('\n');

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

function run(text: string, edit: Edit, ctx = CTX) {
  const p = parseItem(text);
  if (!p.ok) throw new Error(p.error);
  return applyEdit(p, edit, ctx);
}

/** Line-level diff of two texts that share their line structure: returns [removed, added] line lists. */
function diff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split('\n');
  const y = b.split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  return { removed: x.slice(s, x.length - e), added: y.slice(s, y.length - e) };
}

describe('set_fields: minimal diff', () => {
  it('a one-field edit changes exactly one line, byte-exact', () => {
    const out = run(TICKET, { op: 'set_fields', title: 'New title' }).text;
    expect(diff(TICKET, out)).toEqual({ removed: ['title: "Quoted: title"'], added: ['title: "New title"'] });
    expect(out).toBe(TICKET.replace('title: "Quoted: title"', 'title: "New title"'));
  });

  it('preserves CRLF, key order, comments, quoting, blank lines and unknown sections', () => {
    const src = crlf(TICKET);
    const out = run(src, { op: 'set_fields', tags: ['Alpha', 'beta gamma'] }).text;
    expect(out).toBe(src.replace('tags: [one, two]', 'tags: [alpha, beta-gamma]'));
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps an inline comment and the quote style of the edited line', () => {
    expect(run(TICKET, { op: 'set_fields', blocked_by: [1, 'other/02'] }).text).toBe(
      TICKET.replace('status: open\n', 'status: open\nblocked_by: [1, other/02]\n'),
    );
    const sq = TICKET.replace('title: "Quoted: title"', "title: 'Single'");
    expect(run(sq, { op: 'set_fields', title: "It's new" }).text).toBe(sq.replace("title: 'Single'", "title: 'It''s new'"));
    const withComment = TICKET.replace('status: open', 'status: open # why');
    expect(run(withComment, { op: 'set_fields', title: 'x' }).text).toContain('status: open # why');
  });

  it('quotes a plain title only when YAML needs it', () => {
    const plain = TICKET.replace('title: "Quoted: title"', 'title: Plain');
    expect(run(plain, { op: 'set_fields', title: 'Another plain' }).text).toContain('title: Another plain\n');
    expect(run(plain, { op: 'set_fields', title: 'has: colon' }).text).toContain('title: "has: colon"\n');
    expect(run(plain, { op: 'set_fields', title: '123' }).text).toContain('title: "123"\n');
    expect(run(plain, { op: 'set_fields', title: 'Café menü' }).text).toContain('title: Café menü\n');
  });

  it('inserts a new key after its canonical predecessor with the file line ending', () => {
    const out = run(crlf(TICKET), { op: 'set_fields', type: 'research' }).text;
    expect(out).toBe(crlf(TICKET).replace('status: open\r\n', 'status: open\r\ntype: research\r\n'));
  });

  it('removes type with null and drops the whole line', () => {
    const typed = TICKET.replace('status: open\n', 'status: open\ntype: task\n');
    expect(run(typed, { op: 'set_fields', type: null }).text).toBe(TICKET);
  });

  it('keeps a block list as a block list', () => {
    const block = TICKET.replace('tags: [one, two]', 'tags:\n  - one\n  - two');
    const out = run(block, { op: 'set_fields', tags: ['one', 'two', 'three'] }).text;
    expect(out).toBe(block.replace('  - two', '  - two\n  - three'));
    expect(run(block, { op: 'set_fields', tags: [] }).text).toBe(TICKET.replace('tags: [one, two]', 'tags: []'));
  });

  it('is a no-op (identical text) when the value is already set', () => {
    expect(run(TICKET, { op: 'set_fields', tags: ['one', 'two'] }).text).toBe(TICKET);
    expect(run(TICKET, { op: 'set_fields', tags: [] }).text).toBe(TICKET.replace('tags: [one, two]', 'tags: []'));
  });

  it('does not add an empty tags or blocked_by key', () => {
    const bare = TICKET.replace('tags: [one, two]\n', '');
    expect(run(bare, { op: 'set_fields', tags: [], blocked_by: [] }).text).toBe(bare);
  });

  it('normalises tags to lowercase [a-z0-9-] and dedupes', () => {
    expect(normalizeTag('Needs Triage!')).toBe('needs-triage');
    expect(run(TICKET, { op: 'set_fields', tags: ['Ready_For Agent', 'ready-for-agent', 'X1'] }).text).toContain('tags: [ready-for-agent, x1]\n');
    expect(() => run(TICKET, { op: 'set_fields', tags: ['!!!'] })).toThrow(/no usable characters/);
  });

  it('normalises blocked_by: strings of digits, same-effort IDs and padding', () => {
    expect(run(TICKET, { op: 'set_fields', blocked_by: ['2', 'demo/01', 'other/5', 2] }).text).toContain('blocked_by: [2, 1, other/05]\n');
    expect(() => run(TICKET, { op: 'set_fields', blocked_by: [3] })).toThrow(/itself/);
    expect(() => run(TICKET, { op: 'set_fields', blocked_by: ['nope'] })).toThrow(/effort\/NN/);
  });

  it('rejects an empty or multi-line title, an unknown type, and type on a map', () => {
    expect(() => run(TICKET, { op: 'set_fields', title: '  ' })).toThrow(/empty/);
    expect(() => run(TICKET, { op: 'set_fields', title: 'a\nb' })).toThrow(/single line/);
    expect(() => run(TICKET, { op: 'set_fields', type: 'bogus' })).toThrow(/type must be/);
    expect(() => run(TICKET.replace('kind: ticket', 'kind: map'), { op: 'set_fields', type: 'task' })).toThrow(/tickets/);
    expect(() => run(TICKET, { op: 'set_fields' })).toThrow(/at least one/);
  });

  it('reopen sets status open and clears claimed_by; only valid when not open', () => {
    const claimed = TICKET.replace('status: open', 'status: claimed\nclaimed_by: agent-1');
    expect(run(claimed, { op: 'set_fields', reopen: true }).text).toBe(TICKET);
    expect(() => run(TICKET, { op: 'set_fields', reopen: true })).toThrow(/already open/);
    expect(() => run(claimed, { op: 'set_fields', reopen: false as true })).toThrow(/reopen can only be true/);
  });
});

describe('sections', () => {
  it('replace_section changes only the body of that section', () => {
    const out = run(TICKET, { op: 'replace_section', heading: 'Question', content: 'Why?\n\nBecause.' }).text;
    expect(out).toBe(TICKET.replace('What now?', 'Why?\n\nBecause.'));
    const unknown = run(TICKET, { op: 'replace_section', heading: 'comments', content: '\nNew\n\n' }).text;
    expect(unknown).toBe(TICKET.replace('Unknown section.', 'New'));
  });

  it('replace_section fills an empty section and works on the last section without a trailing newline', () => {
    const empty = TICKET.replace('## Comments\n\nUnknown section.\n', '## Comments\n');
    expect(run(empty, { op: 'replace_section', heading: 'Comments', content: 'Hi' }).text).toBe(empty.replace('## Comments\n', '## Comments\n\nHi\n'));
    const noEol = TICKET.replace(/\n$/, '').replace(/\n$/, '');
    expect(noEol.endsWith('Unknown section.')).toBe(true);
    expect(run(noEol, { op: 'replace_section', heading: 'Comments', content: 'Short' }).text).toBe(noEol.replace('Unknown section.', 'Short'));
  });

  it('replace_section creates a missing section at the end, and the AC section before Answer', () => {
    const out = run(TICKET, { op: 'replace_section', heading: 'Answer', content: 'Done.' }).text;
    expect(out).toBe(TICKET + '\n## Answer\n\nDone.\n');
    const noAc = TICKET.replace(/## Acceptance criteria[\s\S]*?(?=## Comments)/, '').replace('## Comments', '## Answer\n\nA.\n\n## Comments');
    const added = run(noAc, { op: 'add_ac', text: 'Fresh' });
    expect(added.n).toBe(1);
    expect(added.text.indexOf('## Acceptance criteria')).toBeLessThan(added.text.indexOf('## Answer'));
    expect(added.text).toContain('## Acceptance criteria\n\n- [ ] #1 Fresh\n\n## Answer');
  });

  it('refuses content that would add a heading, but allows ## inside code fences and ### headings', () => {
    expect(() => run(TICKET, { op: 'replace_section', heading: 'Question', content: 'x\n## Sneaky\ny' })).toThrow(/heading/);
    expect(() => run(TICKET, { op: 'replace_section', heading: 'Question', content: '```\n## fenced\n```\n### sub' })).not.toThrow();
  });

  it('append_to_section adds lines after the last non-blank line and keeps the spacing', () => {
    const out = run(TICKET, { op: 'append_to_section', heading: 'Comments', content: '- more' }).text;
    expect(out).toBe(TICKET.replace('Unknown section.', 'Unknown section.\n- more'));
    const para = run(TICKET, { op: 'append_to_section', heading: 'Comments', content: '\nNew paragraph.' }).text;
    expect(para).toBe(TICKET.replace('Unknown section.', 'Unknown section.\n\nNew paragraph.'));
    expect(run(crlf(TICKET), { op: 'append_to_section', heading: 'Comments', content: 'a\nb' }).text).toBe(crlf(TICKET).replace('Unknown section.', 'Unknown section.\r\na\r\nb'));
  });

  it('append_to_section creates a missing section', () => {
    expect(run(TICKET, { op: 'append_to_section', heading: '## Notes', content: 'x' }).text).toBe(TICKET + '\n## Notes\n\nx\n');
  });
});

describe('acceptance criteria', () => {
  it('add_ac numbers max+1 and inserts after the last AC (one line)', () => {
    const r = run(TICKET, { op: 'add_ac', text: 'Third' });
    expect(r.n).toBe(3);
    expect(diff(TICKET, r.text)).toEqual({ removed: [], added: ['- [x] #2 Second', '- [ ] #3 Third'].slice(1) });
    expect(r.text).toBe(TICKET.replace('- [x] #2 Second', '- [x] #2 Second\n- [ ] #3 Third'));
  });

  it('add_ac works with CRLF and on a file whose AC section has no ACs yet', () => {
    expect(run(crlf(TICKET), { op: 'add_ac', text: 'Third', checked: true }).text).toBe(crlf(TICKET).replace('#2 Second', '#2 Second\r\n- [x] #3 Third'));
    const none = TICKET.replace('- [ ] #1 First\n- [x] #2 Second\n', '');
    expect(run(none, { op: 'add_ac', text: 'Only' }).text).toBe(none.replace('## Acceptance criteria\n\n', '## Acceptance criteria\n\n- [ ] #1 Only\n'));
  });

  it('edit_ac replaces just the text; toggle_ac flips just the box; remove_ac drops just the line', () => {
    expect(run(TICKET, { op: 'edit_ac', n: 2, text: 'Changed' }).text).toBe(TICKET.replace('#2 Second', '#2 Changed'));
    expect(run(TICKET, { op: 'toggle_ac', n: 1 }).text).toBe(TICKET.replace('- [ ] #1', '- [x] #1'));
    expect(run(TICKET, { op: 'toggle_ac', n: 2 }).text).toBe(TICKET.replace('- [x] #2', '- [ ] #2'));
    expect(run(TICKET, { op: 'toggle_ac', n: 2, checked: true }).text).toBe(TICKET);
    expect(run(TICKET, { op: 'remove_ac', n: 1 }).text).toBe(TICKET.replace('- [ ] #1 First\n', ''));
    expect(run(crlf(TICKET), { op: 'remove_ac', n: 2 }).text).toBe(crlf(TICKET).replace('- [x] #2 Second\r\n', ''));
  });

  it('remove_ac of a last line with no line ending leaves a clean file', () => {
    const src = '---\nkind: ticket\ntitle: T\nstatus: open\n---\n\n## Acceptance criteria\n\n- [ ] #1 A\n- [ ] #2 B';
    expect(run(src, { op: 'remove_ac', n: 2 }).text).toBe('---\nkind: ticket\ntitle: T\nstatus: open\n---\n\n## Acceptance criteria\n\n- [ ] #1 A');
  });

  it('a missing AC is not_found, duplicates are ambiguous, bad text is rejected', () => {
    expect(() => run(TICKET, { op: 'toggle_ac', n: 9 })).toThrow(/no acceptance criterion #9/);
    const dup = TICKET.replace('#2 Second', '#1 Second');
    expect(() => run(dup, { op: 'toggle_ac', n: 1 })).toThrow(/numbered #1/);
    expect(() => run(TICKET, { op: 'add_ac', text: '#4 sneaky' })).toThrow(/#N/);
    expect(() => run(TICKET, { op: 'add_ac', text: 'a\nb' })).toThrow(/single line/);
    expect(() => run(TICKET, { op: 'add_ac', text: ' ' })).toThrow(/empty/);
  });

  it('a hand-added AC without a number gets the next free number on any write', () => {
    const hand = TICKET.replace('- [x] #2 Second', '- [x] #2 Second\n- [ ] Hand added\n- [ ]Also bare');
    const out = run(hand, { op: 'set_fields', title: 'T' }).text;
    expect(out).toContain('- [ ] #3 Hand added\n- [ ] #4 Also bare\n');
    const added = run(hand, { op: 'add_ac', text: 'Next' });
    expect(added.n).toBe(5);
    expect((parseItem(added.text) as ValidParse).acs.map((a) => a.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it('numbers reuse the max+1 rule after removing the last AC', () => {
    const r = run(run(TICKET, { op: 'remove_ac', n: 2 }).text, { op: 'add_ac', text: 'Again' });
    expect(r.n).toBe(2);
  });
});

describe('structure is preserved', () => {
  it('keeps a BOM-less text identical outside the edit and never reorders sections', () => {
    const out = run(TICKET, { op: 'toggle_ac', n: 1 }).text;
    const headings = (t: string) => (parseItem(t) as ValidParse).sections.map((s) => s.heading);
    expect(headings(out)).toEqual(['Question', 'Acceptance criteria', 'Comments']);
    expect((parseItem(out) as ValidParse).extra).toEqual({ owner: 'jason', priority: 'high' });
  });
});
