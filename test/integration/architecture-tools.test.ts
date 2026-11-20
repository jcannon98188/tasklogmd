// Slice 2 of the architecture build: create_element, architecture and owners through the daemon tool API.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, mkWorkspace, type TestEnv } from '../helpers.ts';

let env: TestEnv;
let workspace: string;
let daemon: ReturnType<TestEnv['start']> | undefined;
const start = () => (daemon ??= env.start());
beforeEach(() => {
  env = makeEnv();
  daemon = undefined;
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
const read = (rel: string) => fs.readFileSync(path.join(workspace, ...rel.split('/')), 'utf8');

function put(rel: string, text: string): void {
  const abs = path.join(workspace, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const DATES = 'created: 2026-01-01\nupdated: 2026-01-01';
const element = (slug: string, front: string): void => {
  put(`.tasklog/architecture/${slug}.md`, `---\n${front}\n${DATES}\n---\n\n## Description\n\n## Responsibilities\n`);
};
const ticket = (n: number, extra = '', status = 'open'): void => {
  put(`.tasklog/work/tickets/0${n}-t${n}.md`, `---\nkind: ticket\ntitle: Ticket ${n}\nstatus: ${status}\n${extra}created: 2026-01-01\nupdated: 2026-01-01\n---\n\n## Question\n\nQ\n`);
};
const initWork = (): void => put('.tasklog/work/map.md', '---\nkind: map\ntitle: Work\nstatus: open\n---\n\n## Destination\n');

const hashes = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(workspace, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(path.join(workspace, '.tasklog'));
  return out;
};

describe('architecture', () => {
  const arch = async (args: object = {}) => {
    const d = await start();
    return tool(d, workspace, 'architecture', args);
  };
  const file = (rel: string): void => put(rel, 'export {};\n');

  // daemon (container) with components writes and tools; model (container). `tools` points at a directory that is gone.
  const setupTree = (eol = '\n'): void => {
    workspace = mkWorkspace(env.root);
    initWork();
    const el = (slug: string, front: string): void => put(`.tasklog/architecture/${slug}.md`, `---\n${front}\n${DATES}\n---\n\n## Description\n\nBody text.\n\n## Responsibilities\n`.replace(/\n/g, eol));
    el('daemon', 'kind: container\ntitle: Daemon\nreview: accepted\ncode: [src/daemon]\nuses:\n  - to: model\n    label: reads items\n  - to: nowhere');
    el('model', 'kind: container\ntitle: Model\nreview: proposed\ncode: [src/model]');
    el('writes', 'kind: component\ntitle: Writes\nreview: proposed\nparent: daemon\ncode: [src/daemon/writes.ts]');
    el('tools', 'kind: component\ntitle: Tools\nreview: accepted\nparent: daemon\ncode: [src/daemon/tools]');
    file('src/daemon/writes.ts');
    file('src/daemon/core.ts');
    file('src/model/a.ts');
    file('src/stray/x.ts');
  };

  const DAEMON = { id: 'daemon', title: 'Daemon', review: 'accepted', uses: [{ to: 'model', label: 'reads items' }, { to: 'nowhere' }], tickets: { open: 0, claimed: 0 } };
  const MODEL = { id: 'model', title: 'Model', review: 'proposed', uses: [], tickets: { open: 0, claimed: 0 } };
  const WRITES = { id: 'writes', title: 'Writes', review: 'proposed', uses: [], tickets: { open: 0, claimed: 0 } };
  const TOOLS = { id: 'tools', title: 'Tools', review: 'accepted', uses: [], tickets: { open: 0, claimed: 0 } };
  const MISSING = { category: 'missing-path', id: 'tools', path: 'src/daemon/tools', detail: 'Element tools owns src/daemon/tools, but no files were found there.' };
  const UNOWNED = { category: 'unowned-code', path: 'src', detail: 'Code in src is not owned by any element.' };
  const WARN_USES = { id: 'architecture/daemon', field: 'uses', slug: 'nowhere', detail: 'daemon uses "nowhere", which is not an element' };

  it('returns the nested tree with drift and warnings, no bodies and no code arrays', async () => {
    setupTree();
    const r = await arch();
    expect(r.structuredContent).toEqual({
      containers: [
        { ...DAEMON, children: [TOOLS, WRITES] },
        { ...MODEL, children: [] },
      ],
      findings: [MISSING, UNOWNED],
      warnings: [WARN_USES],
    });
  });

  it('reads CRLF element files the same way', async () => {
    setupTree('\r\n');
    const r = await arch();
    expect(r.structuredContent.containers.map((c: any) => [c.id, c.children.map((x: any) => x.id)])).toEqual([['daemon', ['tools', 'writes']], ['model', []]]);
  });

  it('counts open and claimed tickets directly, never rolled up, and ignores resolved ones', async () => {
    setupTree();
    ticket(1, 'components: [writes]\n');
    ticket(2, 'components: [writes, daemon]\n', 'claimed');
    ticket(3, 'components: [writes]\n', 'resolved');
    const r = await arch({ drift: false });
    const daemon = r.structuredContent.containers[0];
    expect(daemon.tickets).toEqual({ open: 0, claimed: 1 });
    expect(daemon.children.find((c: any) => c.id === 'writes').tickets).toEqual({ open: 1, claimed: 1 });
  });

  it('a dangling ticket component is a warning and a flag', async () => {
    setupTree();
    ticket(1, 'components: [nowhere]\n');
    const r = await arch({ drift: false });
    expect(r.structuredContent.warnings).toContainEqual({ id: 'work/01', field: 'components', slug: 'nowhere', detail: 'ticket work/01 links "nowhere", which is not an element' });
    const list = await tool(await start(), workspace, 'list_items', { effort: 'work' });
    expect(list.structuredContent.items.find((i: any) => i.id === 'work/01').flags).toContain('dangling');
  });

  it('drift: false skips findings', async () => {
    setupTree();
    expect((await arch({ drift: false })).structuredContent.findings).toEqual([]);
  });

  it('an empty architecture gives an empty tree and reports code as unowned', async () => {
    workspace = mkWorkspace(env.root);
    file('src/a.ts');
    file('top.ts');
    file('node_modules/dep/index.js');
    file('docs/readme.md');
    const r = await arch();
    expect(r.structuredContent).toEqual({
      containers: [],
      findings: [
        { category: 'unowned-code', path: '.', detail: 'Code in . is not owned by any element.' },
        { category: 'unowned-code', path: 'src', detail: 'Code in src is not owned by any element.' },
      ],
      warnings: [],
    });
  });

  it('a container root returns its subtree', async () => {
    setupTree();
    const r = await arch({ root: 'daemon' });
    expect(r.structuredContent.containers).toEqual([{ ...DAEMON, children: [TOOLS, WRITES] }]);
  });

  it('a component root returns the parent as a stub with that one child', async () => {
    setupTree();
    ticket(1, 'components: [daemon]\n');
    const r = await arch({ root: 'writes' });
    expect(r.structuredContent.containers).toEqual([{ ...DAEMON, tickets: { open: 1, claimed: 0 }, children: [WRITES] }]);
  });

  it('depth 0 omits children; depth above 1 behaves like 1', async () => {
    setupTree();
    expect((await arch({ depth: 0 })).structuredContent.containers).toEqual([DAEMON, MODEL]);
    expect((await arch({ depth: 5, root: 'daemon' })).structuredContent.containers[0].children).toHaveLength(2);
    expect((await arch({ depth: 0, root: 'writes' })).structuredContent.containers[0].children.map((c: any) => c.id)).toEqual(['writes']);
  });

  it.each([
    ['a missing slug', { root: 'nope' }, 'not_found'],
    ['the Item ID form', { root: 'architecture/daemon' }, 'bad_request'],
    ['an empty root', { root: '' }, 'bad_request'],
    ['a wrong-typed root', { root: 7 }, 'bad_request'],
    ['a negative depth', { depth: -1 }, 'bad_request'],
    ['a fractional depth', { depth: 0.5 }, 'bad_request'],
  ])('%s fails %s', async (_n, args, code) => {
    setupTree();
    expect(errCode(await arch(args))).toBe(code);
  });

  it('a scoped call keeps findings for its subtree by id and by path, and drops unowned-code', async () => {
    setupTree();
    file('src/daemon/extra/y.ts');
    const r = await arch({ root: 'model' });
    expect(r.structuredContent.findings).toEqual([]);
    expect((await arch({ root: 'daemon' })).structuredContent.findings).toEqual([MISSING]);
    expect((await arch({ root: 'tools' })).structuredContent.findings).toEqual([MISSING]);
    expect((await arch({ root: 'writes' })).structuredContent.findings).toEqual([]);
  });

  it('a scoped call keeps only warnings that sit inside the subtree', async () => {
    setupTree();
    ticket(1, 'components: [nowhere]\n');
    expect((await arch({ root: 'daemon' })).structuredContent.warnings).toEqual([WARN_USES]);
    expect((await arch({ root: 'model' })).structuredContent.warnings).toEqual([]);
    expect((await arch({ root: 'daemon' })).structuredContent.warnings.some((w: any) => w.id === 'work/01')).toBe(false);
  });

  it('an element with a missing parent is not in the tree but is warned about', async () => {
    workspace = mkWorkspace(env.root);
    element('orphan', 'kind: component\ntitle: Orphan\nreview: accepted\nparent: ghost\ncode: [src/o]');
    const r = await arch({ drift: false });
    expect(r.structuredContent.containers).toEqual([]);
    expect(r.structuredContent.warnings).toEqual([{ id: 'architecture/orphan', field: 'parent', slug: 'ghost', detail: 'orphan has parent "ghost", which is not a container' }]);
  });

  it('writes nothing', async () => {
    setupTree();
    const before = hashes();
    await arch();
    await arch({ root: 'writes', depth: 0 });
    expect(hashes()).toEqual(before);
  });
});

describe('create_element', () => {
  const create = async (args: object) => {
    const d = await start();
    return tool(d, workspace, 'create_element', args);
  };

  it('creates an accepted container with empty Description and Responsibilities only', async () => {
    workspace = mkWorkspace(env.root);
    const r = await create({ kind: 'container', title: 'Billing API', code: ['src\\billing/', './src/pay'] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ id: 'architecture/billing-api', slug: 'billing-api', path: '.tasklog/architecture/billing-api.md' });
    const today = new Date().toISOString().slice(0, 10);
    expect(read('.tasklog/architecture/billing-api.md')).toBe(
      `---\nkind: container\ntitle: Billing API\nreview: accepted\ncode: [src/billing, src/pay]\ncreated: ${today}\nupdated: ${today}\n---\n\n## Description\n\n## Responsibilities\n`,
    );
    const d = await start();
    const got = await tool(d, workspace, 'get_item', { id: 'architecture/billing-api', meta_only: true });
    expect(got.structuredContent.hash).toBe(r.structuredContent.hash);
  });

  it('creates a component under a container parent', async () => {
    workspace = mkWorkspace(env.root);
    await create({ kind: 'container', title: 'Daemon' });
    const r = await create({ kind: 'component', title: 'Write Tools', parent: 'daemon', code: ['src/daemon/tools'] });
    expect(r.structuredContent.slug).toBe('write-tools');
    const text = read('.tasklog/architecture/write-tools.md');
    expect(text).toContain('kind: component\ntitle: Write Tools\nreview: accepted\nparent: daemon\ncode: [src/daemon/tools]\n');
    expect(text).not.toContain('uses');
  });

  it('a hand-created element shows up in owners immediately', async () => {
    workspace = mkWorkspace(env.root);
    await create({ kind: 'container', title: 'Web', code: ['web'] });
    const d = await start();
    const r = await tool(d, workspace, 'owners', { paths: ['web/a.ts'] });
    expect(r.structuredContent.owners.map((o: any) => o.id)).toEqual(['web']);
  });

  it.each([
    ['a parent on a container', { kind: 'container', title: 'X', parent: 'daemon' }, 'bad_request'],
    ['a non-container parent', { kind: 'component', title: 'X', parent: 'writes' }, 'bad_request'],
    ['a missing parent', { kind: 'component', title: 'X', parent: 'nope' }, 'not_found'],
    ['a bad kind', { kind: 'system', title: 'X' }, 'bad_request'],
    ['an empty title', { kind: 'container', title: '  ' }, 'bad_request'],
    ['a title with no usable slug', { kind: 'container', title: '***' }, 'bad_request'],
    ['a glob in code', { kind: 'container', title: 'X', code: ['src/*'] }, 'bad_request'],
    ['code escaping the workspace', { kind: 'container', title: 'X', code: ['../x'] }, 'bad_request'],
    ['a slug that already exists', { kind: 'container', title: 'Daemon' }, 'bad_request'],
  ])('refuses %s with %s', async (_n, args, code) => {
    workspace = mkWorkspace(env.root);
    element('daemon', 'kind: container\ntitle: Daemon\nreview: accepted');
    element('writes', 'kind: component\ntitle: Writes\nreview: accepted\nparent: daemon');
    const before = hashes();
    expect(errCode(await create(args))).toBe(code);
    expect(hashes()).toEqual(before);
  });

  it('exactly one of two racing creates of the same slug wins', async () => {
    workspace = mkWorkspace(env.root);
    const d = await start();
    const rs = await Promise.all([tool(d, workspace, 'create_element', { kind: 'container', title: 'Same' }), tool(d, workspace, 'create_element', { kind: 'container', title: 'Same' })]);
    expect(rs.filter((r) => !r.isError)).toHaveLength(1);
    expect(rs.filter((r) => r.isError).map(errCode)).toEqual(['bad_request']);
  });
});

describe('owners', () => {
  // daemon container (src/daemon, src/shared), daemon-tools component (src/daemon/tools), a second container at `.`.
  const setupOwners = (): void => {
    workspace = mkWorkspace(env.root);
    element('daemon', 'kind: container\ntitle: Daemon\nreview: accepted\ncode: [src/daemon, src/shared]');
    element('daemon-tools', 'kind: component\ntitle: Daemon tools\nreview: accepted\nparent: daemon\ncode: [src/daemon/tools]');
    element('rest', 'kind: container\ntitle: Rest\nreview: accepted\ncode: ["."]');
  };

  const owners = async (paths: unknown) => {
    const d = await start();
    return tool(d, workspace, 'owners', { paths });
  };

  it('a file in the component root goes to the component, not its container', async () => {
    setupOwners();
    const r = await owners(['src/daemon/tools/a.ts']);
    expect(r.structuredContent).toEqual({ owners: [{ id: 'daemon-tools', kind: 'component', title: 'Daemon tools', paths: ['src/daemon/tools/a.ts'] }], unowned: [] });
  });

  it('a file in the container outside any component goes to the container', async () => {
    setupOwners();
    const r = await owners(['src/shared/x.ts', 'src/daemon/core.ts']);
    expect(r.structuredContent).toEqual({ owners: [{ id: 'daemon', kind: 'container', title: 'Daemon', paths: ['src/shared/x.ts', 'src/daemon/core.ts'] }], unowned: [] });
  });

  it('a path under no root is unowned', async () => {
    workspace = mkWorkspace(env.root);
    element('daemon', 'kind: container\ntitle: Daemon\nreview: accepted\ncode: [src/daemon]');
    const r = await owners(['docs/readme.md']);
    expect(r.structuredContent).toEqual({ owners: [], unowned: ['docs/readme.md'] });
  });

  it('the container rooted at . owns what nothing longer owns', async () => {
    setupOwners();
    const r = await owners(['docs/readme.md']);
    expect(r.structuredContent.owners.map((o: any) => o.id)).toEqual(['rest']);
  });

  it('two elements with the identical longest root both list the path', async () => {
    workspace = mkWorkspace(env.root);
    element('a', 'kind: container\ntitle: A\nreview: accepted\ncode: [src/x]');
    element('b', 'kind: container\ntitle: B\nreview: accepted\ncode: [src/x]');
    const r = await owners(['src/x/f.ts']);
    expect(r.structuredContent.owners.map((o: any) => [o.id, o.paths])).toEqual([['a', ['src/x/f.ts']], ['b', ['src/x/f.ts']]]);
    expect(r.structuredContent.unowned).toEqual([]);
  });

  it('a sibling directory sharing a prefix does not match', async () => {
    workspace = mkWorkspace(env.root);
    element('daemon', 'kind: container\ntitle: Daemon\nreview: accepted\ncode: [src/daemon]');
    const r = await owners(['src/daemon-x/a.ts']);
    expect(r.structuredContent).toEqual({ owners: [], unowned: ['src/daemon-x/a.ts'] });
  });

  it('normalises backslashes, ./, trailing slash, doubled separators and absolute paths under the workspace', async () => {
    setupOwners();
    const abs = path.join(workspace, 'src', 'daemon', 'tools', 'abs.ts');
    const r = await owners(['src\\daemon\\tools\\a.ts', './src/daemon/tools/b.ts', 'src/daemon/tools/', 'src//daemon//tools//c.ts', abs]);
    expect(r.structuredContent.owners).toEqual([
      { id: 'daemon-tools', kind: 'component', title: 'Daemon tools', paths: ['src/daemon/tools/a.ts', 'src/daemon/tools/b.ts', 'src/daemon/tools', 'src/daemon/tools/c.ts', 'src/daemon/tools/abs.ts'] },
    ]);
  });

  it('matching is case-sensitive', async () => {
    workspace = mkWorkspace(env.root);
    element('daemon', 'kind: container\ntitle: Daemon\nreview: accepted\ncode: [src/daemon]');
    const r = await owners(['Src/daemon/a.ts']);
    expect(r.structuredContent.unowned).toEqual(['Src/daemon/a.ts']);
  });

  it.each([['an escaping ..', '../outside/x.ts'], ['an absolute path outside the workspace', path.join(path.dirname(path.resolve('/')), 'elsewhere', 'x.ts')]])('%s fails bad_request naming the path', async (_n, p) => {
    setupOwners();
    const r = await owners(['src/daemon/a.ts', p]);
    expect(errCode(r)).toBe('bad_request');
    expect(r.structuredContent.error.message).toContain(p.replace(/\\/g, '/').split('/').pop());
  });

  it('a directory equal to a root resolves to it; an ancestor-only path is unowned; . matches only a root of .', async () => {
    workspace = mkWorkspace(env.root);
    element('a', 'kind: container\ntitle: A\nreview: accepted\ncode: [src/a]');
    element('b', 'kind: container\ntitle: B\nreview: accepted\ncode: [src/b]');
    const r = await owners(['src/a', 'src', '.']);
    expect(r.structuredContent).toEqual({ owners: [{ id: 'a', kind: 'container', title: 'A', paths: ['src/a'] }], unowned: ['src', '.'] });
  });

  it('an empty architecture sends everything to unowned', async () => {
    workspace = mkWorkspace(env.root);
    const r = await owners(['a.ts', 'b/c.ts']);
    expect(r.structuredContent).toEqual({ owners: [], unowned: ['a.ts', 'b/c.ts'] });
  });

  it.each([['an empty array', []], ['more than 500 paths', Array.from({ length: 501 }, (_, i) => `f${i}.ts`)], ['a non-array', 'src/a.ts']])('%s fails bad_request', async (_n, paths) => {
    setupOwners();
    expect(errCode(await owners(paths))).toBe('bad_request');
  });

  it('duplicate inputs collapse to one', async () => {
    setupOwners();
    const r = await owners(['src/shared/a.ts', './src/shared/a.ts', 'src\\shared\\a.ts', 'nothing.txt', 'nothing.txt']);
    expect(r.structuredContent.owners[0].paths).toEqual(['src/shared/a.ts']);
    expect(r.structuredContent.owners.map((o: any) => o.id)).toEqual(['daemon', 'rest']);
    expect(r.structuredContent.owners[1].paths).toEqual(['nothing.txt']);
  });

  it('writes nothing', async () => {
    setupOwners();
    ticket(1, 'components: [daemon]\n');
    const before = hashes();
    await owners(['src/daemon/a.ts', 'src/daemon/tools/b.ts']);
    expect(hashes()).toEqual(before);
  });
});
