import { describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../../src/model/index.ts';
import { parseQuery, tokenize } from '../../src/model/search.ts';
import { ParsedItemStore } from '../../src/model/store.ts';
import { createLogger } from '../../src/log.ts';

const log = createLogger({ level: 'error' });

interface Spec {
  title: string;
  tags?: string[];
  body?: string;
  fm?: string;
  status?: string;
}

function file(s: Spec): Buffer {
  const tags = s.tags ? `tags: [${s.tags.join(', ')}]\n` : '';
  return Buffer.from(`---\nkind: ticket\ntitle: ${s.title}\nstatus: ${s.status ?? 'open'}\n${tags}${s.fm ?? ''}---\n\n${s.body ?? '## Question\n\nnothing\n'}`);
}

function build(files: Record<string, Spec>) {
  const store = new ParsedItemStore();
  const idx = new WorkspaceIndex('/ws', store, { log });
  for (const [p, s] of Object.entries(files)) idx.upsertFile(`.tasklog/${p}`, file(s));
  const ids = (q: Parameters<WorkspaceIndex['list']>[0]) => idx.list(q).items.map((i) => i.id);
  return { store, idx, ids };
}

describe('tokenize / parseQuery', () => {
  it('folds case and diacritics and keeps identifiers whole as well as in parts', () => {
    expect(tokenize('Café MENÜ').parts).toEqual(['cafe', 'menu']);
    const t = tokenize('see `list_items` and 07-daemon.');
    expect(t.wholes).toEqual(['list_items', '07-daemon']);
    expect(t.parts).toEqual(['see', 'list', 'items', 'and', '07', 'daemon']);
  });

  it('parses phrases, exclusions and implicit AND', () => {
    const q = parseQuery('foo "exact phrase" -bar -"no way"');
    expect(q.terms.map((t) => [t.kind, t.neg])).toEqual([['word', false], ['phrase', false], ['word', true], ['phrase', true]]);
    expect(parseQuery('  - "" ').empty).toBe(true);
  });
});

describe('list_items text search', () => {
  it('matches diacritic titles without diacritics, case-insensitively', () => {
    const { ids } = build({ 'e/tickets/01-a.md': { title: 'Café menü überarbeiten' }, 'e/tickets/02-b.md': { title: 'Other' } });
    expect(ids({ text: 'cafe MENU uber' })).toEqual(['e/01']);
  });

  it('honours phrases and exclusions against the token sequence; multiple words AND, prefix allowed', () => {
    const { ids } = build({
      'e/tickets/01-a.md': { title: 'Quick brown fox', body: '## Notes\n\nthe lazy dog sleeps\n' },
      'e/tickets/02-b.md': { title: 'Brown quick fox' },
      'e/tickets/03-c.md': { title: 'Quick brown cat', body: '## Notes\n\nlazy\n' },
    });
    expect(ids({ text: '"quick brown"' })).toEqual(['e/01', 'e/03']);
    expect(ids({ text: '"brown fox"' })).toEqual(['e/01']);
    expect(ids({ text: 'quick fo' })).toEqual(['e/01', 'e/02']);
    expect(ids({ text: 'quick -fox' })).toEqual(['e/03']);
    expect(ids({ text: 'quick -"brown cat"' })).toEqual(['e/01', 'e/02']);
    expect(ids({ text: 'uick' })).toEqual([]); // prefix, not substring
  });

  it('matches identifiers by part or whole', () => {
    const { ids } = build({
      'e/tickets/01-a.md': { title: 'Add list_items tool', body: '## Notes\n\nafter 07-daemon lands\n' },
      'e/tickets/02-b.md': { title: 'Unrelated' },
    });
    for (const q of ['list_items', 'list', 'items', 'list_it', '07-daemon', 'daemon', '07', '"list items"']) {
      expect(ids({ text: q }), q).toEqual(['e/01']);
    }
    expect(ids({ text: 'e/01' })).toEqual(['e/01']); // Item ID
    expect(ids({ text: '01' })).toEqual(['e/01']);
  });

  it('ranks title hits above body hits, ties by effort then number, and reports matched_in', () => {
    const { idx } = build({
      'a/tickets/01-x.md': { title: 'Nothing', body: '## Notes\n\nneedle here\n' },
      'a/tickets/02-y.md': { title: 'Needle in title' },
      'b/tickets/01-z.md': { title: 'Needle again' },
      'a/tickets/03-w.md': { title: 'Other', tags: ['needle'] },
      'a/tickets/04-v.md': { title: 'Q', body: '## Question\n\nneedle\n' },
    });
    const r = idx.list({ text: 'needle' });
    expect(r.items.map((i) => i.id)).toEqual(['a/02', 'b/01', 'a/03', 'a/04', 'a/01']);
    expect(r.items.map((i) => i.matched_in)).toEqual([['title'], ['title'], ['tags'], ['question'], ['body']]);
    expect(r.total).toBe(5);
    expect(idx.list({}).items[0]!.matched_in).toEqual([]);
  });

  it('ANDs tags_all, tags_any, tags_none with structured filters and text', () => {
    const { ids } = build({
      'e/tickets/01-a.md': { title: 'Alpha job', tags: ['Backend', 'urgent'] },
      'e/tickets/02-b.md': { title: 'Alpha job', tags: ['backend'] },
      'e/tickets/03-c.md': { title: 'Alpha job', tags: ['frontend'], status: 'resolved' },
      'e/tickets/04-d.md': { title: 'Alpha job' },
    });
    expect(ids({ tags_none: ['URGENT'] })).toEqual(['e/02', 'e/03', 'e/04']);
    expect(ids({ text: 'alpha', tags_all: ['backend'], tags_none: ['urgent'] })).toEqual(['e/02']);
    expect(ids({ text: 'alpha', tags_any: ['frontend', 'urgent'] })).toEqual(['e/01', 'e/03']);
    expect(ids({ text: 'alpha', tags_any: ['frontend', 'urgent'], status: 'open' })).toEqual(['e/01']);
    expect(ids({ text: 'alpha', tags_all: ['back'] })).toEqual([]); // exact tags only
  });

  it('covers title, ID, tags and every body section (including unknown ones) but not other frontmatter', () => {
    const { ids } = build({
      'e/tickets/01-a.md': {
        title: 'T',
        tags: ['zebra'],
        fm: 'claimed_by: wombat\nsecretkey: aardvark\n',
        body: '## Question\n\nqword\n\n## Acceptance criteria\n\n- [ ] #1 acword\n\n## Comments\n\ncomword\n\n## Mystery\n\nmystword\n',
      },
    });
    for (const w of ['zebra', 'qword', 'acword', 'comword', 'mystword']) expect(ids({ text: w }), w).toEqual(['e/01']);
    for (const w of ['wombat', 'aardvark', 'secretkey', 'claimed_by']) expect(ids({ text: w }), w).toEqual([]);
  });

  it('adds ~160-character snippets only when asked', () => {
    const long = `${'filler words '.repeat(40)}findme ${'more filler '.repeat(40)}`;
    const { idx } = build({ 'e/tickets/01-a.md': { title: 'T', body: `## Notes\n\n${long}\n` } });
    expect(idx.list({ text: 'findme' }).items[0]!.snippet).toBeUndefined();
    const s = idx.list({ text: 'findme', snippet: true }).items[0]!.snippet!;
    expect(s).toContain('findme');
    expect(s.length).toBeGreaterThan(100);
    expect(s.length).toBeLessThanOrEqual(165);
    expect(idx.list({ snippet: true }).items[0]!.snippet).toBeUndefined(); // needs text
  });

  it('computes tokens once per distinct content and keeps them with the store entry', () => {
    const { store, idx } = build({ 'a/tickets/01-a.md': { title: 'Same' } });
    const other = new WorkspaceIndex('/ws2', store, { log });
    other.upsertFile('.tasklog/z/tickets/09-q.md', file({ title: 'Same' }));
    expect(store.parseCount).toBe(1);
    const hash = idx.entries()[0]!.hash;
    expect(store.search(hash)).toBe(store.search(hash));
    expect(store.search(hash)!.title!.parts).toEqual(['same']);
    other.dispose();
    idx.dispose();
    expect(store.search(hash)).toBeNull();
  });

  it('scopes cursors to the text query and pages ranked results', () => {
    const files: Record<string, Spec> = {};
    for (let i = 1; i <= 5; i++) files[`e/tickets/0${i}-a.md`] = { title: `Needle ${i}` };
    const { idx } = build(files);
    const p1 = idx.list({ text: 'needle', limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(idx.list({ text: 'needle', limit: 2, cursor: p1.cursor }).items.map((i) => i.id)).toEqual(['e/03', 'e/04']);
    expect(() => idx.list({ text: 'other', limit: 2, cursor: p1.cursor })).toThrow();
  });
});
