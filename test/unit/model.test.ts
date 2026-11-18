import { describe, expect, it } from 'vitest';
import { TaskLogError } from '../../src/errors.ts';
import { identify, normalizeId, WorkspaceIndex } from '../../src/model/index.ts';
import { ParsedItemStore } from '../../src/model/store.ts';
import { createLogger } from '../../src/log.ts';

const log = createLogger({ level: 'error' });

function item(title: string, fm = '', status = 'open', kind = 'ticket'): Buffer {
  return Buffer.from(`---\nkind: ${kind}\ntitle: ${title}\nstatus: ${status}\n${fm}---\n\n## Question\n\nq\n`);
}

function mkIndex(store = new ParsedItemStore(), root = '/ws') {
  return { store, idx: new WorkspaceIndex(root, store, { log }) };
}

describe('identify', () => {
  it('derives IDs from layout paths and ignores everything else', () => {
    expect(identify('e/map.md')).toMatchObject({ id: 'e/map', layoutKind: 'map' });
    expect(identify('e/spec.md')).toMatchObject({ id: 'e/spec', layoutKind: 'spec' });
    expect(identify('e/tickets/7-x.md')).toMatchObject({ id: 'e/07', layoutKind: 'ticket', number: 7 });
    expect(identify('e/tickets/743-x.md')).toMatchObject({ id: 'e/743' });
    expect(identify('e/tickets/12.md')).toMatchObject({ id: 'e/12' });
    for (const p of ['README.md', 'e/notes.md', 'e/tickets/x.md', 'e/tickets/01-a.txt', '.hidden/map.md', 'e/tickets/sub/01-a.md']) {
      expect(identify(p), p).toBeNull();
    }
  });

  it('normalizes IDs', () => {
    expect(normalizeId('e/5')).toBe('e/05');
    expect(normalizeId(' e/05 ')).toBe('e/05');
    expect(normalizeId('e/MAP')).toBe('e/map');
    expect(normalizeId('e/743')).toBe('e/743');
  });
});

describe('ParsedItemStore', () => {
  it('shares one parse result per content hash and evicts at zero references', () => {
    const store = new ParsedItemStore();
    const a = new WorkspaceIndex('/a', store, { log });
    const b = new WorkspaceIndex('/b', store, { log });
    const bytes = item('Same');
    a.upsertFile('.tasklog/x/tickets/01-s.md', bytes);
    b.upsertFile('.tasklog/y/tickets/05-t.md', Buffer.from(bytes));
    expect(store.size).toBe(1);
    expect(store.parseCount).toBe(1);
    const hash = a.entries()[0]!.hash;
    expect(a.entries()[0]!.parse).toBe(b.entries()[0]!.parse);
    expect(store.refs(hash)).toBe(2);
    a.dispose();
    expect(store.has(hash)).toBe(true);
    b.dispose();
    expect(store.has(hash)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('releases the old result when a file changes and when it is removed', () => {
    const { store, idx } = mkIndex();
    idx.upsertFile('.tasklog/e/tickets/01-a.md', item('One'));
    const h1 = idx.entries()[0]!.hash;
    expect(idx.upsertFile('.tasklog/e/tickets/01-a.md', item('One'))).toBe(false);
    expect(store.refs(h1)).toBe(1);
    expect(idx.upsertFile('.tasklog/e/tickets/01-a.md', item('Two'))).toBe(true);
    expect(store.has(h1)).toBe(false);
    idx.removeFile('.tasklog/e/tickets/01-a.md');
    expect(store.size).toBe(0);
  });
});

describe('WorkspaceIndex.list', () => {
  function seeded() {
    const { idx } = mkIndex();
    idx.upsertFile('.tasklog/b/tickets/01-x.md', item('B1', 'tags: [t1]\n'));
    idx.upsertFile('.tasklog/a/tickets/10-ten.md', item('A10', 'tags: [t1, t2]\ntype: task\n'));
    idx.upsertFile('.tasklog/a/tickets/02-two.md', item('A2', 'blocked_by: [1, "b/01"]\n', 'claimed'));
    idx.upsertFile('.tasklog/a/tickets/01-one.md', item('A1', 'tags: [t2]\ntype: research\n', 'resolved'));
    idx.upsertFile('.tasklog/a/map.md', item('Amap', '', 'open', 'map'));
    idx.upsertFile('.tasklog/a/spec.md', item('Aspec', '', 'open', 'spec'));
    return idx;
  }

  it('orders by effort, then map, spec, tickets by number (10 after 2)', () => {
    expect(seeded().list().items.map((i) => i.id)).toEqual(['a/map', 'a/spec', 'a/01', 'a/02', 'a/10', 'b/01']);
  });

  it('filters by effort, kind, status, type and tags, ANDed', () => {
    const idx = seeded();
    const ids = (q: object) => idx.list(q).items.map((i) => i.id);
    expect(ids({ effort: 'b' })).toEqual(['b/01']);
    expect(ids({ kind: 'map' })).toEqual(['a/map']);
    expect(ids({ status: 'claimed' })).toEqual(['a/02']);
    expect(ids({ type: 'research' })).toEqual(['a/01']);
    expect(ids({ tags_all: ['t1', 't2'] })).toEqual(['a/10']);
    expect(ids({ tags_any: ['t2', 'nope'] })).toEqual(['a/01', 'a/10']);
    expect(ids({ tags_none: ['t1'], kind: 'ticket' })).toEqual(['a/01', 'a/02']);
    expect(ids({ tags_any: ['T2'], effort: 'a', status: 'resolved' })).toEqual(['a/01']);
  });

  it('returns hash, flags and resolved blocked_by on each row', () => {
    const row = seeded().list({ status: 'claimed' }).items[0]!;
    expect(row).toMatchObject({ id: 'a/02', title: 'A2', kind: 'ticket', status: 'claimed', type: null, claimed_by: null, flags: [], blocked_by: ['a/01', 'b/01'] });
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caps limit at 200 and reports the pre-paging total', () => {
    const { idx } = mkIndex();
    for (let n = 1; n <= 250; n++) idx.upsertFile(`.tasklog/e/tickets/${n}-t.md`, item(`T${n}`));
    const r = idx.list({ limit: 1000 });
    expect(r.items).toHaveLength(200);
    expect(r.total).toBe(250);
    expect(r.cursor).toBeDefined();
    expect(idx.list({}).items).toHaveLength(50);
    const rest = idx.list({ limit: 1000, cursor: r.cursor });
    expect(rest.items).toHaveLength(50);
    expect(rest.total).toBe(250);
    expect(rest.cursor).toBeUndefined();
    expect(rest.items[0]!.id).toBe('e/201');
  });

  it('fails stale_cursor when the model version changed since the cursor was issued', () => {
    const { idx } = mkIndex();
    for (let n = 1; n <= 5; n++) idx.upsertFile(`.tasklog/e/tickets/${n}-t.md`, item(`T${n}`));
    const first = idx.list({ limit: 2 });
    idx.upsertFile('.tasklog/e/tickets/09-new.md', item('New'));
    let err: unknown;
    try {
      idx.list({ limit: 2, cursor: first.cursor });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskLogError);
    expect((err as TaskLogError).code).toBe('stale_cursor');
    expect((err as TaskLogError).retryable).toBe(true);
  });

  it('rejects malformed cursors and cursors from other filters as bad_request', () => {
    const idx = seeded();
    const cur = idx.list({ limit: 1 }).cursor!;
    expect(() => idx.list({ cursor: 'garbage' })).toThrowError(/cursor/);
    expect(() => idx.list({ limit: 1, effort: 'a', cursor: cur })).toThrowError(/different filters/);
  });

  it('keeps invalid items in listings, flagged, and excludes them from status/tag filters', () => {
    const idx = seeded();
    idx.upsertFile('.tasklog/a/tickets/03-bad.md', Buffer.from('# nothing\n'));
    const all = idx.list({ effort: 'a' }).items;
    const bad = all.find((i) => i.id === 'a/03')!;
    expect(bad).toMatchObject({ flags: ['invalid'], status: null, kind: 'ticket' });
    expect(bad.error).toMatch(/frontmatter/);
    expect(idx.list({ status: 'open' }).items.map((i) => i.id)).not.toContain('a/03');
  });
});

describe('WorkspaceIndex.get and conflicts', () => {
  it('fails invalid_item for an invalid file and keeps its last good hash', () => {
    const { idx } = mkIndex();
    idx.upsertFile('.tasklog/e/tickets/01-a.md', item('Fine'));
    const good = idx.entries()[0]!.hash;
    idx.upsertFile('.tasklog/e/tickets/01-a.md', Buffer.from('broken'));
    expect(() => idx.get('e/01')).toThrowError(TaskLogError);
    try {
      idx.get('e/1');
    } catch (e) {
      expect((e as TaskLogError).code).toBe('invalid_item');
      expect((e as TaskLogError).details).toMatchObject({ path: '.tasklog/e/tickets/01-a.md' });
    }
    expect(idx.entries()[0]!.lastGoodHash).toBe(good);
  });

  it('keeps both files of a duplicate ID, fails conflicted listing both paths, and counts them', () => {
    const { idx } = mkIndex();
    idx.upsertFile('.tasklog/e/tickets/03-a.md', item('A'));
    idx.upsertFile('.tasklog/e/tickets/3-b.md', item('B'));
    idx.upsertFile('.tasklog/e/tickets/04-c.md', item('C'));
    try {
      idx.get('e/03');
      expect.unreachable();
    } catch (e) {
      expect((e as TaskLogError).code).toBe('conflicted');
      expect((e as TaskLogError).details.paths).toEqual(['.tasklog/e/tickets/03-a.md', '.tasklog/e/tickets/3-b.md']);
    }
    expect(idx.counts()).toMatchObject({ items: 3, conflicted: 1, invalid: 0 });
    const rows = idx.list().items.filter((i) => i.id === 'e/03');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.flags.includes('conflicted'))).toBe(true);
    expect(idx.problems().filter((p) => p.type === 'conflicted')).toHaveLength(1);
    // clearing the duplicate clears the flag
    idx.removeFile('.tasklog/e/tickets/3-b.md');
    expect(idx.get('e/03').id).toBe('e/03');
    expect(idx.counts().conflicted).toBe(0);
  });

  it('fails not_found for an unknown ID', () => {
    const { idx } = mkIndex();
    expect(() => idx.get('e/99')).toThrowError(/No item/);
  });
});
