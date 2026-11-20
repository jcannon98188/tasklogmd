// Slice 6: `tasklog scan [--dry-run] [--json]` is a thin caller of `scan_architecture`.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, runCommand } from '../../src/commands.ts';
import { callTool } from '../../src/mcp-call.ts';
import { probeDaemon } from '../../src/client.ts';
import { makeEnv, mkWorkspace, type TestEnv } from '../helpers.ts';

let env: TestEnv;
let emptyPathDir: string;
beforeEach(() => {
  env = makeEnv();
  emptyPathDir = path.join(env.root, 'emptybin');
  fs.mkdirSync(emptyPathDir);
});
afterEach(() => env.cleanup());

async function cli(args: string[], cwd: string = env.root) {
  let stdout = '';
  let stderr = '';
  const code = await runCommand(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    cwd,
    paths: env.paths,
    env: { ...process.env, PATH: emptyPathDir },
    spawn: () => void env.start(),
  });
  return { code, stdout, stderr };
}

function put(root: string, rel: string, text: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** Container `app` with components `a` and `b`, plus a manifest-less `loose/` directory (unowned code). */
function repo(): string {
  const ws = mkWorkspace(env.root);
  put(ws, 'pkg/package.json', JSON.stringify({ name: 'app' }));
  put(ws, 'pkg/src/a/index.ts', 'export {};\n');
  put(ws, 'pkg/src/b/index.ts', 'export {};\n');
  put(ws, 'loose/x.ts', 'export {};\n');
  return ws;
}

const elements = (ws: string) => {
  const dir = path.join(ws, '.tasklog', 'architecture');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [];
};

describe('tasklog scan', () => {
  it('writes proposed elements, prints a summary and a next-step line, and exits 0 despite findings', async () => {
    const ws = repo();
    const r = await cli(['scan'], ws);
    expect(r.code).toBe(EXIT.ok);
    expect(elements(ws).length).toBeGreaterThan(0);
    expect(r.stdout).toMatch(/created/i);
    expect(r.stdout).toContain('app');
    expect(r.stdout).toContain('unowned-code'); // findings grouped by category
    expect(r.stdout).toMatch(/\d+ proposed elements? need curation\. Ask your agent to curate the Architecture, or see docs\/agents\/issue-tracker\.md#architecture\./);
    expect(r.stdout).not.toContain('Nothing written');
    expect(r.stderr).toBe('');
  });

  it('--dry-run writes nothing and ends with "Nothing written."', async () => {
    const ws = repo();
    const r = await cli(['scan', '--dry-run'], ws);
    expect(r.code).toBe(EXIT.ok);
    expect(elements(ws)).toEqual([]);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('Nothing written. Re-run without --dry-run to apply.');
    expect(r.stdout).toMatch(/need curation/);
  });

  it('--json equals the scan_architecture tool result and is machine-pure (no next-step line)', async () => {
    const ws = repo();
    const dry = await cli(['scan', '--dry-run', '--json'], ws);
    expect(dry.code).toBe(EXIT.ok);
    const probe = (await probeDaemon(env.paths))!;
    const tool = await callTool(probe.state, 'scan_architecture', { dry_run: true }, { workspace: ws });
    expect(JSON.parse(dry.stdout)).toEqual(tool.structuredContent);
    expect(dry.stdout.trim().split('\n')).toHaveLength(1);

    const real = await cli(['scan', '--json'], ws);
    const parsed = JSON.parse(real.stdout);
    expect(parsed.dry_run).toBe(false);
    expect(parsed.created.length).toBeGreaterThan(0);
  });

  it('an unchanged rescan reports nothing created or updated, and a fully clean repo has no next-step line', async () => {
    const ws = mkWorkspace(env.root);
    put(ws, 'package.json', JSON.stringify({ name: 'solo' }));
    put(ws, 'pkg/src/a/index.ts', 'export {};\n');
    expect((await cli(['scan'], ws)).code).toBe(EXIT.ok);
    // Accept every element by hand so nothing needs curation.
    const dir = path.join(ws, '.tasklog', 'architecture');
    for (const f of elements(ws)) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8').replace('review: proposed', 'review: accepted'));
    await new Promise((r) => setTimeout(r, 300)); // let the watcher pick the edits up
    const again = await cli(['scan', '--json'], ws);
    const j = JSON.parse(again.stdout);
    expect(j.created).toEqual([]);
    expect(j.updated).toEqual([]);
    const human = await cli(['scan'], ws);
    expect(human.code).toBe(EXIT.ok);
    expect(human.stdout).not.toMatch(/need curation/);
    expect(human.stdout).not.toContain('Nothing written');
  });

  it('outside a workspace it fails with exit 1 and a message on stderr; unknown options exit 2', async () => {
    const plain = path.join(env.root, 'plain');
    fs.mkdirSync(plain);
    const r = await cli(['scan'], plain);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toMatch(/init/i);
    expect(r.stdout).toBe('');
    expect((await cli(['scan', '--nope'], plain)).code).toBe(EXIT.usage);
    expect((await cli(['scan', 'extra'], plain)).code).toBe(EXIT.usage);
  });

  it('--workspace selects the workspace', async () => {
    const ws = repo();
    const r = await cli(['scan', '--dry-run', '--json', '--workspace', ws]);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).created.length).toBeGreaterThan(0);
  });
});
