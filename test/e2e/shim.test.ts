import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pidAlive, sleep } from '../../src/fsutil.ts';
import { dataPaths } from '../../src/paths.ts';
import { copyFixture, mkWorkspace, rmDir, tmpDir } from '../helpers.ts';

const CLI = path.resolve('dist', 'cli.js');

let root: string;
let home: string;
let env: Record<string, string>;
const clients: Client[] = [];

beforeEach(() => {
  root = tmpDir('tasklog-e2e-');
  home = path.join(root, 'home'); // TASKLOG_HOME: never the real %LOCALAPPDATA%\tasklog
  env = { ...(process.env as Record<string, string>), TASKLOG_HOME: home };
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  // Never leave a daemon running: ask it to stop, then kill by pid as a fallback.
  const paths = dataPaths(home);
  let pid: number | undefined;
  try {
    pid = JSON.parse(fs.readFileSync(paths.daemonJson, 'utf8')).pid;
  } catch {
    /* none */
  }
  await runCli(['stop']).catch(() => {});
  if (pid && pidAlive(pid)) {
    for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(100);
    if (pidAlive(pid)) process.kill(pid);
  }
  rmDir(root);
});

function runCli(args: string[], cwd = root): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function connect(cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'shim'], env, cwd });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const text = (r: any): any => r.structuredContent;

describe('stdio shim against a real detached daemon', () => {
  it('spawns the daemon on demand, registers the workspace and workspace_status returns ready', async () => {
    const ws = mkWorkspace(root);
    const sub = path.join(ws, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect((await runCli(['status'])).code).toBe(3); // no daemon yet

    const client = await connect(sub);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(expect.arrayContaining(['get_item', 'init_workspace', 'list_items', 'workspace_status']));

    const res = await client.callTool({ name: 'workspace_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res).state).toBe('ready');
    expect(text(res).root.toLowerCase()).toBe(fs.realpathSync.native(ws).toLowerCase());

    const status = await runCli(['status', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).workspaces).toHaveLength(1);

    // The daemon's cwd is the data dir, not the package dir (Spike 3).
    const pid = JSON.parse(fs.readFileSync(dataPaths(home).daemonJson, 'utf8')).pid;
    expect(pidAlive(pid)).toBe(true);
  });

  it('fails no_workspace outside any .tasklog/ root and init_workspace fixes it', async () => {
    const dir = path.join(root, 'plain');
    fs.mkdirSync(dir);
    const client = await connect(dir);
    const bad = await client.callTool({ name: 'workspace_status', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(text(bad).error.code).toBe('no_workspace');
    expect(text(bad).error.message).toMatch(/init/);

    const init = await client.callTool({ name: 'init_workspace', arguments: {} });
    expect(init.isError).toBeFalsy();
    expect(fs.statSync(path.join(dir, '.tasklog')).isDirectory()).toBe(true);
  });

  it('a second shim reuses the running daemon', async () => {
    const ws = mkWorkspace(root);
    const a = await connect(ws);
    await a.callTool({ name: 'workspace_status', arguments: {} });
    const pid1 = JSON.parse(fs.readFileSync(dataPaths(home).daemonJson, 'utf8')).pid;
    const b = await connect(ws);
    await b.callTool({ name: 'workspace_status', arguments: {} });
    const pid2 = JSON.parse(fs.readFileSync(dataPaths(home).daemonJson, 'utf8')).pid;
    expect(pid2).toBe(pid1);
  });

  it('edits an item through the shim: toggle_ac changes one line and a stale hash is refused', async () => {
    const ws = copyFixture('normal', root);
    const client = await connect(ws);
    const rel = path.join(ws, '.tasklog', 'alpha', 'tickets', '03-blocked-prototype.md');
    const before = fs.readFileSync(rel, 'utf8');
    const got = await client.callTool({ name: 'get_item', arguments: { id: 'alpha/03' } });
    const hash = text(got).hash;
    const r = await client.callTool({ name: 'toggle_ac', arguments: { id: 'alpha/03', hash, n: 1 } });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(rel, 'utf8')).toBe(before.replace('- [ ] #1 First', '- [x] #1 First'));
    expect(text(r).hash).not.toBe(hash);
    const stale = await client.callTool({ name: 'toggle_ac', arguments: { id: 'alpha/03', hash, n: 2 } });
    expect(stale.isError).toBe(true);
    expect(text(stale).error.code).toBe('stale_hash');
  });
});

describe('architecture tools through the real shim', () => {
  it('lists the new tools and each is callable: scan, create_element, architecture, owners', async () => {
    const ws = mkWorkspace(root);
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'smoke' }));
    fs.mkdirSync(path.join(ws, 'src', 'core'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'core', 'index.ts'), 'export {};\n');
    const client = await connect(ws);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['scan_architecture', 'architecture', 'create_element', 'owners']));

    const dry = await client.callTool({ name: 'scan_architecture', arguments: { dry_run: true } });
    expect(dry.isError).toBeFalsy();
    expect(text(dry).dry_run).toBe(true);
    expect(text(dry).created.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(ws, '.tasklog', 'architecture'))).toBe(false);

    const scan = await client.callTool({ name: 'scan_architecture', arguments: {} });
    expect(scan.isError).toBeFalsy();
    expect(text(scan).created.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['architecture/smoke']));

    const made = await client.callTool({ name: 'create_element', arguments: { kind: 'component', title: 'Scripts', parent: 'smoke', code: ['scripts'] } });
    expect(made.isError).toBeFalsy();
    expect(text(made).id).toBe('architecture/scripts');

    const tree = await client.callTool({ name: 'architecture', arguments: {} });
    expect(tree.isError).toBeFalsy();
    expect(text(tree).containers[0].id).toBe('smoke');

    const own = await client.callTool({ name: 'owners', arguments: { paths: ['scripts/build.mjs', 'nowhere/x.ts'] } });
    expect(own.isError).toBeFalsy();
    expect(text(own).owners.map((o: { id: string }) => o.id).sort()).toEqual(['scripts', 'smoke']);
    expect(text(own).unowned).toEqual([]);
  });
});

describe('CLI', () => {
  it('status exits 3 with no daemon and never starts one; stop exits 0', async () => {
    const s = await runCli(['status']);
    expect(s.code).toBe(3);
    expect(fs.existsSync(dataPaths(home).daemonJson)).toBe(false);
    const st = await runCli(['stop']);
    expect(st.code).toBe(0);
    expect(fs.existsSync(dataPaths(home).daemonJson)).toBe(false);
  });

  it('serve runs the daemon in the foreground until stopped', async () => {
    const child = spawn(process.execPath, [CLI, 'serve'], { env, cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = (await runCli(['status'])).code === 0;
        if (!up) await sleep(100);
      }
      expect(up).toBe(true);
      expect((await runCli(['stop'])).code).toBe(0);
      expect(await exited).toBe(0);
    } finally {
      child.kill();
    }
  });

  it('doctor starts the daemon, passes and exits 0, with --json output', async () => {
    const d = await runCli(['doctor', '--json']);
    const out = JSON.parse(d.stdout);
    // The machine's real claude may or may not have tasklog registered; every other check must pass.
    expect(out.checks.filter((c: any) => c.name !== 'claude-mcp').every((c: any) => c.ok)).toBe(true);
    if (out.checks.find((c: any) => c.name === 'claude-mcp').ok) expect(d.code).toBe(0);
    expect(out.checks.map((c: any) => c.name)).toEqual(expect.arrayContaining(['node-version', 'daemon-health', 'protocol']));
    expect((await runCli(['status'])).code).toBe(0);
  });

  it('start spawns a detached daemon; add/list/remove go through it; usage error exits 2', async () => {
    const started = await runCli(['start']);
    expect(started.code).toBe(0);
    expect((await runCli(['status'])).code).toBe(0);
    const ws = mkWorkspace(root);
    expect((await runCli(['add', ws])).code).toBe(0);
    const list = await runCli(['list', '--json']);
    expect(JSON.parse(list.stdout).workspaces).toHaveLength(1);
    expect((await runCli(['remove', ws])).code).toBe(0);
    expect((await runCli(['frobnicate'])).code).toBe(2);
  });

  it('prints version and protocol', async () => {
    const v = await runCli(['--version']);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/tasklog \S+ \(protocol 1\)/);
  });
  it('reads a fixture workspace through the shim: list_items then get_item', async () => {
    const ws = copyFixture('normal', root);
    const client = await connect(ws);
    const list = await client.callTool({ name: 'list_items', arguments: { effort: 'alpha', status: 'open', kind: 'ticket' } });
    expect(list.isError).toBeFalsy();
    expect(text(list).items.map((i: { id: string }) => i.id)).toEqual(['alpha/03', 'alpha/04', 'alpha/10']);
    const got = await client.callTool({ name: 'get_item', arguments: { id: 'alpha/03' } });
    expect(text(got).frontmatter.title).toBe('Blocked prototype');
  });
});
