// Slice 1 of the architecture build: the Element model, seen through the daemon tool API.
// Elements are written by hand here; create_element and the scan arrive in later slices.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, mkWorkspace, type TestEnv } from '../helpers.ts';

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
  return ((await res.json()) as { result: ToolResult }).result;
}

const errCode = (r: ToolResult): string | undefined => r.structuredContent?.error?.code;
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

function put(root: string, rel: string, text: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const element = (slug: string, front: string, body = '## Description\n\n## Responsibilities\n'): void => {
  put(workspace, `.tasklog/architecture/${slug}.md`, `---\n${front}\n---\n\n${body}`);
};

const ticket = (n: number, extra = ''): void => {
  put(workspace, `.tasklog/work/tickets/0${n}-t${n}.md`, `---\nkind: ticket\ntitle: Ticket ${n}\nstatus: open\n${extra}created: 2026-01-01\nupdated: 2026-01-01\n---\n\n## Question\n\nQ\n`);
};

let workspace: string;
const setup = (): string => {
  workspace = mkWorkspace(env.root);
  put(workspace, '.tasklog/work/map.md', '---\nkind: map\ntitle: Work\nstatus: open\n---\n\n## Destination\n');
  element('daemon', 'kind: container\ntitle: Daemon\nreview: accepted\ncode: [src/daemon]\ncreated: 2026-01-01\nupdated: 2026-01-01');
  element('writes', 'kind: component\ntitle: Writes\nreview: proposed\nparent: daemon\ncode:\n  - src/daemon/writes.ts\nuses:\n  - to: model\n    label: reads items\ncreated: 2026-01-01\nupdated: 2026-01-01');
  return workspace;
};

describe('elements in the model', () => {
  it('get_item returns an element by architecture/<slug> with its frontmatter', async () => {
    const root = setup();
    const d = await env.start();
    const r = await tool(d, root, 'get_item', { id: 'architecture/writes' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.path).toBe('.tasklog/architecture/writes.md');
    expect(r.structuredContent.frontmatter).toMatchObject({ kind: 'component', title: 'Writes', review: 'proposed', parent: 'daemon', code: ['src/daemon/writes.ts'] });
    expect(r.structuredContent.flags).toEqual([]);
  });

  it('list_items hides elements unless kind is passed', async () => {
    const root = setup();
    const d = await env.start();
    const all = await tool(d, root, 'list_items');
    expect(all.structuredContent.items.map((i: any) => i.id)).toEqual(['work/map']);
    const containers = await tool(d, root, 'list_items', { kind: 'container' });
    expect(containers.structuredContent.items.map((i: any) => [i.id, i.kind, i.title])).toEqual([['architecture/daemon', 'container', 'Daemon']]);
    const comps = await tool(d, root, 'list_items', { kind: 'component' });
    expect(comps.structuredContent.items.map((i: any) => [i.id, i.status])).toEqual([['architecture/writes', null]]);
  });

  it('an element file with a bad review value is invalid and flagged', async () => {
    const root = setup();
    element('broken', 'kind: component\ntitle: Broken\nreview: maybe');
    const d = await env.start();
    const r = await tool(d, root, 'get_item', { id: 'architecture/broken' });
    expect(errCode(r)).toBe('invalid_item');
    const status = await tool(d, root, 'workspace_status');
    expect(status.structuredContent.problems.map((p: any) => p.id)).toEqual(['architecture/broken']);
  });

  it('workspace_status counts the architecture and keeps elements out of the effort counts', async () => {
    const root = setup();
    ticket(1, 'components: [writes, nowhere]\n');
    const d = await env.start();
    const s = (await tool(d, root, 'workspace_status')).structuredContent;
    expect(s.architecture).toEqual({ containers: 1, components: 1, proposed: 1, accepted: 1, warnings: 2 });
    expect(s.counts).toMatchObject({ items: 2, efforts: 1, by_kind: { map: 1, ticket: 1 }, by_status: { open: 2 } });
  });

  it('an empty architecture reports zeros', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    const s = (await tool(d, root, 'workspace_status')).structuredContent;
    expect(s.architecture).toEqual({ containers: 0, components: 0, proposed: 0, accepted: 0, warnings: 0 });
  });

  it('hand-edits, additions and deletions of element files reach the model through the watcher', async () => {
    const root = setup();
    const d = await env.start();
    const before = (await tool(d, root, 'get_item', { id: 'architecture/daemon', meta_only: true })).structuredContent.hash;
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the model did not catch up with the file system');
    };
    element('daemon', 'kind: container\ntitle: Daemon renamed\nreview: accepted\ncode: [src/daemon]');
    await until(async () => (await tool(d, root, 'get_item', { id: 'architecture/daemon', meta_only: true })).structuredContent?.hash !== before);
    expect((await tool(d, root, 'get_item', { id: 'architecture/daemon' })).structuredContent.frontmatter.title).toBe('Daemon renamed');
    element('cli', 'kind: container\ntitle: CLI\nreview: proposed');
    await until(async () => (await tool(d, root, 'workspace_status')).structuredContent.architecture.containers === 2);
    fs.rmSync(path.join(root, '.tasklog', 'architecture', 'cli.md'));
    await until(async () => (await tool(d, root, 'workspace_status')).structuredContent.architecture.containers === 1);
  });
});

describe('the reserved architecture effort name', () => {
  it('create_effort refuses architecture and creates nothing', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    const r = await tool(d, root, 'create_effort', { effort: 'architecture', title: 'Nope' });
    expect(errCode(r)).toBe('bad_request');
    expect(fs.existsSync(path.join(root, '.tasklog', 'architecture'))).toBe(false);
  });

  it('create_item refuses architecture even when the directory exists', async () => {
    const root = setup();
    const d = await env.start();
    const r = await tool(d, root, 'create_item', { effort: 'architecture', title: 'x', question: 'y' });
    expect(errCode(r)).toBe('bad_request');
    expect(fs.existsSync(path.join(root, '.tasklog', 'architecture', 'tickets'))).toBe(false);
  });
});

describe('the components field on tickets', () => {
  it('set_fields normalises, de-duplicates and stores components; get_item shows them', async () => {
    const root = setup();
    ticket(1);
    const d = await env.start();
    const hash = (await tool(d, root, 'get_item', { id: 'work/01', meta_only: true })).structuredContent.hash;
    const r = await tool(d, root, 'set_fields', { id: 'work/01', hash, components: ['Writes', 'writes', 'Some Thing'] });
    expect(r.isError).toBeFalsy();
    expect(read(root, '.tasklog/work/tickets/01-t1.md')).toContain('components: [writes, some-thing]');
    const got = (await tool(d, root, 'get_item', { id: 'work/01' })).structuredContent;
    expect(got.frontmatter.components).toEqual(['writes', 'some-thing']);
  });

  it('unknown slugs are accepted: the ticket gets a dangling flag and the status a warning', async () => {
    const root = setup();
    ticket(1);
    const d = await env.start();
    const hash = (await tool(d, root, 'get_item', { id: 'work/01', meta_only: true })).structuredContent.hash;
    const r = await tool(d, root, 'set_fields', { id: 'work/01', hash, components: ['writes', 'nowhere'] });
    expect(r.isError).toBeFalsy();
    const row = (await tool(d, root, 'list_items', { effort: 'work', kind: 'ticket' })).structuredContent.items[0];
    expect(row.flags).toEqual(['dangling']);
    expect((await tool(d, root, 'workspace_status')).structuredContent.architecture.warnings).toBe(2);
  });

  it('a ticket whose components all exist has no flag', async () => {
    const root = setup();
    ticket(1, 'components: [writes, daemon]\n');
    const d = await env.start();
    const row = (await tool(d, root, 'list_items', { kind: 'ticket' })).structuredContent.items[0];
    expect(row.flags).toEqual([]);
  });

  it.each([['map', 'work/map'], ['container', 'architecture/daemon'], ['component', 'architecture/writes']])('setting components on a %s is bad_request and changes nothing', async (_k, id) => {
    const root = setup();
    const d = await env.start();
    const meta = (await tool(d, root, 'get_item', { id, meta_only: true })).structuredContent;
    const before = read(root, meta.path);
    const r = await tool(d, root, 'set_fields', { id, hash: meta.hash, components: ['writes'] });
    expect(errCode(r)).toBe('bad_request');
    expect(read(root, meta.path)).toBe(before);
  });

  it('list_items filters by components (any of the given slugs)', async () => {
    const root = setup();
    ticket(1, 'components: [writes]\n');
    ticket(2, 'components: [daemon, writes]\n');
    ticket(3);
    const d = await env.start();
    const ids = async (components: string[]) => (await tool(d, root, 'list_items', { components })).structuredContent.items.map((i: any) => i.id);
    expect(await ids(['writes'])).toEqual(['work/01', 'work/02']);
    expect(await ids(['daemon'])).toEqual(['work/02']);
    expect(await ids(['Daemon', 'nowhere'])).toEqual(['work/02']);
  });
});

describe('set_fields on elements', () => {
  const hashOf = async (d: any, root: string, id: string) => (await tool(d, root, 'get_item', { id, meta_only: true })).structuredContent.hash;

  it('keeps bracket characters in code roots, such as a [id] route directory', async () => {
    const root = setup();
    const d = await env.start();
    const r = await tool(d, root, 'set_fields', { id: 'architecture/writes', hash: await hashOf(d, root, 'architecture/writes'), code: ['src/app/[id]', 'src/{slug}/page*.ts'] });
    expect(r.isError).toBeFalsy();
    const got = (await tool(d, root, 'get_item', { id: 'architecture/writes' })).structuredContent;
    expect(got.frontmatter.code).toEqual(['src/app/[id]', 'src/{slug}/page*.ts']);
  });

  it('edits title, review, code and uses in place', async () => {
    const root = setup();
    const d = await env.start();
    const r = await tool(d, root, 'set_fields', {
      id: 'architecture/writes',
      hash: await hashOf(d, root, 'architecture/writes'),
      title: 'Write service',
      review: 'accepted',
      code: ['src\\daemon\\writes.ts', './src/daemon/edit-tools.ts/', 'src/daemon/writes.ts'],
      uses: [{ to: 'Model', label: 'indexes' }, { to: 'store' }],
    });
    expect(r.isError).toBeFalsy();
    const got = (await tool(d, root, 'get_item', { id: 'architecture/writes' })).structuredContent;
    expect(got.frontmatter.title).toBe('Write service');
    expect(got.frontmatter.review).toBe('accepted');
    expect(got.frontmatter.code).toEqual(['src/daemon/writes.ts', 'src/daemon/edit-tools.ts']);
    expect(read(root, '.tasklog/architecture/writes.md')).toContain('uses:\n  - to: model\n    label: indexes\n  - to: store\n');
    // sections untouched
    expect(read(root, '.tasklog/architecture/writes.md')).toContain('## Description\n\n## Responsibilities\n');
  });

  it('sets and clears parent (an existing container only)', async () => {
    const root = setup();
    element('cli', 'kind: container\ntitle: CLI\nreview: accepted');
    const d = await env.start();
    const id = 'architecture/writes';
    expect((await tool(d, root, 'set_fields', { id, hash: await hashOf(d, root, id), parent: 'cli' })).isError).toBeFalsy();
    expect((await tool(d, root, 'get_item', { id })).structuredContent.frontmatter.parent).toBe('cli');
    expect((await tool(d, root, 'set_fields', { id, hash: await hashOf(d, root, id), parent: null })).isError).toBeFalsy();
    expect((await tool(d, root, 'get_item', { id })).structuredContent.frontmatter.parent).toBeUndefined();
  });

  it.each([
    ['a missing parent', 'architecture/writes', { parent: 'nope' }],
    ['a component as parent', 'architecture/writes', { parent: 'writes' }],
    ['a parent on a container', 'architecture/daemon', { parent: 'daemon' }],
    ['a self-referencing use', 'architecture/writes', { uses: [{ to: 'writes' }] }],
    ['a use with an empty target', 'architecture/writes', { uses: [{ to: ' ' }] }],
    ['a code path that escapes the workspace', 'architecture/writes', { code: ['../outside'] }],
    ['an unknown review value', 'architecture/writes', { review: 'maybe' }],
    ['a kind change', 'architecture/writes', { kind: 'container' }],
    ['a created change', 'architecture/writes', { created: '2020-01-01' }],
    ['tags on an element', 'architecture/writes', { tags: ['x'] }],
    ['reopen on an element', 'architecture/writes', { reopen: true }],
    ['review on a ticket', 'work/01', { review: 'accepted' }],
    ['code on a ticket', 'work/01', { code: ['src'] }],
  ])('%s is bad_request and changes nothing', async (_name, id, args) => {
    const root = setup();
    ticket(1);
    const d = await env.start();
    const meta = (await tool(d, root, 'get_item', { id, meta_only: true })).structuredContent;
    const before = read(root, meta.path);
    const r = await tool(d, root, 'set_fields', { id, hash: meta.hash, ...args });
    expect(errCode(r)).toBe('bad_request');
    expect(read(root, meta.path)).toBe(before);
  });

  it('a stale hash is stale_hash', async () => {
    const root = setup();
    const d = await env.start();
    const r = await tool(d, root, 'set_fields', { id: 'architecture/writes', hash: 'f'.repeat(64), title: 'X' });
    expect(errCode(r)).toBe('stale_hash');
  });

  it('preserves hand-written sections, CRLF and unknown keys', async () => {
    const root = setup();
    put(root, '.tasklog/architecture/crlf.md', '---\r\nkind: container\r\ntitle: Crlf\r\nreview: proposed\r\nowner: me\r\n---\r\n\r\n## Description\r\n\r\n## Interface\r\n\r\nKeep me.\r\n');
    const d = await env.start();
    const id = 'architecture/crlf';
    const r = await tool(d, root, 'set_fields', { id, hash: await hashOf(d, root, id), code: ['src/crlf'], review: 'accepted' });
    expect(r.isError).toBeFalsy();
    expect(read(root, '.tasklog/architecture/crlf.md')).toBe(
      '---\r\nkind: container\r\ntitle: Crlf\r\nreview: accepted\r\ncode: [src/crlf]\r\nowner: me\r\n---\r\n\r\n## Description\r\n\r\n## Interface\r\n\r\nKeep me.\r\n',
    );
  });
});

describe('workflow tools reject elements', () => {
  it.each(['claim', 'release', 'resolve', 'close', 'triage'])('%s on an element is bad_request', async (name) => {
    const root = setup();
    const d = await env.start();
    const id = 'architecture/writes';
    const args: Record<string, object> = {
      claim: { claimant: 'a' },
      release: { claimant: 'a' },
      resolve: { answer: 'x' },
      close: { reason: 'x' },
      triage: { state: 'needs-triage' },
    };
    const before = read(root, '.tasklog/architecture/writes.md');
    const r = await tool(d, root, name, { id, ...args[name] });
    expect(errCode(r)).toBe('bad_request');
    expect(read(root, '.tasklog/architecture/writes.md')).toBe(before);
  });
});
