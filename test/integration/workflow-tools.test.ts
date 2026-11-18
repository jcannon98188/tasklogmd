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
const abs = (root: string, rel: string) => path.join(root, ...rel.split('/'));
const read = (root: string, rel: string) => fs.readFileSync(abs(root, rel), 'utf8');
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

async function setup(extra?: (root: string) => void) {
  const root = mkWorkspace(env.root);
  extra?.(root);
  const d = await env.start();
  const t = (name: string, args: object = {}) => tool(d, root, name, args);
  await t('create_effort', { effort: 'e', title: 'Effort E', destination: 'Ship the thing. Then relax.' });
  return { root, d, t };
}

describe('frontier', () => {
  it('ready when blockers are resolved or closed; missing, conflicted and invalid blockers keep it blocked with a reason', async () => {
    const { t } = await setup();
    await t('create_item', { effort: 'e', title: 'One', question: 'q' }); // 01
    await t('create_item', { effort: 'e', title: 'Two', question: 'q', blocked_by: [1] }); // 02
    await t('create_item', { effort: 'e', title: 'Three', question: 'q', blocked_by: [1, 2] }); // 03
    await t('create_item', { effort: 'e', title: 'Four', question: 'q', blocked_by: [99] }); // 04 missing
    let f = (await t('frontier', { effort: 'e' })).structuredContent;
    expect(ids(f.ready)).toEqual(['e/01']);
    const blocked = Object.fromEntries(f.blocked.map((b: any) => [b.id, b.reasons.map((r: any) => r.state)]));
    expect(blocked['e/02']).toEqual(['open']);
    expect(blocked['e/04']).toEqual(['missing']);

    await t('resolve', { id: 'e/01', answer: 'done' });
    f = (await t('frontier', { effort: 'e' })).structuredContent;
    expect(ids(f.ready)).toEqual(['e/02']);
    await t('close', { id: 'e/02', reason: 'not needed' });
    f = (await t('frontier', { effort: 'e' })).structuredContent;
    expect(ids(f.ready)).toEqual(['e/03']);
  });

  it('reports invalid and conflicted blockers', async () => {
    const root = mkWorkspace(env.root);
    const fm = (n: string, extra = '') => `---\nkind: ticket\ntitle: T${n}\nstatus: open\n${extra}---\n\n## Question\n\nq\n`;
    fs.mkdirSync(abs(root, '.tasklog/e/tickets'), { recursive: true });
    fs.writeFileSync(abs(root, '.tasklog/e/map.md'), '---\nkind: map\ntitle: E\nstatus: open\n---\n\n## Destination\n\nGo.\n');
    fs.writeFileSync(abs(root, '.tasklog/e/tickets/01-a.md'), fm('1', 'blocked_by: [2, 3, 4]\n'));
    fs.writeFileSync(abs(root, '.tasklog/e/tickets/02-bad.md'), 'garbage');
    fs.writeFileSync(abs(root, '.tasklog/e/tickets/03-x.md'), fm('3'));
    fs.writeFileSync(abs(root, '.tasklog/e/tickets/03-y.md'), fm('3'));
    const d = await env.start();
    const f = (await tool(d, root, 'frontier', { effort: 'e' })).structuredContent;
    expect(f.ready).toEqual([]); // 04 does not exist: nothing ready
    const reasons = f.blocked.find((b: any) => b.id === 'e/01').reasons.map((r: any) => r.state).sort();
    expect(reasons).toEqual(['conflicted', 'invalid', 'missing']);
  });

  it('cross-effort blockers resolve the same way, and type/tags filter', async () => {
    const { t } = await setup();
    await t('create_effort', { effort: 'f', title: 'F' });
    await t('create_item', { effort: 'f', title: 'Base', question: 'q' }); // f/01
    await t('create_item', { effort: 'e', title: 'Dep', question: 'q', blocked_by: ['f/1'], type: 'research', tags: ['x'] }); // e/01
    await t('create_item', { effort: 'e', title: 'Plain', question: 'q' }); // e/02
    let f = (await t('frontier', { effort: 'e' })).structuredContent;
    expect(ids(f.ready)).toEqual(['e/02']);
    expect(f.blocked[0].reasons[0]).toMatchObject({ blocker: 'f/01', state: 'open' });
    await t('resolve', { id: 'f/01', answer: 'ok' });
    f = (await t('frontier', { effort: 'e' })).structuredContent;
    expect(ids(f.ready)).toEqual(['e/01', 'e/02']);
    expect(ids((await t('frontier', { effort: 'e', type: 'research' })).structuredContent.ready)).toEqual(['e/01']);
    expect(ids((await t('frontier', { effort: 'e', tags: ['x'] })).structuredContent.ready)).toEqual(['e/01']);
    expect(errCode(await t('frontier', { effort: 'nope' }))).toBe('not_found');
  });
});

describe('claim and release', () => {
  it('two claimants: one wins, the other gets already_claimed with claimed_by; same claimant is idempotent', async () => {
    const { root, t } = await setup();
    await t('create_item', { effort: 'e', title: 'One', question: 'q' });
    const rs = await Promise.all([t('claim', { id: 'e/01', claimant: 'a' }), t('claim', { id: 'e/01', claimant: 'b' })]);
    expect(rs.filter((r) => !r.isError)).toHaveLength(1);
    const loser = rs.find((r) => r.isError)!;
    expect(errCode(loser)).toBe('already_claimed');
    const winner = rs.find((r) => !r.isError) === rs[0] ? 'a' : 'b';
    expect(loser.structuredContent.error.details.claimed_by).toBe(winner);
    const text = read(root, '.tasklog/e/tickets/01-one.md');
    expect(text).toMatch(/^status: claimed$/m);
    expect(text).toContain(`claimed_by: ${winner}`);
    const again = await t('claim', { id: 'e/01', claimant: winner });
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent.changed).toBe(false);
    expect(read(root, '.tasklog/e/tickets/01-one.md')).toBe(text);
  });

  it('claim fails bad_transition on resolved items; release needs force for another claimant', async () => {
    const { t } = await setup();
    await t('create_item', { effort: 'e', title: 'One', question: 'q' });
    expect(errCode(await t('release', { id: 'e/01', claimant: 'a' }))).toBe('not_claimed');
    await t('claim', { id: 'e/01', claimant: 'a' });
    const r = await t('release', { id: 'e/01', claimant: 'b' });
    expect(errCode(r)).toBe('already_claimed');
    expect(r.structuredContent.error.details.claimed_by).toBe('a');
    expect((await t('release', { id: 'e/01', claimant: 'b', force: true })).isError).toBeFalsy();
    expect((await t('get_item', { id: 'e/01' })).structuredContent.frontmatter.status).toBe('open');
    expect((await t('get_item', { id: 'e/01' })).structuredContent.frontmatter.claimed_by).toBeUndefined();
    await t('resolve', { id: 'e/01', answer: 'x' });
    expect(errCode(await t('claim', { id: 'e/01', claimant: 'a' }))).toBe('bad_transition');
    expect(errCode(await t('claim', { id: 'e/map', claimant: 'a' }))).toBe('bad_request');
  });

  it('a claim older than stale_after is listed stale with its age by frontier and overview; release returns it to open', async () => {
    const { root, t } = await setup();
    await t('create_item', { effort: 'e', title: 'Old', question: 'q' });
    await t('create_item', { effort: 'e', title: 'Fresh', question: 'q' });
    await t('claim', { id: 'e/01', claimant: 'a' });
    await t('claim', { id: 'e/02', claimant: 'b' });
    // age claim 1 by 30 hours on disk
    const rel = '.tasklog/e/tickets/01-old.md';
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    fs.writeFileSync(abs(root, rel), read(root, rel).replace(/^updated: .*$/m, `updated: ${old}`));
    const f = (await t('frontier', { effort: 'e' })).structuredContent;
    // the model has not seen the external edit until a write or rescan; force a catch-up through a stale write
    await t('set_fields', { id: 'e/01', hash: '0'.repeat(64), title: 'Old' });
    const f2 = (await t('frontier', { effort: 'e' })).structuredContent;
    const c1 = f2.claimed.find((c: any) => c.id === 'e/01');
    expect(c1.stale).toBe(true);
    expect(c1.age_seconds).toBeGreaterThan(29 * 3600);
    expect(c1.age).toMatch(/^1d 6h|^30h/);
    expect(f2.claimed.find((c: any) => c.id === 'e/02').stale).toBe(false);
    expect(f.claimed).toHaveLength(2);
    const o = (await t('overview', { effort: 'e' })).structuredContent;
    expect(o.in_progress.find((c: any) => c.id === 'e/01').stale).toBe(true);
    expect(o.markdown).toContain('STALE');
    expect((await t('frontier', { effort: 'e', stale_after: '48h' })).structuredContent.claimed.every((c: any) => !c.stale)).toBe(true);
    await t('release', { id: 'e/01', claimant: 'a' });
    expect((await t('frontier', { effort: 'e' })).structuredContent.ready.map((r: any) => r.id)).toEqual(['e/01']);
  });
});

describe('resolve and close', () => {
  it('resolve writes Answer, status, clears claimed_by and appends the Decisions line once even if retried', async () => {
    const { root, t } = await setup();
    await t('create_item', { effort: 'e', title: 'Pick DB', question: 'Which?' });
    await t('claim', { id: 'e/01', claimant: 'a' });
    const r = await t('resolve', { id: 'e/01', answer: 'Use SQLite.\n\nIt is simple.', gist: 'SQLite' });
    expect(r.structuredContent).toMatchObject({ steps: { ticket: 'ok', map: 'ok' } });
    const text = read(root, '.tasklog/e/tickets/01-pick-db.md');
    expect(text).toMatch(/^status: resolved$/m);
    expect(text).not.toContain('claimed_by');
    expect(text).toMatch(/^updated: \d{4}-\d\d-\d\dT/m);
    expect(text).toContain('## Answer\n\nUse SQLite.\n\nIt is simple.');
    const map = () => read(root, '.tasklog/e/map.md');
    expect(map()).toContain('## Decisions so far\n\n- [Pick DB](tickets/01-pick-db.md): SQLite');
    const r2 = await t('resolve', { id: 'e/01', answer: 'Use SQLite.\n\nIt is simple.', gist: 'SQLite' });
    expect(r2.isError).toBeFalsy();
    expect(r2.structuredContent.steps).toMatchObject({ ticket: 'skipped', map: 'skipped' });
    expect(map().match(/tickets\/01-pick-db\.md/g)).toHaveLength(1);
    expect(errCode(await t('resolve', { id: 'e/01', answer: 'Different' }))).toBe('bad_transition');
    expect(errCode(await t('close', { id: 'e/01', reason: 'no' }))).toBe('bad_transition');
  });

  it('a failed map append returns partial with per-step results, and a retry completes it', async () => {
    const { root, d, t } = await setup();
    await t('create_item', { effort: 'e', title: 'Pick DB', question: 'Which?' });
    d.writes.beforeRename = (w) => {
      if (w.id === 'e/map') throw new Error('disk full');
    };
    const r = await t('resolve', { id: 'e/01', answer: 'SQLite', gist: 'SQLite' });
    expect(errCode(r)).toBe('partial');
    expect(r.structuredContent.error.retryable).toBe(true);
    expect(r.structuredContent.error.details.steps).toMatchObject({ ticket: 'ok', map: 'failed' });
    expect(read(root, '.tasklog/e/tickets/01-pick-db.md')).toMatch(/^status: resolved$/m);
    expect(read(root, '.tasklog/e/map.md')).not.toContain('Pick DB');
    d.writes.beforeRename = undefined;
    const retry = await t('resolve', { id: 'e/01', answer: 'SQLite', gist: 'SQLite' });
    expect(retry.structuredContent.steps).toMatchObject({ ticket: 'skipped', map: 'ok' });
    expect(read(root, '.tasklog/e/map.md').match(/Pick DB/g)).toHaveLength(1);
  });

  it('resolve without a gist does not touch the map; an unresolved item stays unchanged on a bad answer', async () => {
    const { root, t } = await setup();
    await t('create_item', { effort: 'e', title: 'One', question: 'q' });
    const map0 = read(root, '.tasklog/e/map.md');
    expect(errCode(await t('resolve', { id: 'e/01', answer: '  ' }))).toBe('bad_request');
    expect(errCode(await t('resolve', { id: 'e/01', answer: 'x\n## Oops\ny' }))).toBe('bad_request');
    expect(read(root, '.tasklog/e/tickets/01-one.md')).toMatch(/^status: open$/m);
    const r = await t('resolve', { id: 'e/01', answer: 'done' });
    expect(r.structuredContent.steps).toMatchObject({ ticket: 'ok', map: 'skipped' });
    expect(read(root, '.tasklog/e/map.md')).toBe(map0);
  });

  it('close writes the reason to Answer, sets closed and appends to Out of scope', async () => {
    const { root, t } = await setup();
    await t('create_item', { effort: 'e', title: 'Gold plating', question: 'q' });
    await t('claim', { id: 'e/01', claimant: 'a' });
    const r = await t('close', { id: 'e/01', reason: 'Not worth it.', out_of_scope_gist: 'no gold plating' });
    expect(r.structuredContent.steps).toMatchObject({ ticket: 'ok', map: 'ok' });
    const text = read(root, '.tasklog/e/tickets/01-gold-plating.md');
    expect(text).toMatch(/^status: closed$/m);
    expect(text).not.toContain('claimed_by');
    expect(text).toContain('## Answer\n\nNot worth it.');
    expect(read(root, '.tasklog/e/map.md')).toMatch(/## Out of scope\n\n- \[Gold plating\]\(tickets\/01-gold-plating\.md\): no gold plating/);
    const again = await t('close', { id: 'e/01', reason: 'Not worth it.', out_of_scope_gist: 'no gold plating' });
    expect(again.structuredContent.steps).toMatchObject({ ticket: 'skipped', map: 'skipped' });
  });

  it('an effort without a map skips the map step; add_decision and add_out_of_scope are idempotent on the link', async () => {
    const { root, t } = await setup();
    const a = await t('add_decision', { effort: 'e', title_link: '[Spec](spec.md)', gist: 'agreed' });
    expect(a.structuredContent.changed).toBe(true);
    expect((await t('add_decision', { effort: 'e', title_link: '[Spec again](spec.md)', gist: 'agreed' })).structuredContent.changed).toBe(false);
    await t('add_out_of_scope', { effort: 'e', title_link: '[Mobile](tickets/09-mobile.md)', gist: 'later' });
    const map = read(root, '.tasklog/e/map.md');
    expect(map).toContain('- [Spec](spec.md): agreed');
    expect(map).toContain('## Out of scope\n\n- [Mobile](tickets/09-mobile.md): later');
    expect(errCode(await t('add_decision', { effort: 'zzz', title_link: '[x](y.md)', gist: 'g' }))).toBe('not_found');
  });
});

describe('overview', () => {
  it('flags drift and summarises; with no effort returns one line per effort', async () => {
    const { root, t } = await setup();
    await t('create_effort', { effort: 'g', title: 'G', destination: 'Other place. More text.' });
    await t('create_item', { effort: 'e', title: 'Alpha', question: 'q' }); // 01
    await t('create_item', { effort: 'e', title: 'Beta', question: 'q', blocked_by: [1] }); // 02
    await t('create_item', { effort: 'e', title: 'Gamma', question: 'q' }); // 03
    await t('create_item', { effort: 'e', title: 'Delta', question: 'q' }); // 04
    await t('resolve', { id: 'e/01', answer: 'a', gist: 'alpha decided' });
    await t('resolve', { id: 'e/03', answer: 'c' }); // resolved, no Decisions line
    await t('add_decision', { effort: 'e', title_link: '[Beta](tickets/02-beta.md)', gist: 'premature' }); // 02 is open
    await t('close', { id: 'e/04', reason: 'nah', out_of_scope_gist: 'delta out' });
    await t('replace_section', { id: 'e/map', hash: (await t('get_item', { id: 'e/map' })).structuredContent.hash, heading: 'Not yet specified', content: 'Fog here.' });

    const o = (await t('overview', { effort: 'e' })).structuredContent;
    expect(o.counts).toEqual({ open: 1, claimed: 0, resolved: 2, closed: 1 });
    expect(o.destination).toBe('Ship the thing. Then relax.');
    expect(o.done).toEqual([
      { id: 'e/01', title: 'Alpha', gist: 'alpha decided' },
      { id: 'e/03', title: 'Gamma', gist: null },
    ]);
    expect(ids(o.ready)).toEqual(['e/02']);
    expect(o.still_to_do).toBe('Fog here.');
    expect(ids(o.ruled_out.closed)).toEqual(['e/04']);
    expect(o.ruled_out.out_of_scope).toContain('delta out');
    expect(o.drift.map((d: any) => `${d.type}:${d.id}`).sort()).toEqual(['decision_for_unresolved:e/02', 'resolved_without_decision:e/03']);
    expect(o.markdown).toContain('## Drift');

    const jsonOnly = (await t('overview', { effort: 'e', format: 'json' })).structuredContent;
    expect(jsonOnly.markdown).toBeUndefined();
    const mdOnly = (await t('overview', { effort: 'e', format: 'markdown' })).structuredContent;
    expect(Object.keys(mdOnly)).toEqual(['markdown']);

    const all = (await t('overview')).structuredContent;
    expect(all.efforts.map((e: any) => e.effort)).toEqual(['e', 'g']);
    expect(all.efforts[1].destination).toBe('Other place.');
    expect(all.efforts[0].counts.resolved).toBe(2);
    expect(read(root, '.tasklog/e/map.md')).toContain('Fog here.');
  });
});

describe('triage', () => {
  it('keeps exactly one state tag and one category tag; wontfix also closes', async () => {
    const { root, t } = await setup();
    await t('create_item', { effort: 'e', title: 'Bug', question: 'q', tags: ['keepme', 'needs-triage'] });
    const tags = async () => (await t('get_item', { id: 'e/01' })).structuredContent.frontmatter.tags;
    await t('triage', { id: 'e/01', state: 'needs-info', category: 'bug' });
    expect(await tags()).toEqual(['keepme', 'needs-info', 'bug']);
    await t('triage', { id: 'e/01', state: 'ready-for-agent', category: 'enhancement', note: 'Looks fine.' });
    expect(await tags()).toEqual(['keepme', 'ready-for-agent', 'enhancement']);
    expect(read(root, '.tasklog/e/tickets/01-bug.md')).toContain('## Comments\n\nLooks fine.');
    await t('triage', { id: 'e/01', state: 'needs-triage' }); // category untouched
    expect(await tags()).toEqual(['keepme', 'enhancement', 'needs-triage']);
    const w = await t('triage', { id: 'e/01', state: 'wontfix', note: 'Out of scope for now.' });
    expect(w.isError).toBeFalsy();
    expect(await tags()).toEqual(['keepme', 'enhancement', 'wontfix']);
    const text = read(root, '.tasklog/e/tickets/01-bug.md');
    expect(text).toMatch(/^status: closed$/m);
    expect(text).toContain('## Answer\n\nOut of scope for now.');
    expect((await t('triage', { id: 'e/01', state: 'bogus' })).isError).toBe(true);
  });
});

describe('set_fields guard', () => {
  it('still cannot set claimed, resolved or closed (or claimed_by)', async () => {
    const { root, t } = await setup();
    await t('create_item', { effort: 'e', title: 'One', question: 'q' });
    const before = read(root, '.tasklog/e/tickets/01-one.md');
    const hash = (await t('get_item', { id: 'e/01' })).structuredContent.hash;
    for (const status of ['claimed', 'resolved', 'closed']) {
      expect(errCode(await t('set_fields', { id: 'e/01', hash, status }))).toBe('bad_request');
    }
    const r = await t('set_fields', { id: 'e/01', hash, claimed_by: 'me' });
    expect(r.isError).toBe(true);
    expect(read(root, '.tasklog/e/tickets/01-one.md')).toBe(before);
  });
});
