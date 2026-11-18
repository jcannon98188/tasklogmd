import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../../src/model/index.ts';
import { ParsedItemStore } from '../../src/model/store.ts';
import { copyFixture, makeEnv, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

interface ToolResult {
  isError?: boolean;
  structuredContent: any;
}

/** One MCP tool call over the daemon's streamable HTTP endpoint, scoped to a workspace root. */
async function tool(d: { port: number; token: string }, root: string, name: string, args: object = {}): Promise<ToolResult> {
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
  const body = (await res.json()) as { result: ToolResult };
  return body.result;
}

const ids = (r: ToolResult) => r.structuredContent.items.map((i: { id: string }) => i.id);

describe('scan of the native fixture workspace', () => {
  it('indexes every item with the right id, kind, status, type, tags, blocked_by and ACs', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const list = await tool(d, root, 'list_items', { limit: 200 });
    expect(list.isError).toBeUndefined();
    expect(ids(list)).toEqual([
      'alpha/map', 'alpha/spec', 'alpha/01', 'alpha/02', 'alpha/03', 'alpha/04', 'alpha/05', 'alpha/10',
      'beta/map', 'beta/spec', 'beta/01', 'beta/02',
    ]);
    expect(list.structuredContent.total).toBe(12);

    const row = (id: string) => list.structuredContent.items.find((i: { id: string }) => i.id === id);
    expect(row('alpha/map')).toMatchObject({ kind: 'map', status: 'open', title: 'Alpha' });
    expect(row('alpha/01')).toMatchObject({ kind: 'ticket', status: 'resolved', type: 'research', tags: ['research', 'ready-for-human'], blocked_by: [] });
    expect(row('alpha/02')).toMatchObject({ status: 'claimed', claimed_by: 'agent-1', blocked_by: ['alpha/01'], type: null });
    expect(row('alpha/03')).toMatchObject({ type: 'prototype', tags: ['frontend', 'needs-triage'], blocked_by: ['alpha/01', 'alpha/02', 'beta/01'] });
    expect(row('alpha/05')).toMatchObject({ status: 'closed', tags: ['wontfix'] });
    expect(row('beta/01').title).toBe('Café menü überarbeiten');
    for (const i of list.structuredContent.items) {
      expect(i.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(i.flags).toEqual([]);
    }

    const got = await tool(d, root, 'get_item', { id: 'alpha/03' });
    expect(got.structuredContent).toMatchObject({
      id: 'alpha/03',
      path: '.tasklog/alpha/tickets/03-blocked-prototype.md',
      hash: row('alpha/03').hash,
      frontmatter: { kind: 'ticket', title: 'Blocked prototype', status: 'open', type: 'prototype', blocked_by: [1, 2, 'beta/01'], tags: ['frontend', 'needs-triage'] },
      acs: [
        { n: 1, text: 'First', checked: false },
        { n: 2, text: 'Second', checked: false },
        { n: 3, text: 'Third', checked: false },
      ],
    });
    expect(got.structuredContent.body).toContain('## Question');
    expect(new Date(got.structuredContent.mtime).getTime()).toBeGreaterThan(0);
    expect((await tool(d, root, 'get_item', { id: 'alpha/3' })).structuredContent.id).toBe('alpha/03');
    expect((await tool(d, root, 'get_item', { id: 'alpha/02' })).structuredContent.acs).toEqual([
      { n: 1, text: 'Done thing', checked: true },
      { n: 2, text: 'Pending thing', checked: false },
    ]);

    const missing = await tool(d, root, 'get_item', { id: 'alpha/99' });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe('not_found');
  });

  it('reports state and counts through workspace_status', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    await tool(d, root, 'list_items'); // waits for the scan
    const st = (await tool(d, root, 'workspace_status')).structuredContent;
    expect(st.state).toBe('ready');
    expect(st.counts).toMatchObject({ items: 12, invalid: 0, conflicted: 0, efforts: 2 });
    expect(st.problems).toEqual([]);
  });
});

describe('list_items filters and paging', () => {
  it('filters by effort, kind, status, type and tags', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const q = async (args: object) => ids(await tool(d, root, 'list_items', args));
    expect(await q({ effort: 'beta' })).toEqual(['beta/map', 'beta/spec', 'beta/01', 'beta/02']);
    expect(await q({ effort: 'alpha', kind: 'ticket', status: 'open' })).toEqual(['alpha/03', 'alpha/04', 'alpha/10']);
    expect(await q({ type: 'grilling' })).toEqual(['alpha/04']);
    expect(await q({ tags_all: ['backend', 'ready-for-agent'] })).toEqual(['alpha/10']);
    expect(await q({ tags_any: ['wontfix', 'i18n'] })).toEqual(['alpha/05', 'beta/01']);
    expect(await q({ kind: 'ticket', tags_none: ['backend', 'ready-for-agent', 'wontfix'] })).toEqual([
      'alpha/01', 'alpha/03', 'beta/01', 'beta/02',
    ]);
  });

  it('caps limit at 200, reports the pre-paging total, and pages with a cursor', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const capped = await tool(d, root, 'list_items', { limit: 9999 });
    expect(capped.structuredContent.items).toHaveLength(12);
    expect(capped.structuredContent.cursor).toBeUndefined();

    const p1 = await tool(d, root, 'list_items', { limit: 5 });
    expect(ids(p1)).toHaveLength(5);
    expect(p1.structuredContent.total).toBe(12);
    const p2 = await tool(d, root, 'list_items', { limit: 5, cursor: p1.structuredContent.cursor });
    expect(ids(p2)).toEqual(['alpha/04', 'alpha/05', 'alpha/10', 'beta/map', 'beta/spec']);
    expect(p2.structuredContent.total).toBe(12);
    const p3 = await tool(d, root, 'list_items', { limit: 5, cursor: p2.structuredContent.cursor });
    expect(ids(p3)).toEqual(['beta/01', 'beta/02']);
    expect(p3.structuredContent.cursor).toBeUndefined();
  });

  it('caps a request above 200 at 200 with total over all matches', async () => {
    const root = copyFixture('normal', env.root);
    for (let n = 11; n <= 260; n++) {
      fs.writeFileSync(
        path.join(root, '.tasklog', 'alpha', 'tickets', `${n}-bulk.md`),
        `---\nkind: ticket\ntitle: Bulk ${n}\nstatus: open\n---\n\n## Question\n\nq\n`,
      );
    }
    const d = await env.start();
    const r = await tool(d, root, 'list_items', { limit: 1000 });
    expect(r.structuredContent.items).toHaveLength(200);
    expect(r.structuredContent.total).toBe(262);
  });

  it('fails the next page with stale_cursor when the model version changed', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const p1 = await tool(d, root, 'list_items', { limit: 3 });
    const idx = d.models.peek((await tool(d, root, 'workspace_status')).structuredContent.root);
    idx.upsertFile('.tasklog/alpha/tickets/11-new.md', Buffer.from('---\nkind: ticket\ntitle: New\nstatus: open\n---\n\n## Question\n\nq\n'));
    const p2 = await tool(d, root, 'list_items', { limit: 3, cursor: p1.structuredContent.cursor });
    expect(p2.isError).toBe(true);
    expect(p2.structuredContent.error).toMatchObject({ code: 'stale_cursor', retryable: true });
    // Restarting the listing works.
    expect((await tool(d, root, 'list_items', { limit: 3 })).structuredContent.total).toBe(13);
  });
});

describe('invalid and conflicted items', () => {
  it('flags an invalid file in listings and fails get_item with invalid_item', async () => {
    const root = copyFixture('invalid', env.root);
    const d = await env.start();
    const list = await tool(d, root, 'list_items');
    const byId = (id: string) => list.structuredContent.items.find((i: { id: string }) => i.id === id);
    expect(ids(list)).toEqual(['gamma/map', 'gamma/01', 'gamma/02', 'gamma/03', 'gamma/04']);
    expect(byId('gamma/01').flags).toEqual([]);
    for (const id of ['gamma/02', 'gamma/03', 'gamma/04']) {
      expect(byId(id).flags).toEqual(['invalid']);
      expect(byId(id).error).toBeTruthy();
      const got = await tool(d, root, 'get_item', { id });
      expect(got.isError).toBe(true);
      expect(got.structuredContent.error.code).toBe('invalid_item');
      expect(got.structuredContent.error.details.path).toContain('.tasklog/gamma/tickets/');
    }
    const st = (await tool(d, root, 'workspace_status')).structuredContent;
    expect(st.counts.invalid).toBe(3);
    expect(st.problems.map((p: { id: string }) => p.id)).toEqual(['gamma/02', 'gamma/03', 'gamma/04']);
  });

  it('keeps both files of a duplicate ID, fails conflicted with both paths, and counts it', async () => {
    const root = copyFixture('duplicate-ids', env.root);
    const d = await env.start();
    const list = await tool(d, root, 'list_items');
    expect(ids(list)).toEqual(['dup/map', 'dup/03', 'dup/03', 'dup/04']);
    const dups = list.structuredContent.items.filter((i: { id: string }) => i.id === 'dup/03');
    expect(dups.map((i: { path: string }) => i.path).sort()).toEqual([
      '.tasklog/dup/tickets/03-first-copy.md',
      '.tasklog/dup/tickets/03-second-copy.md',
    ]);
    expect(dups.every((i: { flags: string[] }) => i.flags.includes('conflicted'))).toBe(true);

    const got = await tool(d, root, 'get_item', { id: 'dup/03' });
    expect(got.isError).toBe(true);
    expect(got.structuredContent.error.code).toBe('conflicted');
    expect(got.structuredContent.error.details.paths).toEqual([
      '.tasklog/dup/tickets/03-first-copy.md',
      '.tasklog/dup/tickets/03-second-copy.md',
    ]);
    expect((await tool(d, root, 'get_item', { id: 'dup/04' })).isError).toBeUndefined();

    const st = (await tool(d, root, 'workspace_status')).structuredContent;
    expect(st.counts.conflicted).toBe(1);
    expect(st.problems).toMatchObject([{ type: 'conflicted', id: 'dup/03' }]);
  });
});

describe('preservation through the model', () => {
  it('preserves an unknown key, unknown sections and unnumbered ACs', async () => {
    const root = copyFixture('unknown-key', env.root);
    const d = await env.start();
    const got = (await tool(d, root, 'get_item', { id: 'delta/01' })).structuredContent;
    expect(got.frontmatter).toMatchObject({ title: 'Quoted: title', owner: 'jason', priority: 'high', imported_from: '.scratch/delta/issues/01-x.md' });
    expect(got.body).toContain('## Implementation plan');
    expect(got.body).toContain('## Comments');
    expect(got.acs).toEqual([
      { n: 1, text: 'Numbered', checked: false },
      { n: null, text: 'Hand-added without number', checked: false },
    ]);
  });

  it('reads CRLF, LF and BOM files, each with the right hash of its exact bytes', async () => {
    const root = copyFixture('eol-bom', env.root);
    const d = await env.start();
    const { createHash } = await import('node:crypto');
    for (const [id, file] of [['eol/01', '01-crlf.md'], ['eol/02', '02-lf.md'], ['eol/03', '03-bom.md'], ['eol/04', '04-bom-crlf.md']] as const) {
      const got = (await tool(d, root, 'get_item', { id })).structuredContent;
      const bytes = fs.readFileSync(path.join(root, '.tasklog', 'eol', 'tickets', file));
      expect(got.hash, id).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(got.frontmatter.status).toBe('open');
      expect(got.acs.length).toBe(id === 'eol/04' ? 0 : 1);
    }
    expect((await tool(d, root, 'get_item', { id: 'eol/01' })).structuredContent.body).toContain('\r\n');
    expect((await tool(d, root, 'get_item', { id: 'eol/02' })).structuredContent.body).not.toContain('\r');
  });
});

describe('shared parsed-item store', () => {
  it('shares one parse result between two workspaces with identical bytes and evicts it when unreferenced', async () => {
    const a = copyFixture('normal', env.root, 'ws-a');
    const b = copyFixture('normal', env.root, 'ws-b');
    const store = new ParsedItemStore();
    const log = env.log;
    const ia = new WorkspaceIndex(a, store, { log });
    const ib = new WorkspaceIndex(b, store, { log });
    await ia.scan();
    await ib.scan();
    expect(ia.size).toBe(12);
    expect(store.size).toBe(12); // 12 distinct contents shared by 24 index entries
    expect(store.parseCount).toBe(12);
    const hash = ia.entriesForId('alpha/01')[0]!.hash;
    expect(store.refs(hash)).toBe(2);
    expect(ia.entriesForId('alpha/01')[0]!.parse).toBe(ib.entriesForId('alpha/01')[0]!.parse);

    ia.dispose();
    expect(store.size).toBe(12);
    expect(store.refs(hash)).toBe(1);
    ib.dispose();
    expect(store.size).toBe(0);
  });

  it('evicts through the daemon when a workspace is unregistered', async () => {
    const a = copyFixture('normal', env.root, 'ws-a');
    const b = copyFixture('normal', env.root, 'ws-b');
    const d = await env.start();
    await tool(d, a, 'list_items');
    await tool(d, b, 'list_items');
    expect(d.models.store.size).toBe(12);
    const { callDaemon } = await import('../helpers.ts');
    await callDaemon(env.state(d), 'DELETE', '/workspaces', { body: { root: a } });
    expect(d.models.store.size).toBe(12);
    await callDaemon(env.state(d), 'DELETE', '/workspaces', { body: { root: b } });
    expect(d.models.store.size).toBe(0);
  });
});

describe('initial scan gating', () => {
  it('fails with the retryable indexing error when the scan outlasts the wait, then succeeds once ready', async () => {
    const root = copyFixture('normal', env.root);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = await env.start({ indexWaitMs: 150, beforeScan: () => gate });

    const status = (await tool(d, root, 'workspace_status')).structuredContent;
    expect(status.state).toBe('indexing'); // status waits, then reports instead of failing
    const health = await fetch(`http://127.0.0.1:${d.port}/health`, {
      headers: { authorization: `Bearer ${d.token}`, 'x-tasklog-protocol': '1' },
    }).then((r) => r.json() as Promise<{ workspaces: Array<{ root: string; state: string }> }>);
    expect(health.workspaces.find((w) => w.root === status.root)?.state).toBe('indexing');

    const t0 = Date.now();
    const blocked = await tool(d, root, 'list_items');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent.error).toMatchObject({ code: 'indexing', retryable: true });
    expect((await tool(d, root, 'get_item', { id: 'alpha/01' })).structuredContent.error.code).toBe('indexing');

    release();
    const ok = await tool(d, root, 'list_items');
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent.total).toBe(12);
  });

  it('waits for a scan that finishes inside the wait window', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start({ indexWaitMs: 5000, beforeScan: () => new Promise((r) => setTimeout(r, 200)) });
    const r = await tool(d, root, 'list_items');
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.total).toBe(12);
  });
});
