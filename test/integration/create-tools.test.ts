import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFixture, makeEnv, mkWorkspace, type TestEnv } from '../helpers.ts';

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
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe('create_effort', () => {
  it('creates map.md and spec.md with fixed headings, LF endings and canonical keys, and returns the IDs', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    const r = await tool(d, root, 'create_effort', { effort: 'billing', title: 'Billing', destination: 'Charge people.' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ map_id: 'billing/map', spec_id: 'billing/spec' });
    const map = read(root, '.tasklog/billing/map.md');
    expect(map).not.toContain('\r');
    expect(map).toMatch(/^---\nkind: map\ntitle: Billing\nstatus: open\ncreated: \d{4}-\d\d-\d\d\nupdated: \d{4}-\d\d-\d\d\n---\n/);
    expect([...map.matchAll(/^## (.*)$/gm)].map((m) => m[1])).toEqual(['Destination', 'Notes', 'Decisions so far', 'Not yet specified', 'Out of scope']);
    expect(map).toContain('## Destination\n\nCharge people.\n');
    expect(read(root, '.tasklog/billing/spec.md')).toMatch(/^---\nkind: spec\ntitle: Billing\n/);
    // visible through the read tools with the returned hashes
    const got = await tool(d, root, 'get_item', { id: 'billing/map' });
    expect(got.structuredContent.hash).toBe(r.structuredContent.map_hash);
    expect((await tool(d, root, 'get_item', { id: 'billing/spec' })).structuredContent.hash).toBe(r.structuredContent.spec_hash);
  });

  it('fails bad_request for an existing effort and changes nothing', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const before = walk(path.join(root, '.tasklog')).map((f) => [f, fs.readFileSync(f, 'utf8')]);
    const r = await tool(d, root, 'create_effort', { effort: 'alpha', title: 'Again' });
    expect(errCode(r)).toBe('bad_request');
    expect(walk(path.join(root, '.tasklog')).map((f) => [f, fs.readFileSync(f, 'utf8')])).toEqual(before);
  });

  it('rejects names that are not lowercase kebab-case', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    expect(errCode(await tool(d, root, 'create_effort', { effort: 'Bad Name', title: 'x' }))).toBe('bad_request');
    expect(errCode(await tool(d, root, 'create_effort', { effort: '../x', title: 'x' }))).toBe('bad_request');
    expect(walk(path.join(root, '.tasklog'))).toEqual([]);
  });

  it('two racing creates of one effort: exactly one wins', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    const rs = await Promise.all([1, 2, 3].map(() => tool(d, root, 'create_effort', { effort: 'race', title: 'Race' })));
    expect(rs.filter((r) => !r.isError)).toHaveLength(1);
    expect(rs.filter((r) => errCode(r) === 'bad_request')).toHaveLength(2);
  });
});

describe('create_item', () => {
  it('numbers max+1 over all files including conflicted ones, with no counters', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    await tool(d, root, 'create_effort', { effort: 'e', title: 'E' });
    const tickets = path.join(root, '.tasklog', 'e', 'tickets');
    const stub = (t: string) => `---\nkind: ticket\ntitle: ${t}\nstatus: open\n---\n\n## Question\n\nq\n`;
    fs.writeFileSync(path.join(tickets, '03-a.md'), stub('a'));
    fs.writeFileSync(path.join(tickets, '3-b.md'), stub('b')); // conflicts with 03
    fs.writeFileSync(path.join(tickets, '07-bad.md'), 'not frontmatter'); // invalid still counts
    const r = await tool(d, root, 'create_item', { effort: 'e', title: 'Next one', question: 'What?' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.id).toBe('e/08');
    expect(fs.existsSync(path.join(tickets, '08-next-one.md'))).toBe(true);
    const again = await tool(d, root, 'create_item', { effort: 'e', title: 'Another', question: 'Q' });
    expect(again.structuredContent.id).toBe('e/09');
    // no stored counters: nothing else was written
    expect(fs.readdirSync(path.join(root, '.tasklog')).sort()).toEqual(['e']);
  });

  it('starts at 01 in an empty effort and returns a hash matching get_item', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    await tool(d, root, 'create_effort', { effort: 'e', title: 'E' });
    const r = await tool(d, root, 'create_item', { effort: 'e', title: 'First', question: 'Q' });
    expect(r.structuredContent).toMatchObject({ id: 'e/01' });
    expect((await tool(d, root, 'get_item', { id: 'e/01' })).structuredContent.hash).toBe(r.structuredContent.hash);
  });

  it('fails bad_request without effort, and not_found for an unknown effort; writes nothing', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const before = walk(path.join(root, '.tasklog')).length;
    expect(errCode(await tool(d, root, 'create_item', { title: 'x', question: 'q' }))).toBe('bad_request');
    expect(errCode(await tool(d, root, 'create_item', { effort: '', title: 'x', question: 'q' }))).toBe('bad_request');
    expect(errCode(await tool(d, root, 'create_item', { effort: 'nope', title: 'x', question: 'q' }))).toBe('not_found');
    expect(walk(path.join(root, '.tasklog')).length).toBe(before);
  });

  it('writes blocked_by and tags normalized, and no type key when type is omitted', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    await tool(d, root, 'create_effort', { effort: 'e', title: 'E' });
    await tool(d, root, 'create_effort', { effort: 'o', title: 'O' });
    await tool(d, root, 'create_item', { effort: 'e', title: 'Base', question: 'Q' });
    const r = await tool(d, root, 'create_item', { effort: 'e', title: 'T', question: 'Q', blocked_by: ['e/1', 'o/2'], tags: ['Needs Info', 'X_Y'] });
    expect(r.isError).toBeFalsy();
    const text = read(root, r.structuredContent.path);
    expect(text).toContain('blocked_by: [1, "o/02"]');
    expect(text).toContain('tags: [needs-info, x-y]');
    expect(text).not.toMatch(/^type:/m);
    const typed = await tool(d, root, 'create_item', { effort: 'e', title: 'Typed', question: 'Q', type: 'research' });
    expect(read(root, typed.structuredContent.path)).toMatch(/^type: research$/m);
    const got = await tool(d, root, 'get_item', { id: 'e/02' });
    expect(got.structuredContent.frontmatter.tags).toEqual(['needs-info', 'x-y']);
  });

  it('derives the slug from the title and never renames the file when the title changes', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    await tool(d, root, 'create_effort', { effort: 'e', title: 'E' });
    const r = await tool(d, root, 'create_item', { effort: 'e', title: 'Add the Fancy Thing!', question: 'Q' });
    expect(r.structuredContent.path).toBe('.tasklog/e/tickets/01-add-the-fancy-thing.md');
    const s = await tool(d, root, 'set_fields', { id: 'e/01', hash: r.structuredContent.hash, title: 'Completely different' });
    expect(s.isError).toBeFalsy();
    expect(fs.readdirSync(path.join(root, '.tasklog', 'e', 'tickets'))).toEqual(['01-add-the-fancy-thing.md']);
  });

  it('concurrent creates get distinct consecutive numbers and leave no temp files', async () => {
    const root = mkWorkspace(env.root);
    const d = await env.start();
    await tool(d, root, 'create_effort', { effort: 'e', title: 'E' });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => tool(d, root, 'create_item', { effort: 'e', title: `T${i}`, question: 'Q' })));
    expect(rs.map((r) => r.structuredContent.id).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `e/0${i + 1}`));
    expect(walk(path.join(root, '.tasklog')).filter((f) => f.endsWith('.tasklog-tmp'))).toEqual([]);
  });
});
