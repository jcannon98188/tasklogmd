import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, parseItem } from '../../src/model/parse.ts';
import { WorkspaceIndex } from '../../src/model/index.ts';
import { ParsedItemStore } from '../../src/model/store.ts';
import { sweepTempFiles, TEMP_SUFFIX } from '../../src/daemon/writes.ts';
import { canonicalize } from '../../src/workspaces.ts';
import { copyFixture, makeEnv, sleep, type TestEnv } from '../helpers.ts';

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
const file = (root: string, rel: string) => path.join(root, ...rel.split('/'));
const read = (root: string, rel: string) => fs.readFileSync(file(root, rel));
const tmpFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.endsWith(TEMP_SUFFIX)) out.push(path.join(dir, e.name));
    }
  };
  walk(path.join(root, '.tasklog'));
  return out;
};

const DELTA = '.tasklog/delta/tickets/01-unknown-key.md';
const ALPHA3 = '.tasklog/alpha/tickets/03-blocked-prototype.md';
const hashOf = async (d: any, root: string, id: string) => (await tool(d, root, 'get_item', { id })).structuredContent.hash as string;

/** Byte-exact line diff: the lines removed from and added to `a` to make `b` (LF or CRLF, equal elsewhere). */
function lineDiff(a: Buffer, b: Buffer): { removed: string[]; added: string[] } {
  const x = a.toString('utf8').split('\n');
  const y = b.toString('utf8').split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  return { removed: x.slice(s, x.length - e), added: y.slice(s, y.length - e) };
}

describe('one-field edits through the daemon', () => {
  it('changes exactly one line and keeps CRLF, quoting, comments and unknown keys and sections', async () => {
    const root = copyFixture('unknown-key', env.root);
    // Drop the hand-added AC: renumbering it is a second change, covered by its own test below.
    fs.writeFileSync(file(root, DELTA), read(root, DELTA).toString('utf8').replace('- [ ] Hand-added without number\n', ''));
    const d = await env.start();
    const before = read(root, DELTA);
    const hash = await hashOf(d, root, 'delta/01');
    expect(hash).toBe(contentHash(before));

    const r = await tool(d, root, 'set_fields', { id: 'delta/01', hash, title: 'Fresh title' });
    expect(r.isError).toBeUndefined();
    const after = read(root, DELTA);
    expect(r.structuredContent).toMatchObject({ id: 'delta/01', hash: contentHash(after), changed: true });
    expect(lineDiff(before, after)).toEqual({ removed: ['title: "Quoted: title"'], added: ['title: "Fresh title"'] });
    expect(after.toString('utf8')).toBe(before.toString('utf8').replace('title: "Quoted: title"', 'title: "Fresh title"'));
  });

  it('keeps CRLF and a BOM byte-exact', async () => {
    const root = copyFixture('eol-bom', env.root);
    const d = await env.start();
    for (const [id, rel] of [
      ['eol/01', '.tasklog/eol/tickets/01-crlf.md'],
      ['eol/03', '.tasklog/eol/tickets/03-bom.md'],
      ['eol/04', '.tasklog/eol/tickets/04-bom-crlf.md'],
    ] as const) {
      const before = read(root, rel);
      const r = await tool(d, root, 'add_ac', { id, hash: await hashOf(d, root, id), text: 'Added line' });
      expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
      const after = read(root, rel);
      const bom = before.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(bom);
      const crlf = before.includes('\r\n');
      const d1 = lineDiff(before, after);
      expect(d1.removed).toEqual([]);
      expect(d1.added.join('')).toContain('Added line');
      // File 04 has no AC section yet: the new section is 4 lines (blank, heading, blank, AC).
      expect(d1.added).toHaveLength(id === 'eol/04' ? 4 : 1);
      expect(after.toString('utf8').includes('\r\n')).toBe(crlf);
      if (crlf) expect(after.toString('utf8').replace(/\r\n/g, '').includes('\n')).toBe(false);
    }
  });

  it('every write returns the new hash and registers the parse result in the store and index', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const idx = await d.models.ready(canonicalize(root));
    const h0 = await hashOf(d, root, 'alpha/03');
    const r = await tool(d, root, 'toggle_ac', { id: 'alpha/03', hash: h0, n: 2 });
    const h1 = r.structuredContent.hash;
    expect(h1).not.toBe(h0);
    expect(h1).toBe(contentHash(read(root, ALPHA3)));
    expect(d.models.store.has(h1)).toBe(true);
    expect(d.models.store.has(h0)).toBe(false); // the old parse result was released when nothing else held it
    expect(idx.entryByPath(ALPHA3)?.hash).toBe(h1);
    expect(r.structuredContent.n).toBe(2);
    const listed = (await tool(d, root, 'list_items', { effort: 'alpha' })).structuredContent.items.find((i: any) => i.id === 'alpha/03');
    expect(listed.hash).toBe(h1);
    const got = (await tool(d, root, 'get_item', { id: 'alpha/03' })).structuredContent;
    expect(got.acs[1]).toMatchObject({ n: 2, checked: true });
    expect(d.writes.isSelfWrite(canonicalize(root), ALPHA3, h1)).toBe(true);
  });

  it('a no-op edit returns the same hash and does not touch the file', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const h0 = await hashOf(d, root, 'alpha/03');
    const mtime = fs.statSync(file(root, ALPHA3)).mtimeMs;
    await sleep(20);
    const r = await tool(d, root, 'toggle_ac', { id: 'alpha/03', hash: h0, n: 1, checked: false });
    expect(r.structuredContent).toMatchObject({ hash: h0, changed: false });
    expect(fs.statSync(file(root, ALPHA3)).mtimeMs).toBe(mtime);
  });
});

describe('hash protocol', () => {
  it('a stale hash fails stale_hash and leaves the file unchanged', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const h0 = await hashOf(d, root, 'alpha/03');
    expect((await tool(d, root, 'toggle_ac', { id: 'alpha/03', hash: h0, n: 1 })).isError).toBeUndefined();
    const snapshot = read(root, ALPHA3);
    for (const [name, args] of [
      ['set_fields', { title: 'Nope' }],
      ['replace_section', { heading: 'Question', content: 'Nope' }],
      ['append_to_section', { heading: 'Comments', content: 'Nope' }],
      ['add_ac', { text: 'Nope' }],
      ['edit_ac', { n: 1, text: 'Nope' }],
      ['toggle_ac', { n: 2 }],
      ['remove_ac', { n: 1 }],
    ] as const) {
      const r = await tool(d, root, name, { id: 'alpha/03', hash: h0, ...args });
      expect(errCode(r), name).toBe('stale_hash');
      expect(r.structuredContent.error.retryable).toBe(true);
      expect(read(root, ALPHA3).equals(snapshot), name).toBe(true);
    }
    expect(tmpFiles(root)).toEqual([]);
  });

  it('a malformed hash is bad_request', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    expect(errCode(await tool(d, root, 'set_fields', { id: 'alpha/03', hash: 'abc', title: 'x' }))).toBe('bad_request');
  });

  it('an external edit between a client read and write is detected as stale, and the model catches up', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const h0 = await hashOf(d, root, 'alpha/03');
    const external = read(root, ALPHA3).toString('utf8').replace('Blocked prototype', 'Edited by hand');
    fs.writeFileSync(file(root, ALPHA3), external);
    const r = await tool(d, root, 'set_fields', { id: 'alpha/03', hash: h0, title: 'Agent edit' });
    expect(errCode(r)).toBe('stale_hash');
    expect(read(root, ALPHA3).toString('utf8')).toBe(external);
    const fresh = (await tool(d, root, 'get_item', { id: 'alpha/03' })).structuredContent;
    expect(fresh.frontmatter.title).toBe('Edited by hand');
    expect((await tool(d, root, 'set_fields', { id: 'alpha/03', hash: fresh.hash, title: 'Agent edit' })).isError).toBeUndefined();
  });

  it('an external edit during the pause before the rename is detected', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const h0 = await hashOf(d, root, 'alpha/03');
    const external = read(root, ALPHA3).toString('utf8') + '\nexternal tail\n';
    d.writes.beforeRename = () => {
      fs.writeFileSync(file(root, ALPHA3), external);
    };
    const r = await tool(d, root, 'set_fields', { id: 'alpha/03', hash: h0, title: 'Agent edit' });
    expect(errCode(r)).toBe('stale_hash');
    expect(read(root, ALPHA3).toString('utf8')).toBe(external);
    expect(tmpFiles(root)).toEqual([]);
  });
});

describe('concurrency', () => {
  it('two writers racing one file: exactly one succeeds, the other gets stale_hash', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const h0 = await hashOf(d, root, 'alpha/03');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let paused = 0;
    d.writes.beforeRename = async () => {
      paused++;
      await gate;
    };
    const a = tool(d, root, 'set_fields', { id: 'alpha/03', hash: h0, title: 'Writer A' });
    const b = tool(d, root, 'set_fields', { id: 'alpha/03', hash: h0, title: 'Writer B' });
    // Writer A is held between hash verification and rename; B must queue behind it, not overtake.
    for (let i = 0; i < 100 && paused === 0; i++) await sleep(10);
    await sleep(100);
    expect(paused).toBe(1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    const results = [ra, rb];
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.filter((r) => errCode(r) === 'stale_hash')).toHaveLength(1);
    const winner = ra.isError ? 'Writer B' : 'Writer A';
    expect(read(root, ALPHA3).toString('utf8')).toContain(`title: ${winner}\n`);
    expect(tmpFiles(root)).toEqual([]);
  });

  it('interleaved edits to different ACs of one ticket both apply, in order, through the per-file queue', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const order: string[] = [];
    d.writes.beforeRename = async (w) => {
      order.push(w.op);
      await sleep(30); // widen the window so the clients genuinely interleave
    };
    const client = async (n: number) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const h = await hashOf(d, root, 'alpha/03');
        const r = await tool(d, root, 'toggle_ac', { id: 'alpha/03', hash: h, n });
        if (!r.isError) return r.structuredContent.hash as string;
        expect(errCode(r)).toBe('stale_hash');
      }
      throw new Error('never applied');
    };
    await Promise.all([client(1), client(2), client(3)]);
    const p = parseItem(read(root, ALPHA3));
    expect(p.ok && p.acs.map((a) => a.checked)).toEqual([true, true, true]);
    expect(order).toEqual(['toggle_ac', 'toggle_ac', 'toggle_ac']);
    expect(tmpFiles(root)).toEqual([]);
  });

  it('different files are written independently', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    d.writes.beforeRename = async (w) => {
      calls++;
      if (w.id === 'alpha/03') await gate;
    };
    const slow = tool(d, root, 'set_fields', { id: 'alpha/03', hash: await hashOf(d, root, 'alpha/03'), title: 'Slow' });
    for (let i = 0; i < 100 && calls === 0; i++) await sleep(10);
    const fast = await tool(d, root, 'set_fields', { id: 'alpha/02', hash: await hashOf(d, root, 'alpha/02'), title: 'Fast' });
    expect(fast.isError).toBeUndefined();
    release();
    expect((await slow).isError).toBeUndefined();
  });
});

describe('failures and recovery', () => {
  it('a failure mid-write leaves the original whole and no temp file behind', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const before = read(root, ALPHA3);
    const h0 = await hashOf(d, root, 'alpha/03');
    let sawTemp = false;
    d.writes.beforeRename = () => {
      sawTemp = tmpFiles(root).length === 1; // the temp file exists at the moment of failure
      throw new Error('disk exploded');
    };
    const r = await tool(d, root, 'set_fields', { id: 'alpha/03', hash: h0, title: 'Never written' });
    expect(errCode(r)).toBe('internal');
    expect(sawTemp).toBe(true);
    expect(read(root, ALPHA3).equals(before)).toBe(true);
    expect(tmpFiles(root)).toEqual([]);
    // The model is untouched and the item is writable again.
    d.writes.beforeRename = undefined;
    expect((await tool(d, root, 'set_fields', { id: 'alpha/03', hash: h0, title: 'Now written' })).isError).toBeUndefined();
  });

  it('a failing rename leaves the original whole and removes the temp file', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const before = read(root, ALPHA3);
    const h0 = await hashOf(d, root, 'alpha/03');
    // Make the rename target a directory so the rename cannot succeed, without disturbing the source read.
    d.writes.beforeRename = () => {
      fs.rmSync(file(root, ALPHA3));
      fs.mkdirSync(file(root, ALPHA3));
    };
    const r = await tool(d, root, 'set_fields', { id: 'alpha/03', hash: h0, title: 'x' });
    expect(r.isError).toBe(true);
    expect(tmpFiles(root)).toEqual([]);
    fs.rmdirSync(file(root, ALPHA3));
    fs.writeFileSync(file(root, ALPHA3), before);
  });

  it('leftover temp files are swept at daemon start', async () => {
    const root = copyFixture('normal', env.root);
    const stray = [
      file(root, '.tasklog/alpha/tickets/.03-blocked-prototype.md.deadbeef' + TEMP_SUFFIX),
      file(root, '.tasklog/alpha/.map.md.cafe' + TEMP_SUFFIX),
    ];
    for (const s of stray) fs.writeFileSync(s, 'half written');
    expect(tmpFiles(root)).toHaveLength(2);
    const reg = path.join(env.root, 'data');
    fs.mkdirSync(reg, { recursive: true });
    fs.writeFileSync(path.join(reg, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: [root] }));
    const d = await env.start();
    await d.models.ready(canonicalize(root));
    expect(tmpFiles(root)).toEqual([]);
    // And they never appeared as items.
    expect((await tool(d, root, 'list_items', { limit: 200 })).structuredContent.total).toBe(12);
  });

  it('sweepTempFiles only removes temp files', () => {
    const root = copyFixture('normal', env.root);
    fs.writeFileSync(file(root, '.tasklog/alpha/x' + TEMP_SUFFIX), 'x');
    expect(sweepTempFiles(root)).toBe(1);
    expect(fs.existsSync(file(root, ALPHA3))).toBe(true);
    expect(sweepTempFiles(root)).toBe(0);
  });
});

describe('what cannot be written', () => {
  it('refuses writes to invalid items and conflicted IDs, leaving the files unchanged', async () => {
    const invalid = copyFixture('invalid', env.root);
    const dup = copyFixture('duplicate-ids', env.root);
    const d = await env.start();
    const bad = read(invalid, '.tasklog/gamma/tickets/02-no-closing.md');
    const listed = (await tool(d, invalid, 'list_items', { effort: 'gamma' })).structuredContent.items.find((i: any) => i.id === 'gamma/02');
    const r = await tool(d, invalid, 'set_fields', { id: 'gamma/02', hash: listed.hash, title: 'x' });
    expect(errCode(r)).toBe('invalid_item');
    expect(read(invalid, '.tasklog/gamma/tickets/02-no-closing.md').equals(bad)).toBe(true);

    const files = ['03-first-copy.md', '03-second-copy.md'].map((f) => read(dup, `.tasklog/dup/tickets/${f}`));
    const hash = contentHash(files[0]!);
    const c = await tool(d, dup, 'add_ac', { id: 'dup/03', hash, text: 'x' });
    expect(errCode(c)).toBe('conflicted');
    expect(c.structuredContent.error.details.paths).toHaveLength(2);
    ['03-first-copy.md', '03-second-copy.md'].forEach((f, i) => expect(read(dup, `.tasklog/dup/tickets/${f}`).equals(files[i]!)).toBe(true));
    expect(errCode(await tool(d, dup, 'toggle_ac', { id: 'dup/99', hash, n: 1 }))).toBe('not_found');
  });

  it('a hand-added AC without a number gets the next free number on the next write', async () => {
    const root = copyFixture('unknown-key', env.root);
    const d = await env.start();
    const before = read(root, DELTA);
    const r = await tool(d, root, 'set_fields', { id: 'delta/01', hash: await hashOf(d, root, 'delta/01'), tags: ['one'] });
    expect(r.isError).toBeUndefined();
    expect(read(root, DELTA).toString('utf8')).toBe(
      before.toString('utf8').replace('tags: [one, two]', 'tags: [one]').replace('- [ ] Hand-added without number', '- [ ] #2 Hand-added without number'),
    );
    const got = (await tool(d, root, 'get_item', { id: 'delta/01' })).structuredContent;
    expect(got.acs.map((a: any) => a.n)).toEqual([1, 2]);
  });

  it('set_fields cannot set status except reopen; tags are normalised', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const h = await hashOf(d, root, 'alpha/02'); // claimed by agent-1
    const refused = await tool(d, root, 'set_fields', { id: 'alpha/02', hash: h, status: 'resolved' });
    expect(errCode(refused)).toBe('bad_request');
    expect(refused.structuredContent.error.message).toMatch(/reopen/);
    const t = await tool(d, root, 'set_fields', { id: 'alpha/02', hash: h, tags: ['Needs Triage', 'BACKEND'] });
    expect((await tool(d, root, 'get_item', { id: 'alpha/02' })).structuredContent.frontmatter.tags).toEqual(['needs-triage', 'backend']);
    const re = await tool(d, root, 'set_fields', { id: 'alpha/02', hash: t.structuredContent.hash, reopen: true });
    expect(re.isError, JSON.stringify(re.structuredContent)).toBeUndefined();
    const fm = (await tool(d, root, 'get_item', { id: 'alpha/02' })).structuredContent.frontmatter;
    expect(fm.status).toBe('open');
    expect('claimed_by' in fm).toBe(false);
    expect(errCode(await tool(d, root, 'set_fields', { id: 'alpha/02', hash: re.structuredContent.hash, reopen: true }))).toBe('bad_transition');
  });

  it('section tools patch only their section', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const rel = '.tasklog/beta/tickets/02-with-comments.md';
    const before = read(root, rel).toString('utf8');
    const h = await hashOf(d, root, 'beta/02');
    const r = await tool(d, root, 'append_to_section', { id: 'beta/02', hash: h, heading: 'Comments', content: '- appended' });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
    const after = read(root, rel).toString('utf8');
    expect(after.startsWith(before.replace(/\n+$/, ''))).toBe(true);
    expect(after).toContain('\n- appended');
    const r2 = await tool(d, root, 'replace_section', { id: 'beta/02', hash: r.structuredContent.hash, heading: 'Answer', content: 'Resolved text.' });
    expect(r2.isError).toBeUndefined();
    expect(read(root, rel).toString('utf8')).toContain('## Answer\n\nResolved text.');
    expect(errCode(await tool(d, root, 'replace_section', { id: 'beta/02', hash: r2.structuredContent.hash, heading: 'X', content: '## Y' }))).toBe('bad_request');
  });
});

// ---- seeded randomized run -----------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('seeded randomized run', () => {
  for (const seed of [1, 7, 2026]) {
    it(`N parallel clients applying random operations leave files that parse and equal a rescan (seed ${seed})`, async () => {
      const root = copyFixture('normal', env.root);
      const d = await env.start();
      const idx = await d.models.ready(canonicalize(root));
      const ids = ['alpha/02', 'alpha/03', 'alpha/04', 'beta/02'];
      const CLIENTS = 6;
      const STEPS = 25;
      const outcomes = new Map<string, number>();
      const bump = (k: string) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1);

      const client = async (c: number) => {
        const rnd = mulberry32(seed * 1000 + c);
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
        for (let step = 0; step < STEPS; step++) {
          const id = pick(ids);
          const got = (await tool(d, root, 'get_item', { id })).structuredContent;
          const n = 1 + Math.floor(rnd() * 5);
          const word = `w${Math.floor(rnd() * 1000)}`;
          const ops: Array<[string, object]> = [
            ['set_fields', { title: `Title ${word}` }],
            ['set_fields', { tags: [`Tag ${word}`, 'x'] }],
            ['set_fields', { blocked_by: [1, 'beta/01'] }],
            ['set_fields', { type: pick(['task', 'research', null] as const) }],
            ['replace_section', { heading: 'Comments', content: `Note ${word}\n\n- a\n- b` }],
            ['append_to_section', { heading: pick(['Comments', 'Answer']), content: `\nLine ${word}` }],
            ['add_ac', { text: `AC ${word}` }],
            ['edit_ac', { n, text: `Edited ${word}` }],
            ['toggle_ac', { n }],
            ['remove_ac', { n }],
          ];
          const [name, args] = pick(ops);
          // Occasionally send a deliberately stale hash.
          const hash = rnd() < 0.1 ? '0'.repeat(64) : got.hash;
          const r = await tool(d, root, name, { id, hash, ...args });
          bump(r.isError ? errCode(r)! : 'ok');
          if (rnd() < 0.2) await sleep(Math.floor(rnd() * 5));
        }
      };
      await Promise.all(Array.from({ length: CLIENTS }, (_, c) => client(c)));

      // Only expected failures; plenty of successes and plenty of contention.
      const allowed = new Set(['ok', 'stale_hash', 'not_found', 'bad_request', 'bad_transition']);
      for (const k of outcomes.keys()) expect(allowed.has(k), `unexpected outcome ${k}`).toBe(true);
      expect(outcomes.get('ok') ?? 0).toBeGreaterThan(20);
      expect(outcomes.get('stale_hash') ?? 0).toBeGreaterThan(0);

      // The files on disk always parse, no temp file is left, and a fresh scan equals the live model.
      expect(tmpFiles(root)).toEqual([]);
      const fresh = new WorkspaceIndex(root, new ParsedItemStore(), { log: env.log });
      await fresh.scan('oracle');
      const live = idx.entries().map((e) => [e.path, e.hash]);
      expect(fresh.entries().map((e) => [e.path, e.hash])).toEqual(live);
      for (const e of idx.entries()) {
        expect(parseItem(read(root, e.path)).ok, e.path).toBe(true);
        expect(e.hash).toBe(contentHash(read(root, e.path)));
      }
      fresh.dispose();
      expect(idx.counts().invalid).toBe(0);
    }, 60_000);
  }
});
