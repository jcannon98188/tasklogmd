import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../../src/daemon/core.ts';
import type { EventSourceFactory, WatchHandlers, WatchTimers, WorkspaceWatcher } from '../../src/daemon/watcher.ts';
import type { Logger } from '../../src/log.ts';
import { WorkspaceIndex } from '../../src/model/index.ts';
import { ParsedItemStore } from '../../src/model/store.ts';
import { canonicalize } from '../../src/workspaces.ts';
import { copyFixture, makeEnv, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

// ---- harness ----------------------------------------------------------------------------------------------

interface Ev {
  level: string;
  event: string;
  [k: string]: unknown;
}

/** A logger that records every entry and lets a test wait for the daemon's own log events. */
function probe(base: Logger) {
  const events: Ev[] = [];
  const waiters: Array<{ pred: (e: Ev) => boolean; resolve: (e: Ev) => void }> = [];
  const push = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    const e = { level, event, ...fields };
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
    (base as any)[level](event, fields);
  };
  const log: Logger = { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug'), recentProblems: (w) => base.recentProblems(w) };
  return {
    log,
    events,
    named: (name: string) => events.filter((e) => e.event === name),
    /** Resolves with the next (or an already logged, when `fromStart`) event matching `pred`. */
    waitFor(pred: (e: Ev) => boolean, fromStart = false): Promise<Ev> {
      const past = fromStart ? events.find(pred) : undefined;
      if (past) return Promise.resolve(past);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for a log event')), 15000);
        waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
      });
    },
  };
}

class FakeTimers implements WatchTimers {
  private t = 0;
  private timers: Array<{ fn: () => void; at: number }> = [];
  setTimer(fn: () => void, ms: number) {
    const timer = { fn, at: this.t + ms };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

function synthetic() {
  let handlers!: WatchHandlers;
  const factory: EventSourceFactory = async (_dir, h) => {
    handlers = h;
    return { close: async () => undefined };
  };
  return {
    factory,
    emit: (type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir', p: string) => handlers.onEvent({ type, path: p }),
    error: (err: unknown) => handlers.onError(err),
  };
}

interface Sc {
  d: RunningDaemon;
  root: string;
  w: WorkspaceWatcher;
  timers: FakeTimers;
  src: ReturnType<typeof synthetic>;
  p: ReturnType<typeof probe>;
  abs: (rel: string) => string;
  /** Advances the fake clock past the debounce and waits for the resulting work to finish. */
  settle: () => Promise<void>;
  tool: (name: string, args?: object) => Promise<any>;
  idx: WorkspaceIndex;
}

async function scenario(fixture = 'normal'): Promise<Sc> {
  const root = canonicalize(copyFixture(fixture, env.root));
  const timers = new FakeTimers();
  const src = synthetic();
  const p = probe(env.log);
  const d = await env.start({ log: p.log, watcher: { source: src.factory, timers, debounceMs: 100 } });
  const tool = async (name: string, args: object = {}) => {
    const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${d.token}`,
        'x-tasklog-protocol': '1',
        'x-tasklog-workspace': root,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return ((await res.json()) as any).result.structuredContent;
  };
  await tool('workspace_status'); // registers the workspace
  const idx = await d.models.ready(root);
  const w = d.models.watcherOf(root)!;
  await p.waitFor((e) => e.event === 'watch.ready', true);
  const sc: Sc = {
    d,
    root,
    w,
    timers,
    src,
    p,
    idx,
    tool,
    abs: (rel) => path.join(root, ...rel.split('/')),
    settle: async () => {
      timers.advance(100);
      await w.idle();
    },
  };
  return sc;
}

/** Rescan as oracle: a fresh index scanned from disk equals the live incremental one. */
async function expectRescanEquals(sc: Sc): Promise<void> {
  const fresh = new WorkspaceIndex(sc.root, new ParsedItemStore(), { log: env.log });
  await fresh.scan('oracle');
  const view = (i: WorkspaceIndex) => i.entries().map((e) => `${e.path} ${e.hash} ${e.parse.ok ? 'ok' : 'invalid'}`);
  expect(view(sc.idx)).toEqual(view(fresh));
  fresh.dispose();
}

const A1 = '.tasklog/alpha/tickets/01-first-research.md';
const A3 = '.tasklog/alpha/tickets/03-blocked-prototype.md';

// ---- synthetic events, injected clock ------------------------------------------------------------------------

describe('debounce and coalescing', () => {
  it('coalesces a burst of events for one path into one read', async () => {
    const sc = await scenario();
    const before = sc.w.stats.reads;
    fs.appendFileSync(sc.abs(A1), '\nExtra line.\n');
    for (let i = 0; i < 6; i++) sc.src.emit(i % 2 ? 'change' : 'add', sc.abs(A1));
    sc.timers.advance(99);
    await sc.w.idle();
    expect(sc.w.stats.reads).toBe(before); // still inside the debounce window
    sc.timers.advance(1);
    await sc.w.idle();
    expect(sc.w.stats.reads).toBe(before + 1);
    expect(sc.p.named('item.changed')).toHaveLength(1);
    await expectRescanEquals(sc);
  });

  it('keeps separate paths separate', async () => {
    const sc = await scenario();
    fs.appendFileSync(sc.abs(A1), 'one\n');
    fs.appendFileSync(sc.abs(A3), 'two\n');
    sc.src.emit('change', sc.abs(A1));
    sc.src.emit('change', sc.abs(A3));
    await sc.settle();
    expect(sc.p.named('item.changed')).toHaveLength(2);
    await expectRescanEquals(sc);
  });
});

describe('external edits', () => {
  it('updates the model after the debounce, and the next write needs the new hash', async () => {
    const sc = await scenario();
    const oldHash = (await sc.tool('get_item', { id: 'alpha/01' })).hash as string;
    fs.writeFileSync(sc.abs(A1), fs.readFileSync(sc.abs(A1), 'utf8').replace('First research', 'Edited elsewhere'));
    sc.src.emit('change', sc.abs(A1));
    await sc.settle();
    const fresh = await sc.tool('get_item', { id: 'alpha/01' });
    expect(fresh.frontmatter.title).toBe('Edited elsewhere');
    expect(fresh.hash).not.toBe(oldHash);
    expect((await sc.tool('toggle_ac', { id: 'alpha/01', hash: oldHash, n: 1 })).error?.code).toBe('stale_hash');
    const ok = await sc.tool('set_fields', { id: 'alpha/01', hash: fresh.hash, tags: ['x'] });
    expect(ok.error).toBeUndefined();
    await expectRescanEquals(sc);
  });

  it('drops events whose bytes the model already holds, with no reparse (own write)', async () => {
    const sc = await scenario();
    const hash = (await sc.tool('get_item', { id: 'alpha/01' })).hash;
    const w = await sc.tool('set_fields', { id: 'alpha/01', hash, tags: ['fresh'] });
    expect(w.changed).toBe(true);
    const parses = sc.d.models.store.parseCount;
    sc.src.emit('change', sc.abs(A1));
    sc.src.emit('add', sc.abs(A1));
    await sc.settle();
    expect(sc.d.models.store.parseCount).toBe(parses);
    expect(sc.p.named('item.changed')).toHaveLength(0);
    expect(sc.p.named('watch.suppressed').map((e) => e.reason)).toEqual(['self_write']);
    expect(sc.w.stats.suppressed).toBe(1);
  });

  it('turns a valid item invalid and back when the file is fixed', async () => {
    const sc = await scenario();
    const good = fs.readFileSync(sc.abs(A1));
    fs.writeFileSync(sc.abs(A1), '---\nkind: ticket\ntitle: [unclosed\n---\n');
    sc.src.emit('change', sc.abs(A1));
    await sc.settle();
    expect((await sc.tool('get_item', { id: 'alpha/01' })).error?.code).toBe('invalid_item');
    const listed = (await sc.tool('list_items', { effort: 'alpha' })).items.find((i: any) => i.id === 'alpha/01');
    expect(listed.flags).toContain('invalid');
    fs.writeFileSync(sc.abs(A1), good);
    sc.src.emit('change', sc.abs(A1));
    await sc.settle();
    expect((await sc.tool('get_item', { id: 'alpha/01' })).error).toBeUndefined();
    expect(sc.p.named('item.valid')).toHaveLength(1);
    await expectRescanEquals(sc);
  });
});

describe('create, delete and rename', () => {
  it('treats a rename as removing the old item and adding the new one', async () => {
    const sc = await scenario();
    const to = '.tasklog/alpha/tickets/09-renamed-prototype.md';
    fs.renameSync(sc.abs(A3), sc.abs(to));
    sc.src.emit('unlink', sc.abs(A3));
    sc.src.emit('add', sc.abs(to));
    await sc.settle();
    expect((await sc.tool('get_item', { id: 'alpha/03' })).error?.code).toBe('not_found');
    expect((await sc.tool('get_item', { id: 'alpha/09' })).error).toBeUndefined();
    expect(sc.p.named('item.removed')).toHaveLength(1);
    expect(sc.p.named('item.added')).toHaveLength(1);
    await expectRescanEquals(sc);
  });

  it('removes a deleted item', async () => {
    const sc = await scenario();
    fs.rmSync(sc.abs(A3));
    sc.src.emit('unlink', sc.abs(A3));
    await sc.settle();
    expect((await sc.tool('get_item', { id: 'alpha/03' })).error?.code).toBe('not_found');
    await expectRescanEquals(sc);
  });

  it('survives an editor-style unlink followed by add of the same path', async () => {
    const sc = await scenario();
    const text = fs.readFileSync(sc.abs(A1), 'utf8').replace('First research', 'Saved atomically');
    fs.writeFileSync(sc.abs(A1), text);
    sc.src.emit('unlink', sc.abs(A1));
    sc.src.emit('add', sc.abs(A1));
    await sc.settle();
    expect((await sc.tool('get_item', { id: 'alpha/01' })).frontmatter.title).toBe('Saved atomically');
    await expectRescanEquals(sc);
  });

  it('picks up a new effort directory and file', async () => {
    const sc = await scenario();
    const f = '.tasklog/gamma/tickets/01-new-effort.md';
    fs.mkdirSync(sc.abs('.tasklog/gamma/tickets'), { recursive: true });
    fs.writeFileSync(sc.abs(f), '---\nkind: ticket\ntitle: Brand new\nstatus: open\n---\n\n## Question\n\nHi.\n');
    sc.src.emit('addDir', sc.abs('.tasklog/gamma'));
    sc.src.emit('add', sc.abs(f));
    await sc.settle();
    expect((await sc.tool('get_item', { id: 'gamma/01' })).frontmatter.title).toBe('Brand new');
    expect((await sc.tool('workspace_status')).counts.efforts).toBe(3);
    await expectRescanEquals(sc);
  });

  it('picks up a new effort directory even when the per-file events were missed', async () => {
    const sc = await scenario();
    const f = '.tasklog/gamma/tickets/01-new-effort.md';
    fs.mkdirSync(sc.abs('.tasklog/gamma/tickets'), { recursive: true });
    fs.writeFileSync(sc.abs(f), '---\nkind: ticket\ntitle: Brand new\nstatus: open\n---\n');
    sc.src.emit('addDir', sc.abs('.tasklog/gamma'));
    await sc.settle();
    expect((await sc.tool('get_item', { id: 'gamma/01' })).frontmatter.title).toBe('Brand new');
    expect(sc.p.named('watch.rescan').map((e) => e.reason)).toContain('directory_event');
  });
});

describe('ignored paths', () => {
  it('ignores files outside the layout, .git, node_modules, temp files and symlinks', async () => {
    const sc = await scenario();
    const before = sc.idx.modelVersion;
    const junk = [
      '.tasklog/alpha/notes.md',
      '.tasklog/README.md',
      '.tasklog/alpha/tickets/.01-x.md.ab12.tasklog-tmp',
      '.tasklog/.git/objects/01-x.md',
      '.tasklog/alpha/node_modules/pkg/map.md',
      '.tasklog/alpha/tickets/readme.txt',
    ];
    for (const j of junk) {
      fs.mkdirSync(path.dirname(sc.abs(j)), { recursive: true });
      fs.writeFileSync(sc.abs(j), '---\nkind: ticket\ntitle: nope\nstatus: open\n---\n');
      sc.src.emit('add', sc.abs(j));
      sc.src.emit('change', sc.abs(j));
    }
    sc.src.emit('add', path.join(sc.root, 'package.md')); // outside .tasklog entirely
    sc.src.emit('add', path.join(sc.root, 'node_modules', 'x', 'map.md'));
    await sc.settle();
    expect(sc.w.stats.events).toBe(0);
    expect(sc.idx.modelVersion).toBe(before);

    // A symlink where an item file would be: the event reaches the watcher but it is not read as an item.
    const link = '.tasklog/alpha/tickets/20-link.md';
    let linked = true;
    try {
      fs.symlinkSync(sc.abs(A1), sc.abs(link), 'file');
    } catch {
      linked = false; // symlinks need a privilege on some Windows setups
    }
    if (linked) {
      sc.src.emit('add', sc.abs(link));
      await sc.settle();
      expect(sc.idx.entryByPath(link)).toBeUndefined();
      expect(sc.idx.modelVersion).toBe(before);
    }
    await expectRescanEquals(sc);
  });
});

describe('rescan on error', () => {
  it('runs a hash-diffed workspace rescan on a watcher error, logs its reason, and reports suppressed events', async () => {
    const sc = await scenario();
    // One suppressed event first, so the summary count is non-zero.
    const hash = (await sc.tool('get_item', { id: 'alpha/01' })).hash;
    await sc.tool('toggle_ac', { id: 'alpha/01', hash, n: 1 }).catch(() => undefined);
    sc.src.emit('change', sc.abs(A1));
    await sc.settle();
    const suppressed = sc.w.stats.suppressed;
    expect(suppressed).toBeGreaterThanOrEqual(1);

    // A missed edit: no event ever arrives for it.
    fs.writeFileSync(sc.abs(A3), fs.readFileSync(sc.abs(A3), 'utf8').replace('Blocked prototype', 'Missed edit'));
    const scansBefore = sc.p.named('scan.finished').length;
    sc.src.error(new Error('EMFILE: too many open files'));
    await sc.p.waitFor((e) => e.event === 'scan.finished' && sc.p.named('scan.finished').length > scansBefore);
    expect(sc.p.named('watch.error')).toHaveLength(1);
    const rescan = sc.p.named('watch.rescan').find((e) => e.reason === 'watcher_error')!;
    expect(rescan.suppressed_events).toBe(suppressed);
    const done = sc.p.named('scan.finished').at(-1)!;
    expect(done).toMatchObject({ reason: 'watcher_error', changed: 1 });
    expect((await sc.tool('get_item', { id: 'alpha/03' })).frontmatter.title).toBe('Missed edit');
    await expectRescanEquals(sc);
  });
});

describe('rescan oracle across a mixed scenario', () => {
  it('matches a fresh scan after edits, deletes, renames, invalid files and daemon writes interleave', async () => {
    const sc = await scenario();
    const h1 = (await sc.tool('get_item', { id: 'alpha/01' })).hash;
    await sc.tool('set_fields', { id: 'alpha/01', hash: h1, tags: ['a', 'b'] });
    fs.rmSync(sc.abs('.tasklog/alpha/tickets/10-late-ticket.md'));
    sc.src.emit('unlink', sc.abs('.tasklog/alpha/tickets/10-late-ticket.md'));
    fs.writeFileSync(sc.abs('.tasklog/alpha/tickets/04-grill-the-plan.md'), 'not frontmatter at all');
    sc.src.emit('change', sc.abs('.tasklog/alpha/tickets/04-grill-the-plan.md'));
    fs.renameSync(sc.abs(A3), sc.abs('.tasklog/alpha/tickets/33-moved.md'));
    sc.src.emit('unlink', sc.abs(A3));
    sc.src.emit('add', sc.abs('.tasklog/alpha/tickets/33-moved.md'));
    sc.src.emit('change', sc.abs(A1));
    await sc.settle();
    await expectRescanEquals(sc);
  });
});

// ---- real chokidar -------------------------------------------------------------------------------------------

describe('real chokidar (waits on the daemon\'s own log events)', () => {
  async function real() {
    const root = canonicalize(copyFixture('normal', env.root));
    const p = probe(env.log);
    const d = await env.start({ log: p.log });
    const call = async (name: string, args: object = {}) => {
      const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${d.token}`,
          'x-tasklog-protocol': '1',
          'x-tasklog-workspace': root,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return ((await res.json()) as any).result.structuredContent;
    };
    await call('workspace_status');
    await d.models.ready(root);
    await p.waitFor((e) => e.event === 'watch.ready', true);
    return { d, root, p, call };
  }

  it('does not reparse after a daemon write', async () => {
    const { d, root, p, call } = await real();
    const { hash } = await call('get_item', { id: 'alpha/01' });
    const suppressed = p.waitFor((e) => e.event === 'watch.suppressed' && String(e.path).endsWith('01-first-research.md'));
    const res = await call('set_fields', { id: 'alpha/01', hash, tags: ['fresh'] });
    expect(res.changed).toBe(true);
    const parses = d.models.store.parseCount; // the write itself parsed its result
    await suppressed;
    await d.writes.idle();
    expect(d.models.store.parseCount).toBe(parses);
    expect(p.named('item.changed')).toHaveLength(0);
    expect(d.writes.isSelfWrite(root, '.tasklog/alpha/tickets/01-first-research.md', res.hash)).toBe(true);
  });

  it('picks up an external edit, a new file and a delete', async () => {
    const { root, p, call } = await real();
    const f = path.join(root, '.tasklog', 'alpha', 'tickets', '01-first-research.md');
    const changed = p.waitFor((e) => e.event === 'item.changed' && String(e.path).endsWith('01-first-research.md'));
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('First research', 'Real edit'));
    await changed;
    expect((await call('get_item', { id: 'alpha/01' })).frontmatter.title).toBe('Real edit');

    const added = p.waitFor((e) => e.event === 'item.added' && String(e.path).endsWith('50-added.md'));
    fs.writeFileSync(path.join(root, '.tasklog', 'alpha', 'tickets', '50-added.md'), '---\nkind: ticket\ntitle: Added live\nstatus: open\n---\n');
    await added;
    expect((await call('get_item', { id: 'alpha/50' })).frontmatter.title).toBe('Added live');

    const removed = p.waitFor((e) => e.event === 'item.removed' && String(e.path).endsWith('50-added.md'));
    fs.rmSync(path.join(root, '.tasklog', 'alpha', 'tickets', '50-added.md'));
    await removed;
    expect((await call('get_item', { id: 'alpha/50' })).error.code).toBe('not_found');
  });

  it('picks up a new effort directory', async () => {
    const { root, p, call } = await real();
    const added = p.waitFor((e) => e.event === 'item.added' && String(e.path).includes('gamma'));
    fs.mkdirSync(path.join(root, '.tasklog', 'gamma', 'tickets'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tasklog', 'gamma', 'tickets', '01-live.md'), '---\nkind: ticket\ntitle: Live effort\nstatus: open\n---\n');
    await added;
    expect((await call('get_item', { id: 'gamma/01' })).frontmatter.title).toBe('Live effort');
  });
});
