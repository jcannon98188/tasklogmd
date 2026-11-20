import { describe, expect, it } from 'vitest';
import { parseItem } from '../../src/model/parse.ts';

const el = (extra: string, kind = 'component') => `---\nkind: ${kind}\ntitle: T\n${extra}---\n\n## Description\n`;

describe('parseItem: element fields', () => {
  it('reads review, parent, code and an empty uses', () => {
    const p = parseItem(el('review: accepted\nparent: daemon\ncode: [src/a, "src/b c"]\n'));
    expect(p.ok && p.fields).toEqual({
      kind: 'component',
      title: 'T',
      blockedBy: [],
      tags: [],
      review: 'accepted',
      parent: 'daemon',
      code: ['src/a', 'src/b c'],
      uses: [],
    });
  });

  it('defaults review to proposed and has no status', () => {
    const p = parseItem(el(''));
    expect(p.ok && p.fields.review).toBe('proposed');
    expect(p.ok && p.fields.status).toBeUndefined();
  });

  const uses: Array<[string, string, Array<{ to: string; label?: string }>]> = [
    ['block form with labels', 'uses:\n  - to: a\n    label: reads items\n  - to: b\n', [{ to: 'a', label: 'reads items' }, { to: 'b' }]],
    ['block form at column 0', 'uses:\n- to: a\n', [{ to: 'a' }]],
    ['inline flow maps', 'uses: [{to: a, label: "x, y"}, {to: b}]\n', [{ to: 'a', label: 'x, y' }, { to: 'b' }]],
    ['block of flow maps', 'uses:\n  - {to: a}\n', [{ to: 'a' }]],
    ['bare slugs', 'uses:\n  - a\n  - b\n', [{ to: 'a' }, { to: 'b' }]],
    ['empty inline list', 'uses: []\n', []],
    ['CRLF', 'uses:\r\n  - to: a\r\n    label: x\r\n', [{ to: 'a', label: 'x' }]],
  ];
  it.each(uses)('uses, %s', (_n, fm, expected) => {
    const p = parseItem(el(fm));
    expect(p.ok && p.fields.uses).toEqual(expected);
  });

  it.each([
    ['an unknown uses key', 'uses:\n  - to: a\n    why: b\n'],
    ['a uses entry without a target', 'uses:\n  - label: x\n'],
    ['a scalar uses value', 'uses: nope\n'],
    ['a bad review value', 'review: maybe\n'],
    ['a non-text code entry', 'code: [1]\n'],
  ])('%s makes the element invalid', (_n, fm) => {
    expect(parseItem(el(fm)).ok).toBe(false);
  });

  it('reads components on tickets only', () => {
    const t = `---\nkind: ticket\ntitle: T\nstatus: open\ncomponents: [a, b]\n---\n`;
    const p = parseItem(t);
    expect(p.ok && p.fields.components).toEqual(['a', 'b']);
    const m = parseItem(`---\nkind: map\ntitle: T\nstatus: open\ncomponents: [a]\n---\n`);
    expect(m.ok && m.fields.components).toBeUndefined();
  });
});
