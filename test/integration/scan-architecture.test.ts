// Slice 5 of the architecture build: `scan_architecture` through the daemon tool API on temp workspaces.
// Goldens: the `--dry-run` result of each shared fixture (test/fixtures/architecture/<name>/scan-result.golden.json),
// compared whole; update only with `UPDATE_GOLDEN=1` and review the diff. Real repos are cited in the fixtures only.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../../src/daemon/core.ts';
import { FIXTURE_NAMES, fixtureDir, loadFixture, type FixtureName } from '../architecture-fixtures.ts';
import { makeEnv, mkWorkspace, type TestEnv } from '../helpers.ts';

let env: TestEnv;
let d: RunningDaemon;
beforeEach(async () => {
  env = makeEnv();
  d = await env.start();
});
afterEach(async () => {
  await env.cleanup();
});

interface ToolResult {
  isError?: boolean;
  structuredContent: any;
}

async function tool(root: string, name: string, args: object = {}): Promise<ToolResult> {
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

const scan = async (root: string, dry_run = false): Promise<any> => {
  const r = await tool(root, 'scan_architecture', { dry_run });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
  return r.structuredContent;
};

function put(root: string, rel: string, text: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const archDir = (root: string) => path.join(root, '.tasklog', 'architecture');
const elementFiles = (root: string) => (fs.existsSync(archDir(root)) ? fs.readdirSync(archDir(root)).filter((n) => n.endsWith('.md')).sort() : []);
const el = (root: string, slug: string) => read(root, `.tasklog/architecture/${slug}.md`);
const hashOf = async (root: string, id: string): Promise<string> => (await tool(root, 'get_item', { id, meta_only: true })).structuredContent.hash;

/** A small repo: container `app` (package.json) with components `a` and `b`. */
function appWorkspace(crlf = false): string {
  const root = mkWorkspace(env.root);
  const nl = crlf ? '\r\n' : '\n';
  put(root, 'package.json', `{${nl}  "name": "app"${nl}}${nl}`);
  put(root, 'src/a/x.ts', 'export const x = 1;\n');
  put(root, 'src/b/y.ts', 'export const y = 1;\n');
  return root;
}

describe('scan goldens (shared fixtures)', () => {
  for (const name of FIXTURE_NAMES) {
    it(`dry-run of ${name} matches scan-result.golden.json and writes nothing`, async () => {
      const root = mkWorkspace(env.root);
      const raw = JSON.parse(fs.readFileSync(`${fixtureDir(name as FixtureName)}tree.json`, 'utf8')) as { files: Record<string, string>; _unfiltered?: string[] };
      for (const [rel, text] of Object.entries(loadFixture(name as FixtureName).tree)) put(root, rel, text);
      for (const rel of raw._unfiltered ?? []) if (!rel.startsWith('.tasklog/')) put(root, rel, '');
      const result = await scan(root, true);
      expect(elementFiles(root)).toEqual([]);
      const file = `${fixtureDir(name as FixtureName)}scan-result.golden.json`;
      if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      expect(fs.existsSync(file), `missing ${file}; run with UPDATE_GOLDEN=1`).toBe(true);
      expect(result).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
    });
  }
});

describe('scan_architecture outcomes', () => {
  it('creates proposed elements with empty Description and Responsibilities, then a rescan changes nothing', async () => {
    const root = appWorkspace();
    const first = await scan(root);
    expect(first.dry_run).toBe(false);
    expect(first.created.map((c: any) => [c.id, c.kind, c.parent, c.code])).toEqual([
      ['architecture/app', 'container', undefined, ['.']],
      ['architecture/a', 'component', 'app', ['src/a']],
      ['architecture/b', 'component', 'app', ['src/b']],
    ]);
    expect(first.updated).toEqual([]);
    expect(el(root, 'a')).toMatch(/^---\nkind: component\ntitle: a\nreview: proposed\nparent: app\ncode: \[src\/a\]\ncreated: \d{4}-\d\d-\d\d\nupdated: \d{4}-\d\d-\d\d\n---\n\n## Description\n\n## Responsibilities\n$/);

    const before = Object.fromEntries(elementFiles(root).map((n) => [n, read(root, `.tasklog/architecture/${n}`)]));
    const second = await scan(root);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toBe(3);
    expect(Object.fromEntries(elementFiles(root).map((n) => [n, read(root, `.tasklog/architecture/${n}`)]))).toEqual(before);

    const status = (await tool(root, 'workspace_status')).structuredContent;
    expect(status.architecture).toMatchObject({ containers: 1, components: 2, proposed: 3, accepted: 0 });
  });

  it('dry_run reports the same plan as the real scan and writes nothing', async () => {
    const root = appWorkspace();
    const dry = await scan(root, true);
    expect(elementFiles(root)).toEqual([]);
    const real = await scan(root);
    expect({ ...real, dry_run: true }).toEqual(dry);
  });

  it('rewrites only owned code: curated review, description, uses and extra sections survive; hand-added roots stay', async () => {
    const root = appWorkspace();
    await scan(root);
    // Curate: accept, describe, add an Interface section, and narrow a's code to one file plus a hand-added root.
    let h = await hashOf(root, 'architecture/a');
    h = (await tool(root, 'set_fields', { id: 'architecture/a', hash: h, review: 'accepted', code: ['src/a/x.ts', 'scripts/extra'] })).structuredContent.hash;
    h = (await tool(root, 'replace_section', { id: 'architecture/a', hash: h, heading: 'Description', content: 'Hand written.' })).structuredContent.hash;
    await tool(root, 'append_to_section', { id: 'architecture/a', heading: 'Interface', content: 'Call x().' });
    put(root, 'src/a/z.ts', 'export const z = 1;\n');

    const r = await scan(root);
    expect(r.updated).toEqual([{ id: 'architecture/a', added: ['src/a'], removed: ['src/a/x.ts'] }]);
    const text = el(root, 'a');
    expect(text).toContain('review: accepted');
    expect(text).toContain('Hand written.');
    expect(text).toContain('## Interface\n\nCall x().');
    expect(text).toMatch(/code: \[src\/a, scripts\/extra\]/);
    expect(r.findings).toContainEqual({ category: 'missing-path', id: 'a', path: 'scripts/extra', detail: expect.any(String) });
    // Second scan: nothing more to do.
    const again = await scan(root);
    expect(again.updated).toEqual([]);
    expect(again.created).toEqual([]);
  });

  it('never deletes: a vanished directory leaves its element and reports missing-path, with a possible-rename hint', async () => {
    const root = appWorkspace();
    await scan(root);
    fs.renameSync(path.join(root, 'src', 'b'), path.join(root, 'src', 'renamed-b'));
    put(root, 'src/c/b/q.ts', '');
    fs.rmSync(path.join(root, 'src', 'c'), { recursive: true });
    const r = await scan(root);
    expect(elementFiles(root)).toContain('b.md');
    expect(r.created.map((c: any) => c.id)).toEqual(['architecture/renamed-b']);
    expect(r.findings.map((f: any) => [f.category, f.id, f.path])).toContainEqual(['missing-path', 'b', 'src/b']);
  });

  it('re-proposes a hand-deleted element, unless the ignore file lists it', async () => {
    const root = appWorkspace();
    await scan(root);
    fs.unlinkSync(path.join(archDir(root), 'b.md'));
    const again = await scan(root);
    expect(again.created.map((c: any) => c.id)).toEqual(['architecture/b']);

    fs.unlinkSync(path.join(archDir(root), 'b.md'));
    put(root, '.tasklog/architecture/ignore', '# hand-deleted noise\nsrc/b\n');
    const ignored = await scan(root);
    expect(ignored.created).toEqual([]);
    expect(ignored.ignored.user).toEqual({ count: 1, paths: ['src/b'] });
    expect(elementFiles(root)).not.toContain('b.md');
    expect(read(root, '.tasklog/architecture/ignore')).toBe('# hand-deleted noise\nsrc/b\n'); // never written by the scan
  });

  it('hand-deleting two components re-proposes only them, never the container, on every later scan', async () => {
    const root = appWorkspace();
    await scan(root);
    fs.unlinkSync(path.join(archDir(root), 'a.md'));
    fs.unlinkSync(path.join(archDir(root), 'b.md'));
    const first = await scan(root);
    expect(first.created.map((c: any) => c.id)).toEqual(['architecture/a', 'architecture/b']);
    const second = await scan(root);
    expect(second.created).toEqual([]);
    const third = await scan(root);
    expect(third.created).toEqual([]);
    expect(elementFiles(root)).toEqual(['a.md', 'app.md', 'b.md']);
  });

  it('a new candidate whose slug collides with an unrelated element gets a numeric suffix', async () => {
    const root = appWorkspace();
    put(root, '.tasklog/architecture/a.md', '---\nkind: component\ntitle: Elsewhere\nreview: accepted\ncode:\n  - lib/other\n---\n\n## Description\n\n## Responsibilities\n');
    const r = await scan(root);
    expect(r.created.map((c: any) => c.id)).toEqual(['architecture/app', 'architecture/a-2', 'architecture/b']);
    expect(r.created[1].parent).toBe('app');
    expect(el(root, 'a')).toContain('title: Elsewhere');
  });

  it('a component created under a matched container takes that container\'s slug as parent', async () => {
    const root = appWorkspace();
    put(root, '.tasklog/architecture/main-app.md', '---\nkind: container\ntitle: Main\nreview: accepted\ncode:\n  - .\n---\n\n## Description\n\n## Responsibilities\n');
    // A second container takes the sources, so main-app owns only package.json and still passes the 50% rule.
    put(root, '.tasklog/architecture/srcs.md', '---\nkind: container\ntitle: Sources\nreview: accepted\ncode:\n  - src\n---\n\n## Description\n\n## Responsibilities\n');
    const r = await scan(root);
    expect(r.created.map((c: any) => [c.id, c.parent])).toEqual([
      ['architecture/a', 'main-app'],
      ['architecture/b', 'main-app'],
    ]);
    expect(el(root, 'a')).toContain('parent: main-app');
  });

  it('reports ignored paths with reasons and unowned code as findings', async () => {
    const root = appWorkspace();
    put(root, 'src/a/a.test.ts', '');
    put(root, 'test/unit/t.test.ts', '');
    put(root, 'loose/tool.py', '');
    const r = await scan(root, true);
    expect(r.ignored.test.count).toBeGreaterThan(0);
    expect(Object.keys(r.ignored).sort()).toEqual(['fixture-template', 'not-workspace-member', 'test', 'tooling', 'user']);
    expect(r.findings.every((f: any) => typeof f.detail === 'string')).toBe(true);
  });

  it('fails for a directory that is not an initialised workspace', async () => {
    const bare = path.join(env.root, 'bare');
    fs.mkdirSync(bare);
    const r = await tool(bare, 'scan_architecture', {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('no_workspace'); // the platform's error for every workspace tool
  });
});

describe('file listing', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  it('in a git repo lists tracked plus untracked-not-ignored files and honours .gitignore', async () => {
    const root = appWorkspace();
    put(root, '.gitignore', 'gen/\n');
    put(root, 'gen/g/gen.ts', '');
    put(root, 'src/c/tracked.ts', '');
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'src/c/tracked.ts');
    const r = await scan(root, true);
    expect(r.created.map((c: any) => c.code[0])).toEqual(['.', 'src/a', 'src/b', 'src/c']);
    expect(JSON.stringify(r)).not.toContain('gen/');
  });

  it('outside git applies the built-in ignore list', async () => {
    const root = appWorkspace();
    for (const dir of ['node_modules/dep', 'dist', 'bin', 'obj', 'target', 'vendor/lib', '.git']) put(root, `${dir}/f.ts`, '');
    put(root, 'node_modules/dep/package.json', '{"name":"dep"}');
    const r = await scan(root, true);
    expect(r.created.map((c: any) => c.code[0])).toEqual(['.', 'src/a', 'src/b']);
  });
});

describe('Windows path and CRLF cases', () => {
  it('detects from CRLF manifests and keeps CRLF when it rewrites a CRLF element file', async () => {
    const root = appWorkspace(true);
    const crlf = '---\r\nkind: component\r\ntitle: A\r\nreview: accepted\r\ncode:\r\n  - src/a/x.ts\r\n---\r\n\r\n## Description\r\n\r\nKept.\r\n\r\n## Responsibilities\r\n';
    put(root, '.tasklog/architecture/a.md', crlf);
    put(root, 'src/a/z.ts', '');
    const r = await scan(root);
    expect(r.created.map((c: any) => c.id)).toEqual(['architecture/app', 'architecture/b']); // package.json with CRLF named the container
    expect(r.updated).toEqual([{ id: 'architecture/a', added: ['src/a'], removed: ['src/a/x.ts'] }]);
    const text = el(root, 'a');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(text).toContain('Kept.');
    expect(text).toContain('  - src/a\r\n');
  });

  it('writes forward-slash code paths and matches code case-sensitively', async () => {
    const root = appWorkspace();
    await scan(root);
    for (const n of elementFiles(root)) expect(el(root, n.replace(/\.md$/, ''))).not.toContain('\\');
    put(root, '.tasklog/architecture/a.md', '---\nkind: component\ntitle: A\nreview: accepted\nparent: app\ncode:\n  - SRC/a\n---\n\n## Description\n\n## Responsibilities\n');
    const r = await scan(root);
    expect(r.findings.map((f: any) => [f.category, f.path])).toContainEqual(['missing-path', 'SRC/a']);
    expect(r.created.map((c: any) => c.code[0])).toContain('src/a'); // not matched by name or by case-folded path
  });
});

describe('concurrency and stale hashes', () => {
  it('a curator edit during the scan\'s write is skipped, nothing is lost, and the rerun finishes the job', async () => {
    const root = appWorkspace();
    await scan(root);
    let h = await hashOf(root, 'architecture/a');
    await tool(root, 'set_fields', { id: 'architecture/a', hash: h, code: ['src/a/x.ts'] });
    put(root, 'src/a/z.ts', '');
    let paused = 0;
    d.writes.beforeRename = (w) => {
      if (w.id !== 'architecture/a') return;
      paused++;
      fs.appendFileSync(path.join(root, w.path), '\n## Interface\n\nCurator was here.\n');
    };
    const r = await scan(root);
    d.writes.beforeRename = undefined;
    expect(paused).toBe(1);
    expect(r.skipped).toEqual([{ id: 'architecture/a', reason: 'changed during scan' }]);
    expect(r.updated).toEqual([]);
    expect(el(root, 'a')).toContain('Curator was here.');
    expect(el(root, 'a')).toMatch(/code: \[src\/a\/x\.ts\]/);
    expect(fs.readdirSync(archDir(root)).filter((n) => n.includes('tmp'))).toEqual([]);
    const rerun = await scan(root);
    expect(rerun.skipped).toEqual([]);
    expect(rerun.updated.map((u: any) => u.id)).toEqual(['architecture/a']);
    expect(el(root, 'a')).toContain('Curator was here.');
  });

  it('two racing scans create each element once', async () => {
    const root = appWorkspace();
    const [r1, r2] = await Promise.all([scan(root), scan(root)]);
    expect(elementFiles(root)).toEqual(['a.md', 'app.md', 'b.md']);
    expect(r1.created.length + r2.created.length).toBe(3);
    expect((await scan(root, true)).created).toEqual([]);
  });

  it('a scan interleaved with a creation of the same slug leaves exactly one winner', async () => {
    const root = appWorkspace();
    const text = '---\nkind: container\ntitle: Hand made\nreview: accepted\ncode:\n  - .\n---\n\n## Description\n\n## Responsibilities\n';
    const [r] = await Promise.all([scan(root), d.writes.createElementFile(root, 'app', text).catch(() => null)]);
    expect(elementFiles(root)).toEqual(['a.md', 'app.md', 'b.md']); // no app-2
    expect(r.created.map((c: any) => c.id).filter((id: string) => id === 'architecture/app').length + r.skipped.length).toBeLessThanOrEqual(1);
    const title = /title: (.*)/.exec(el(root, 'app'))![1];
    expect(['app', 'Hand made']).toContain(title);
  });

  it('seeded randomised run: parallel scans, edits and deletions leave parseable files and a stable dry-run', async () => {
    let seed = 20260101;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const root = appWorkspace();
    put(root, 'src/c/z.ts', '');
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      const pick = rnd(4);
      if (pick === 0) ops.push(scan(root));
      else if (pick === 1) ops.push(scan(root, true));
      else if (pick === 2) {
        const slug = ['a', 'b', 'c', 'app'][rnd(4)]!;
        ops.push(
          (async () => {
            const meta = await tool(root, 'get_item', { id: `architecture/${slug}`, meta_only: true });
            if (meta.isError) return;
            await tool(root, 'set_fields', { id: `architecture/${slug}`, hash: meta.structuredContent.hash, review: rnd(2) ? 'accepted' : 'proposed' });
          })(),
        );
      } else {
        const slug = ['b', 'app'][rnd(2)]!; // one component at most: deleting several makes the container own over half the files, so it is proposed anew (spec'd 50% rule)
        ops.push(fs.promises.rm(path.join(archDir(root), `${slug}.md`), { force: true }));
      }
      if (rnd(3) === 0) await Promise.allSettled(ops.splice(0));
    }
    await Promise.allSettled(ops);
    await d.writes.idle();
    await scan(root); // settle
    for (const n of elementFiles(root)) {
      const r = await tool(root, 'get_item', { id: `architecture/${n.replace(/\.md$/, '')}` });
      expect(r.isError, `${n} must parse`).toBeFalsy();
    }
    expect(fs.readdirSync(archDir(root)).filter((n) => n.includes('tmp'))).toEqual([]);
    const dry = await scan(root, true);
    expect(dry.created).toEqual([]);
    expect(dry.updated).toEqual([]);
    expect(dry.skipped).toEqual([]);
  });
});
