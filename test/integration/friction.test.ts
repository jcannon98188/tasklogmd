import { execFileSync } from 'node:child_process';
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

async function setup() {
  const root = mkWorkspace(env.root);
  const d = await env.start();
  const t = (name: string, args: object = {}) => tool(d, root, name, args);
  await t('create_effort', { effort: 'e', title: 'Effort E', destination: 'Ship the thing. Then relax.' });
  await t('create_item', { effort: 'e', title: 'One', question: 'q1', type: 'research' });
  await t('create_item', { effort: 'e', title: 'Two', question: 'q2' });
  return { root, t };
}
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

describe('slim reads', () => {
  it('overview omits Decisions gists by default and restores them with verbose', async () => {
    const { t } = await setup();
    await t('resolve', { id: 'e/01', answer: 'a', gist: 'UNIQUEGIST' });
    const slim = (await t('overview', { effort: 'e' })).structuredContent;
    expect(slim.done).toEqual([{ id: 'e/01', title: 'One' }]);
    expect(slim.markdown).not.toContain('UNIQUEGIST');
    expect(slim.drift).toEqual([]);
    const full = (await t('overview', { effort: 'e', verbose: true })).structuredContent;
    expect(full.done).toEqual([{ id: 'e/01', title: 'One', gist: 'UNIQUEGIST' }]);
    expect(full.markdown).toContain('UNIQUEGIST');
  });

  it('get_item meta_only returns hash and frontmatter without the body', async () => {
    const { t } = await setup();
    const full = (await t('get_item', { id: 'e/01' })).structuredContent;
    const meta = (await t('get_item', { id: 'e/01', meta_only: true })).structuredContent;
    expect(meta.hash).toBe(full.hash);
    expect(meta.frontmatter).toEqual(full.frontmatter);
    expect(meta.body).toBeUndefined();
    expect(meta.acs).toBeUndefined();
  });

  it('get_item sections returns only the named sections, case-insensitively', async () => {
    const { t } = await setup();
    const r = (await t('get_item', { id: 'e/map', sections: ['destination', 'Nope'] })).structuredContent;
    expect(r.body).toBeUndefined();
    expect(r.sections).toEqual({ destination: 'Ship the thing. Then relax.', Nope: null });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('frontier fields keeps only the requested keys (id always included)', async () => {
    const { t } = await setup();
    await t('claim', { id: 'e/02', claimant: 'me' });
    const f = (await t('frontier', { effort: 'e', fields: ['title'] })).structuredContent;
    expect(f.ready).toEqual([{ id: 'e/01', title: 'One' }]);
    expect(f.claimed).toEqual([{ id: 'e/02', title: 'Two' }]);
  });
});

describe('stale map hash', () => {
  it('stale_hash returns the current hash in details', async () => {
    const { t } = await setup();
    const old = (await t('get_item', { id: 'e/map' })).structuredContent.hash;
    await t('resolve', { id: 'e/01', answer: 'a', gist: 'g' }); // rewrites the map behind our back
    const now = (await t('get_item', { id: 'e/map', meta_only: true })).structuredContent.hash;
    const r = await t('replace_section', { id: 'e/map', hash: old, heading: 'Notes', content: 'n' });
    expect(r.structuredContent.error.code).toBe('stale_hash');
    expect(r.structuredContent.error.details.current_hash).toBe(now);
  });

  it('append_to_section works without a hash', async () => {
    const { t, root } = await setup();
    await t('resolve', { id: 'e/01', answer: 'a', gist: 'g' });
    const r = await t('append_to_section', { id: 'e/map', heading: 'Notes', content: 'a note' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, '.tasklog/e/map.md'), 'utf8')).toContain('a note');
  });
});

describe('resolve answers', () => {
  it('names the offending line when the answer has a ## heading', async () => {
    const { t } = await setup();
    const r = await t('resolve', { id: 'e/01', answer: 'first\n\n## Extra\n\nmore' });
    expect(r.structuredContent.error.code).toBe('bad_request');
    expect(r.structuredContent.error.message).toContain('line 3');
    expect(r.structuredContent.error.message).toContain('answer_sections');
  });

  it('answer_sections writes an Answer plus extra sections', async () => {
    const { t, root } = await setup();
    const r = await t('resolve', { id: 'e/01', answer_sections: { Answer: 'the answer', Evidence: 'the proof' }, gist: 'g' });
    expect(r.isError).toBeFalsy();
    const text = fs.readFileSync(path.join(root, '.tasklog/e/tickets/01-one.md'), 'utf8');
    expect(text).toMatch(/## Answer\n\nthe answer/);
    expect(text).toMatch(/## Evidence\n\nthe proof/);
    expect(text).toContain('status: resolved');
  });

  it('needs an answer or an Answer section', async () => {
    const { t } = await setup();
    const r = await t('resolve', { id: 'e/01', answer_sections: { Evidence: 'x' } });
    expect(r.structuredContent.error.code).toBe('bad_request');
  });
});

describe('commit: true', () => {
  async function repo() {
    const s = await setup();
    git(s.root, 'init', '-q');
    git(s.root, 'config', 'user.name', 'T');
    git(s.root, 'config', 'user.email', 't@example.com');
    git(s.root, 'config', 'commit.gpgsign', 'false');
    git(s.root, 'add', '.');
    git(s.root, 'commit', '-q', '-m', 'init');
    return s;
  }

  it('resolve commits .tasklog with a standard message and does not push', async () => {
    const { t, root } = await repo();
    const r = (await t('resolve', { id: 'e/01', answer: 'a', gist: 'g', commit: true })).structuredContent;
    expect(r.commit.ok).toBe(true);
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Resolve e/01: One');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('close and create_item commit too, and extra staged files ride along', async () => {
    const { t, root } = await repo();
    fs.writeFileSync(path.join(root, 'GLOSSARY.md'), 'x');
    git(root, 'add', 'GLOSSARY.md');
    const c = (await t('create_item', { effort: 'e', title: 'Three', question: 'q', commit: true })).structuredContent;
    expect(c.commit.ok).toBe(true);
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Create e/03: Three');
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toContain('GLOSSARY.md');
    const x = (await t('close', { id: 'e/02', reason: 'no', commit: true })).structuredContent;
    expect(x.commit.ok).toBe(true);
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Close e/02: Two');
  });

  it('reports a commit failure without failing the write', async () => {
    const { t } = await setup(); // not a git repo
    const r = await t('resolve', { id: 'e/01', answer: 'a', commit: true });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.commit.ok).toBe(false);
    expect(typeof r.structuredContent.commit.error).toBe('string');
  });

  it('does not commit unless asked', async () => {
    const { t, root } = await repo();
    await t('resolve', { id: 'e/01', answer: 'a' });
    expect(git(root, 'log', '-1', '--format=%s')).toBe('init');
  });
});
