import { describe, expect, it } from 'vitest';
import type { Element } from '../../src/architecture/types.ts';
import { filterFindings, filterWarnings, ownersOfPath } from '../../src/model/architecture.ts';
import { computeDrift } from '../../src/model/drift.ts';

const el = (slug: string, kind: 'container' | 'component', code: string[], parent?: string): Element => ({ slug, kind, title: slug, review: 'accepted', uses: [], code, ...(parent ? { parent } : {}) });

const ELEMENTS = [el('daemon', 'container', ['src/daemon', 'src/shared']), el('tools', 'component', ['src/daemon/tools'], 'daemon'), el('web', 'container', ['web']), el('rest', 'container', ['.'])];

describe('ownersOfPath', () => {
  const rows: Array<[string, string, string[]]> = [
    ['component beats container', 'src/daemon/tools/a.ts', ['tools']],
    ['container outside component', 'src/daemon/core.ts', ['daemon']],
    ['root . is the fallback', 'docs/a.md', ['rest']],
    ['equal to a root', 'web', ['web']],
    ['shared prefix sibling falls to .', 'src/daemon-x/a.ts', ['rest']],
    ['case differs', 'Web/a.ts', ['rest']],
  ];
  it.each(rows)('%s', (_n, path, expected) => {
    expect(ownersOfPath(ELEMENTS, path).map((e) => e.slug)).toEqual(expected);
  });
});

describe('filterFindings', () => {
  const f = (category: string, id?: string, path?: string) => ({ category, ...(id ? { id } : {}), ...(path ? { path } : {}), detail: '' });
  const rows: Array<[string, ReturnType<typeof f>, string[], boolean]> = [
    ['id inside the subtree', f('missing-path', 'tools', 'src/x'), ['tools'], true],
    ['id outside, path outside', f('missing-path', 'web', 'web/y'), ['tools'], false],
    ['no id, path owned by the subtree', f('possible-rename', undefined, 'src/daemon/tools/new.ts'), ['tools'], true],
    ['no id, path under the container but owned by a component', f('possible-rename', undefined, 'src/daemon/tools/new.ts'), ['daemon'], false],
    ['no id, path with backslashes and ./', f('possible-rename', undefined, '.\\src\\shared\\a.ts'), ['daemon'], true],
    ['unowned-code is always dropped', f('unowned-code', undefined, 'src/shared/a.ts'), ['daemon'], false],
    ['no id and no path', f('ambiguous-match'), ['daemon'], false],
  ];
  it.each(rows)('%s', (_n, finding, slugs, kept) => {
    expect(filterFindings([finding], ELEMENTS, new Set(slugs))).toEqual(kept ? [finding] : []);
  });
});

describe('filterWarnings', () => {
  const w = (id: string, field: 'components' | 'parent' | 'uses', slug: string) => ({ id, field, slug, detail: '' });
  it('keeps element warnings inside the subtree and ticket warnings naming a slug inside it', () => {
    const inside = w('architecture/daemon', 'uses', 'nowhere');
    const outside = w('architecture/web', 'uses', 'nowhere');
    const ticketMissing = w('work/01', 'components', 'nowhere');
    const ticketInside = w('work/02', 'components', 'daemon');
    expect(filterWarnings([inside, outside, ticketMissing, ticketInside], new Set(['daemon']))).toEqual([inside, ticketInside]);
  });
});

describe('computeDrift (stub)', () => {
  it('reports a missing root and groups unowned code by shallowest unowned directory', () => {
    const files = ['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts', 'src/stray/q.ts', 'top.ts', 'readme.md'];
    const elements = [el('a', 'container', ['src/a']), el('gone', 'container', ['src/gone'])];
    expect(computeDrift(elements, files)).toEqual([
      { category: 'missing-path', id: 'gone', path: 'src/gone', detail: 'gone owns src/gone, which does not exist' },
      { category: 'unowned-code', path: 'src/b', detail: '1 code file under src/b has no owner' },
      { category: 'unowned-code', path: 'src/stray', detail: '1 code file under src/stray has no owner' },
      { category: 'unowned-code', path: 'top.ts', detail: '1 code file has no owner' },
    ]);
  });

  it('a root of . is never missing and owns everything', () => {
    expect(computeDrift([el('all', 'container', ['.'])], ['a/b.ts'])).toEqual([]);
  });

  it('an empty architecture over an empty file list has no findings', () => {
    expect(computeDrift([], [])).toEqual([]);
  });
});
