import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, runCommand } from '../../src/commands.ts';
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

async function cli(args: string[], opts: { cwd?: string; startDaemon?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCommand(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    cwd: opts.cwd ?? env.root,
    paths: env.paths,
    env: { ...process.env, PATH: emptyPathDir }, // no `claude` on PATH
    spawn: () => void env.start(),
  });
  return { code, stdout, stderr };
}

describe('registry commands', () => {
  it('add, list and remove start a daemon and go through it', async () => {
    const ws = mkWorkspace(env.root);
    expect(await probeDaemon(env.paths)).toBeNull();
    const add = await cli(['add', ws]);
    expect(add.code).toBe(EXIT.ok);
    expect(await probeDaemon(env.paths)).not.toBeNull();

    const list = await cli(['list', '--json']);
    const parsed = JSON.parse(list.stdout);
    expect(parsed.workspaces).toHaveLength(1);
    expect(parsed.workspaces[0].root.toLowerCase()).toBe(fs.realpathSync.native(ws).toLowerCase());
    expect(JSON.parse(fs.readFileSync(env.paths.workspacesJson, 'utf8')).workspaces).toHaveLength(1);

    expect((await cli(['remove', ws])).code).toBe(EXIT.ok);
    expect(JSON.parse((await cli(['list', '--json'])).stdout).workspaces).toEqual([]);
  });

  it('add of a directory without .tasklog/ fails with exit 1 and a message on stderr', async () => {
    const dir = path.join(env.root, 'plain');
    fs.mkdirSync(dir);
    const r = await cli(['add', dir]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toMatch(/init/i);
    expect(r.stdout).toBe('');
  });
});

describe('start', () => {
  it('spawns the daemon and returns once healthy', async () => {
    const r = await cli(['start']);
    expect(r.code).toBe(EXIT.ok);
    expect(await probeDaemon(env.paths)).not.toBeNull();
  });
});

describe('init', () => {
  it('with no daemon creates .tasklog/ without starting one', async () => {
    const dir = path.join(env.root, 'proj');
    fs.mkdirSync(dir);
    const r = await cli(['init'], { cwd: dir });
    expect(r.code).toBe(EXIT.ok);
    expect(fs.statSync(path.join(dir, '.tasklog')).isDirectory()).toBe(true);
    expect(await probeDaemon(env.paths)).toBeNull();
  });

  it('with a daemon running registers through it; --workspace replaces the cwd', async () => {
    await env.start();
    const dir = path.join(env.root, 'proj2');
    fs.mkdirSync(dir);
    const r = await cli(['init', '--workspace', dir]);
    expect(r.code).toBe(EXIT.ok);
    const list = JSON.parse((await cli(['list', '--json'])).stdout);
    expect(list.workspaces).toHaveLength(1);
    const filtered = JSON.parse((await cli(['list', '--json', '--workspace', dir])).stdout);
    expect(filtered.workspaces).toHaveLength(1);
    const other = JSON.parse((await cli(['list', '--json', '--workspace', env.root])).stdout);
    expect(other.workspaces).toHaveLength(0);
  });
});

describe('status', () => {
  it('--json is valid JSON on stdout, exit 3 with no daemon, workspace resolved from --workspace', async () => {
    const none = await cli(['status', '--json']);
    expect(none.code).toBe(EXIT.noDaemon);
    expect(JSON.parse(none.stdout)).toEqual({ running: false });

    await env.start();
    const ws = mkWorkspace(env.root);
    await cli(['add', ws]);
    const s = await cli(['status', '--json', '--workspace', ws]);
    expect(s.code).toBe(EXIT.ok);
    expect(JSON.parse(s.stdout).workspace.registered).toBe(true);
  });
});

describe('newer daemon', () => {
  it('exits 4 for commands other than stop and status', async () => {
    await env.start({ protocol: 2 });
    for (const args of [['start'], ['list'], ['add', env.root], ['remove', env.root], ['init'], ['doctor']]) {
      const r = await cli(args);
      expect(r.code, args.join(' ')).toBe(EXIT.protocol);
    }
    expect((await cli(['status'])).code).toBe(EXIT.ok);
    expect((await cli(['stop'])).code).toBe(EXIT.ok);
    expect(await probeDaemon(env.paths)).toBeNull();
  });
});

describe('usage errors exit 2', () => {
  it.each([[['bogus']], [[]], [['add']], [['status', '--nope']], [['list', '--workspace']], [['stop', 'extra']], [['serve', '--json']]])('%j', async (args) => {
    const r = await cli(args);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toMatch(/usage/);
  });
});

describe('doctor', () => {
  it('passes on a healthy install, skips claude when absent, includes workspace problems[]', async () => {
    const ws = mkWorkspace(env.root);
    const r = await cli(['doctor', '--json', '--workspace', ws]);
    const out = JSON.parse(r.stdout);
    expect(r.code).toBe(EXIT.ok);
    expect(out.ok).toBe(true);
    for (const c of out.checks) expect(Object.keys(c).sort()).toEqual(['detail', 'fix', 'name', 'ok']);
    const claude = out.checks.find((c: any) => c.name === 'claude-mcp');
    expect(claude.ok).toBe(true);
    expect(claude.detail).toMatch(/skipped/);
    expect(out.checks.map((c: any) => c.name)).toEqual(expect.arrayContaining(['daemon-json', 'workspaces-readable', 'workspace-problems']));
    expect(out.problems).toEqual([]);
    expect(out.recent_events).toEqual([]);
  });

  it('a stale daemon.json fails its check and exits 1', async () => {
    fs.mkdirSync(env.paths.dir, { recursive: true });
    fs.writeFileSync(env.paths.daemonJson, JSON.stringify({ pid: 2 ** 22 - 3, port: 1, token: 'x', version: '0', protocol: 1 }));
    const r = await cli(['doctor', '--json']);
    const out = JSON.parse(r.stdout);
    expect(r.code).toBe(EXIT.failed);
    const c = out.checks.find((x: any) => x.name === 'daemon-json');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/stale/);
    expect(c.fix).toBeTruthy();
    expect(out.checks.find((x: any) => x.name === 'daemon-health').ok).toBe(true); // doctor replaced it
  });

  it('an unwritable log directory fails its check', async () => {
    fs.rmSync(env.paths.logsDir, { recursive: true, force: true }); // makeEnv's logger created it
    fs.writeFileSync(env.paths.logsDir, 'i am a file, not a directory');
    const out = JSON.parse((await cli(['doctor', '--json'])).stdout);
    const c = out.checks.find((x: any) => x.name === 'log-dir-writable');
    expect(c.ok).toBe(false);
    expect(c.fix).toBeTruthy();
  });

  it('an unreadable workspaces.json fails its check', async () => {
    fs.mkdirSync(env.paths.dir, { recursive: true });
    fs.writeFileSync(env.paths.workspacesJson, '{ not json');
    const r = await cli(['doctor', '--json']);
    const c = JSON.parse(r.stdout).checks.find((x: any) => x.name === 'workspaces-readable');
    expect(c.ok).toBe(false);
    expect(r.code).toBe(EXIT.failed);
  });

  it('a failing check keeps stdout valid JSON and diagnostics off stdout', async () => {
    fs.mkdirSync(env.paths.dir, { recursive: true });
    fs.writeFileSync(env.paths.workspacesJson, '[');
    const r = await cli(['doctor', '--json']);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('with a newer daemon exits 4', async () => {
    await env.start({ protocol: 2 });
    const r = await cli(['doctor', '--json']);
    expect(r.code).toBe(EXIT.protocol);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});
