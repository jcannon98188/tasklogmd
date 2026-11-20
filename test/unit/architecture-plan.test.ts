import { describe, expect, it } from 'vitest';
import { plan, type PlanInput } from '../../src/architecture/plan.js';
import type { Candidate, Element, ElementKind } from '../../src/architecture/types.js';

// Table-driven tests of the pure planner. Expected plans are written out by hand from the spec's
// "Match and merge" section (and tasklog-architecture/02), not recomputed.

function el(slug: string, kind: ElementKind, code: string[], extra: Partial<Element> = {}): Element {
  return { slug, kind, title: slug, review: 'proposed', uses: [], code, ...extra };
}

function cand(slug: string, kind: ElementKind, code: string[], files: string[], extra: Partial<Candidate> = {}): Candidate {
  return { slug, kind, title: slug, code, files, uses: [], ...extra };
}

/** `n` code files named `<dir>/f1.ts` .. `<dir>/fn.ts`. */
function nfiles(dir: string, n: number, from = 1): string[] {
  return Array.from({ length: n }, (_, i) => `${dir}/f${from + i}.ts`);
}

function run(input: Partial<PlanInput> & Pick<PlanInput, 'existing' | 'candidates'>) {
  const files =
    input.files ??
    [...new Set([...input.candidates.flatMap((c) => c.files), ...input.existing.flatMap((e) => e.code.map((r) => `${r}/f1.ts`))])].sort();
  return plan({ files, ...input });
}

const EMPTY = { created: [], updated: [], unchanged: [], skipped: [], findings: [], ignored: [] };

describe('plan: matching', () => {
  it('proposes every candidate when nothing exists', () => {
    const c = cand('web', 'container', ['web'], ['web/a.ts']);
    const out = run({ existing: [], candidates: [c] });
    expect(out).toEqual({ ...EMPTY, created: [c] });
  });

  it('an unchanged repo gives no created, no updated, and lists the element as unchanged', () => {
    const e = el('web', 'container', ['web']);
    const c = cand('web', 'container', ['web'], ['web/a.ts', 'web/b.ts']);
    const out = run({ existing: [e], candidates: [c], files: ['web/a.ts', 'web/b.ts'] });
    expect(out).toEqual({ ...EMPTY, unchanged: ['web'] });
  });

  it('matches by owned files, never by name', () => {
    const e = el('old-name', 'component', ['src/a'], { parent: 'app' });
    const c = cand('totally-different', 'component', ['src/a', 'src/a2'], ['src/a/1.ts', 'src/a/2.ts', 'src/a2/3.ts'], { parent: 'app' });
    const out = run({ existing: [e, el('app', 'container', ['.'])], candidates: [c], files: c.files });
    expect(out.created).toEqual([]);
    expect(out.updated).toEqual([{ slug: 'old-name', code: ['src/a', 'src/a2'] }]);
  });

  it('never matches across kinds, even with identical files', () => {
    const e = el('x', 'container', ['x']);
    const c = cand('x', 'component', ['x'], ['x/a.ts'], { parent: 'p' });
    const out = run({ existing: [e], candidates: [c], files: ['x/a.ts'] });
    expect(out.created).toEqual([c]);
    expect(out.unchanged).toEqual(['x']);
  });

  it.each([
    // [label, element files, candidate files, shared, matches]
    ['exactly 50% on both sides matches', 4, 4, 2, true],
    ['under 50% of the element does not match', 5, 4, 2, false],
    ['under 50% of the candidate does not match', 4, 5, 2, false],
  ])('50%% rule: %s', (_label, eFiles, cFiles, shared, matches) => {
    // The shared files live under the element's root; the candidate's other files are elsewhere.
    const efs = nfiles('src/e', eFiles);
    const cfs = [...efs.slice(0, shared), ...nfiles('src/c', cFiles - shared)];
    const e = el('e', 'component', ['src/e']);
    const c = cand('c', 'component', ['src/e', 'src/c'], cfs);
    const out = run({ existing: [e], candidates: [c], files: [...efs, ...cfs.slice(shared)] });
    if (matches) {
      expect(out.created).toEqual([]);
      expect(out.updated).toEqual([{ slug: 'e', code: ['src/e', 'src/c'] }]);
      expect(out.unchanged).toEqual([]);
    } else {
      expect(out.created).toEqual([c]);
      expect(out.unchanged).toEqual(['e']);
    }
  });

  it('rename: zero shared files proposes the new directory and reports the old as missing', () => {
    const e = el('old', 'component', ['src/old']);
    const c = cand('new', 'component', ['src/new'], ['src/new/a.ts']);
    const out = run({ existing: [e], candidates: [c], files: ['src/new/a.ts'] });
    expect(out.created).toEqual([c]);
    expect(out.updated).toEqual([]);
    expect(out.unchanged).toEqual(['old']);
    expect(out.findings).toEqual([
      { category: 'missing-path', element: 'old', path: 'src/old', message: expect.any(String) },
    ]);
  });

  it('rename hint: same basename, same kind adds possible-rename and changes nothing else', () => {
    const e = el('foo', 'component', ['packages/foo']);
    const c = cand('foo-2', 'component', ['apps/foo'], ['apps/foo/a.ts']);
    const out = run({ existing: [e], candidates: [c], files: ['apps/foo/a.ts'] });
    expect(out.created).toEqual([c]);
    expect(out.findings.map((f) => [f.category, f.element, f.path])).toEqual([
      ['missing-path', 'foo', 'packages/foo'],
      ['possible-rename', 'foo', 'apps/foo'],
    ]);
  });

  it('no rename hint across kinds', () => {
    const e = el('foo', 'container', ['packages/foo']);
    const c = cand('foo-c', 'component', ['apps/foo'], ['apps/foo/a.ts'], { parent: 'p' });
    const out = run({ existing: [e], candidates: [c], files: ['apps/foo/a.ts'] });
    expect(out.findings.map((f) => f.category)).toEqual(['missing-path']);
  });

  it('split: the larger half keeps the element, the other half is proposed', () => {
    const e = el('a', 'component', ['src/a']);
    const big = cand('a-x', 'component', ['src/a/x'], nfiles('src/a/x', 6));
    const small = cand('a-y', 'component', ['src/a/y'], nfiles('src/a/y', 4));
    const out = run({ existing: [e], candidates: [big, small], files: [...big.files, ...small.files] });
    expect(out.updated).toEqual([{ slug: 'a', code: ['src/a/x'] }]);
    expect(out.created).toEqual([small]);
    expect(out.unchanged).toEqual([]);
  });

  it('merge: the candidate matches the element it overlaps more; the other element is left alone', () => {
    const e1 = el('a', 'component', ['src/a']);
    const e2 = el('b', 'component', ['src/b']);
    const files = [...nfiles('src/a', 6), ...nfiles('src/b', 4)];
    const c = cand('ab', 'component', ['src/a', 'src/b'], files);
    const out = run({ existing: [e1, e2], candidates: [c], files });
    expect(out.created).toEqual([]);
    expect(out.updated).toEqual([{ slug: 'a', code: ['src/a', 'src/b'] }]);
    expect(out.unchanged).toEqual(['b']);
  });

  it('a tie matches neither and is reported as ambiguous', () => {
    const e = el('e', 'component', ['src/e']);
    const efs = nfiles('src/e', 4);
    const c1 = cand('c1', 'component', ['src/c1'], [...efs.slice(0, 2), ...nfiles('src/c1', 0)]);
    const c2 = cand('c2', 'component', ['src/c2'], efs.slice(2));
    const out = run({ existing: [e], candidates: [c1, c2], files: efs });
    expect(out.created).toEqual([c1, c2]);
    expect(out.updated).toEqual([]);
    expect(out.findings.filter((f) => f.category === 'ambiguous-match').map((f) => [f.element, f.path])).toEqual([
      ['e', 'src/c1'],
      ['e', 'src/c2'],
    ]);
  });

  it('one-to-one: pairs are taken from the largest shared count down', () => {
    const e = el('e', 'component', ['src/e']);
    const efs = nfiles('src/e', 8);
    const big = cand('big', 'component', ['src/e'], efs.slice(0, 5));
    const mid = cand('mid', 'component', ['src/m'], efs.slice(5));
    const out = run({ existing: [e], candidates: [mid, big], files: efs });
    expect(out.created).toEqual([mid]); // 3/8 of e fails 50% anyway, and e is taken by big
    expect(out.unchanged.concat(out.updated.map((u) => u.slug))).toEqual(['e']);
  });
});

describe('plan: container matching ignores components', () => {
  // The candidate container lists only its own files (components' files excluded); the existing container must be
  // compared the same way, so hand-deleted or newly appeared components do not push it under the 50% rule.
  const rootFiles = ['root.ts'];
  const dirs = (names: string[]) => names.map((n) => ({ n, fs: nfiles(`src/${n}`, 3) }));
  const compCands = (names: string[]) =>
    dirs(names).map(({ n, fs }) => cand(n, 'component', [`src/${n}`], fs, { parent: 'app' }));

  it('two or more components hand-deleted from a container do not re-propose the container', () => {
    const all = [...rootFiles, ...dirs(['a', 'b', 'c']).flatMap((d) => d.fs)];
    const container = cand('app', 'container', ['.'], rootFiles);
    const existing = [el('app', 'container', ['.']), el('a', 'component', ['src/a'], { parent: 'app' })];
    const out = run({ existing, candidates: [container, ...compCands(['a', 'b', 'c'])], files: all });
    expect(out.created.map((c) => c.slug)).toEqual(['b', 'c']);
    expect(out.updated).toEqual([]);
    expect(out.unchanged).toEqual(['a', 'app']);
  });

  it('many new component directories at once do not re-propose the container', () => {
    const all = [...rootFiles, ...dirs(['a', 'b', 'c', 'd']).flatMap((d) => d.fs)];
    const container = cand('app', 'container', ['.'], rootFiles);
    const out = run({ existing: [el('app', 'container', ['.'])], candidates: [container, ...compCands(['a', 'b', 'c', 'd'])], files: all });
    expect(out.created.map((c) => c.slug)).toEqual(['a', 'b', 'c', 'd']);
    expect(out.unchanged).toEqual(['app']);
  });

  it('an old container owning `.` stays matched across repeated scans', () => {
    const all = [...rootFiles, ...dirs(['a', 'b', 'c']).flatMap((d) => d.fs)];
    const container = cand('app', 'container', ['.'], rootFiles);
    const cands = [container, ...compCands(['a', 'b', 'c'])];
    let existing = [el('old-app', 'container', ['.']), el('a', 'component', ['src/a'], { parent: 'old-app' })];
    for (let scan = 0; scan < 3; scan++) {
      const out = run({ existing, candidates: cands, files: all });
      expect(out.created.filter((c) => c.kind === 'container')).toEqual([]);
      existing = [...existing, ...out.created.map((c) => el(c.slug, c.kind, c.code, { parent: 'old-app' }))];
    }
  });

  it('a nested container still takes its own files out of the outer container', () => {
    const inner = nfiles('packages/lib', 3);
    const all = [...rootFiles, ...inner];
    const outer = cand('app', 'container', ['.'], rootFiles);
    const lib = cand('lib', 'container', ['packages/lib'], inner);
    const out = run({ existing: [el('app', 'container', ['.']), el('lib', 'container', ['packages/lib'])], candidates: [outer, lib], files: all });
    expect(out).toEqual({ ...EMPTY, unchanged: ['app', 'lib'] });
  });
});

describe('plan: merge of roots', () => {
  it('replaces only overlapping roots; hand-added roots stay', () => {
    const e = el('a', 'component', ['src/a', 'notes']);
    const c = cand('a', 'component', ['src/a', 'src/b'], ['src/a/1.ts', 'src/a/2.ts', 'src/b/3.ts']);
    const out = run({ existing: [e], candidates: [c], files: [...c.files, 'notes/n.md'] });
    expect(out.updated).toEqual([{ slug: 'a', code: ['src/a', 'src/b', 'notes'] }]);
  });

  it('touches only `code`: curated fields never appear in an update', () => {
    const e = el('a', 'component', ['src/a'], {
      review: 'accepted',
      parent: 'app',
      uses: [{ to: 'lib', label: 'calls' }],
      title: 'Hand title',
    });
    const c = cand('a', 'component', ['src/a', 'src/b'], ['src/a/1.ts', 'src/b/2.ts'], { parent: 'app' });
    const out = run({ existing: [e, el('app', 'container', ['.'])], candidates: [c], files: c.files });
    expect(out.updated).toEqual([{ slug: 'a', code: ['src/a', 'src/b'] }]);
    expect(Object.keys(out.updated[0]!)).toEqual(['slug', 'code']);
  });

  it('the same roots in another order is not a change', () => {
    const e = el('a', 'component', ['src/b', 'src/a']);
    const c = cand('a', 'component', ['src/a', 'src/b'], ['src/a/1.ts', 'src/b/2.ts']);
    const out = run({ existing: [e], candidates: [c], files: c.files });
    expect(out).toEqual({ ...EMPTY, unchanged: ['a'] });
  });
});

describe('plan: findings', () => {
  it('reports a missing owned root and a root that owns no code', () => {
    const e = el('docs', 'component', ['docs', 'gone']);
    const out = run({ existing: [e], candidates: [], files: ['docs/readme.md'] });
    expect(out.findings.map((f) => [f.category, f.element, f.path])).toEqual([
      ['missing-path', 'docs', 'gone'],
      ['owns-no-code', 'docs', 'docs'],
    ]);
    expect(out.unchanged).toEqual(['docs']);
  });

  it('reports a matched component under a different container as parent-mismatch, without rewriting', () => {
    const app = el('app', 'container', ['app']);
    const other = el('other', 'container', ['other']);
    const e = el('feat', 'component', ['other/src/feat'], { parent: 'other' });
    const c = cand('feat', 'component', ['other/src/feat'], ['other/src/feat/a.ts'], { parent: 'app-c' });
    const appC = cand('app-c', 'container', ['app'], ['app/x.ts']);
    const out = run({ existing: [app, other, e], candidates: [appC, c], files: ['app/x.ts', 'other/src/feat/a.ts', 'other/y.ts'] });
    expect(out.updated).toEqual([]);
    expect(out.findings.filter((f) => f.category === 'parent-mismatch')).toEqual([
      { category: 'parent-mismatch', element: 'feat', path: 'other/src/feat', message: expect.any(String) },
    ]);
  });

  it('resolves a candidate parent through the container it matched, so renamed slugs are no mismatch', () => {
    const app = el('real-app', 'container', ['app']);
    const e = el('feat', 'component', ['app/src/feat'], { parent: 'real-app' });
    const appC = cand('app-guess', 'container', ['app'], ['app/x.ts']);
    const c = cand('feat', 'component', ['app/src/feat'], ['app/src/feat/a.ts'], { parent: 'app-guess' });
    const out = run({ existing: [app, e], candidates: [appC, c], files: ['app/x.ts', 'app/src/feat/a.ts'] });
    expect(out.findings).toEqual([]);
  });

  it('passes unowned code from detection through, except what an existing element owns', () => {
    const out = run({
      existing: [el('scripts', 'component', ['scripts'])],
      candidates: [],
      files: ['scripts/a.ts', 'tools/b.ts', 'loose/c.ts'],
      unowned: ['scripts', 'tools'],
    });
    expect(out.findings).toEqual([{ category: 'unowned-code', path: 'tools', message: expect.any(String) }]);
  });

  it('reports a top-level directory only when some of its code is covered by no element root', () => {
    const owned = run({
      existing: [el('build', 'component', ['scripts/build'])],
      candidates: [],
      files: ['scripts/build/a.ts', 'scripts/build/b.ts'],
      unowned: ['scripts'],
    });
    expect(owned.findings).toEqual([]);
    const partial = run({
      existing: [el('build', 'component', ['scripts/build'])],
      candidates: [],
      files: ['scripts/build/a.ts', 'scripts/other/b.ts'],
      unowned: ['scripts'],
    });
    expect(partial.findings).toEqual([{ category: 'unowned-code', path: 'scripts', message: expect.any(String) }]);
  });

  it('keeps detection-ignored entries', () => {
    const out = run({
      existing: [],
      candidates: [],
      files: [],
      ignored: [{ path: 'e2e', reason: 'tooling' }],
    });
    expect(out.ignored).toEqual([{ path: 'e2e', reason: 'tooling' }]);
  });
});

describe('plan: ignore file', () => {
  const stub = cand('stub', 'container', ['spikes/02/stub'], ['spikes/02/stub/index.ts']);

  it('a hand-deleted element is re-proposed when there is no ignore entry', () => {
    const out = run({ existing: [], candidates: [stub], files: stub.files, userIgnore: [] });
    expect(out.created).toEqual([stub]);
    expect(out.ignored).toEqual([]);
  });

  it.each([['spikes/02/stub'], ['spikes/**'], ['spikes/*/stub'], ['spikes/02']])('ignore entry %s stops re-proposal and is reported as user', (rule) => {
    const out = run({ existing: [], candidates: [stub], files: stub.files, userIgnore: [rule] });
    expect(out.created).toEqual([]);
    expect(out.ignored).toEqual([{ path: 'spikes/02/stub', reason: 'user' }]);
  });

  it('an ignore entry that does not match leaves the proposal', () => {
    const out = run({ existing: [], candidates: [stub], files: stub.files, userIgnore: ['spikes/03/**', 'spikes/02/stubby'] });
    expect(out.created).toEqual([stub]);
  });

  it('ignore rules never touch an existing element that owns the ignored path', () => {
    const e = el('stub', 'container', ['spikes/02/stub']);
    const c = cand('stub', 'container', ['spikes/02/stub', 'spikes/02/more'], [...stub.files, 'spikes/02/more/x.ts']);
    const out = run({ existing: [e], candidates: [c], files: c.files, userIgnore: ['spikes/**'] });
    expect(out.updated).toEqual([{ slug: 'stub', code: ['spikes/02/stub', 'spikes/02/more'] }]);
    expect(out.ignored).toEqual([]);
  });

  it('also drops ignored unowned directories from the findings', () => {
    const out = run({ existing: [], candidates: [], files: ['tools/a.ts'], unowned: ['tools'], userIgnore: ['tools'] });
    expect(out.findings).toEqual([]);
    expect(out.ignored).toEqual([{ path: 'tools', reason: 'user' }]);
  });
});

describe('plan: idempotence', () => {
  it('applying a plan and planning again changes nothing', () => {
    const existing = [el('app', 'container', ['app']), el('feat', 'component', ['app/src/feat'], { parent: 'app', review: 'accepted' })];
    const candidates = [
      cand('app', 'container', ['app'], ['app/main.ts', 'app/m2.ts', 'app/m3.ts', 'app/m4.ts']),
      cand('feat', 'component', ['app/src/feat', 'app/src/feat2'], ['app/src/feat/a.ts', 'app/src/feat2/b.ts'], { parent: 'app' }),
      cand('new', 'component', ['app/src/new'], ['app/src/new/c.ts'], { parent: 'app' }),
    ];
    const files = ['app/main.ts', 'app/m2.ts', 'app/m3.ts', 'app/m4.ts', 'app/src/feat/a.ts', 'app/src/feat2/b.ts', 'app/src/new/c.ts'];
    const first = plan({ existing, candidates, files });
    expect(first.created.map((c) => c.slug)).toEqual(['new']);
    expect(first.updated).toEqual([{ slug: 'feat', code: ['app/src/feat', 'app/src/feat2'] }]);

    const applied: Element[] = existing.map((e) => {
      const u = first.updated.find((x) => x.slug === e.slug);
      return u ? { ...e, code: u.code } : e;
    });
    for (const c of first.created) {
      applied.push({ slug: c.slug, kind: c.kind, title: c.title, review: 'proposed', parent: c.parent, uses: c.uses, code: c.code });
    }
    const second = plan({ existing: applied, candidates, files });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual(['app', 'feat', 'new']);
  });
});
