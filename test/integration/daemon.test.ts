import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callDaemon, ensureDaemon, EnsureDaemonError, probeDaemon } from '../../src/client.ts';
import { FakeClock, makeEnv, mkWorkspace, rawRequest, sleep, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

/** One MCP JSON-RPC call over the daemon's streamable HTTP endpoint. */
async function mcpTool(d: { port: number; token: string }, name: string, args: object, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${d.token}`,
      'x-tasklog-protocol': '1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; structuredContent: any } };
  return body.result;
}

describe('authentication', () => {
  it('rejects requests without the token, with an Origin, or with a wrong Host, on every endpoint', async () => {
    const d = await env.start();
    const good = { authorization: `Bearer ${d.token}`, host: `127.0.0.1:${d.port}`, 'x-tasklog-protocol': '1' };
    const endpoints: Array<[string, string]> = [
      ['GET', '/health'],
      ['GET', '/workspaces'],
      ['POST', '/workspaces'],
      ['DELETE', '/workspaces'],
      ['POST', '/mcp'],
      ['POST', '/shutdown'],
    ];
    const bads: Array<Record<string, string>> = [
      { ...good, authorization: '' },
      { ...good, authorization: 'Bearer wrong' },
      { ...good, origin: 'http://evil.example' },
      { ...good, host: 'evil.example' },
      { ...good, host: `127.0.0.1:${d.port + 1}` },
    ];
    for (const [method, p] of endpoints) {
      for (const h of bads) {
        const r = await rawRequest(d.port, p, h, method);
        expect(r.status, `${method} ${p} ${JSON.stringify(h)}`).toBe(401);
        expect(r.body.error.code).toBe('unauthorized');
      }
    }
    // The unauthenticated /shutdown must not have stopped the daemon.
    expect((await rawRequest(d.port, '/health', good)).status).toBe(200);
  });

  it('accepts localhost:<port> as Host', async () => {
    const d = await env.start();
    const r = await rawRequest(d.port, '/health', { authorization: `Bearer ${d.token}`, host: `localhost:${d.port}` });
    expect(r.status).toBe(200);
  });
});

describe('daemon.json and the lock', () => {
  it('writes daemon.json with pid, port, token, version, protocol and refuses a second instance', async () => {
    const d = await env.start();
    const s = JSON.parse(fs.readFileSync(env.paths.daemonJson, 'utf8'));
    expect(s).toMatchObject({ pid: process.pid, port: d.port, token: d.token, protocol: 1 });
    expect(s.token).toHaveLength(64);
    await expect(env.start()).rejects.toThrow(/lock/);
  });

  it('replaces a stale daemon.json (dead pid) and connects', async () => {
    fs.mkdirSync(env.paths.dir, { recursive: true });
    fs.writeFileSync(env.paths.daemonJson, JSON.stringify({ pid: 999999, port: 1, token: 'stale', version: 'x', protocol: 1 }));
    expect(await probeDaemon(env.paths)).toBeNull();

    let spawned = 0;
    const r = await ensureDaemon({
      paths: env.paths,
      log: env.log,
      spawn: () => {
        spawned++;
        void env.start();
      },
    });
    expect(spawned).toBe(1);
    expect(r.action).toBe('spawned');
    const fresh = JSON.parse(fs.readFileSync(env.paths.daemonJson, 'utf8'));
    expect(fresh.token).not.toBe('stale');
    expect(r.probe.health.ok).toBe(true);
  });
});

describe('workspaces', () => {
  it('fails workspace_status with no_workspace and an init hint when there is no .tasklog/', async () => {
    const d = await env.start();
    const r = await mcpTool(d, 'workspace_status', {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('no_workspace');
    expect(r.structuredContent.error.message).toMatch(/init/);
  });

  it('init_workspace creates and registers .tasklog/, then workspace_status is ready', async () => {
    const d = await env.start();
    const dir = path.join(env.root, 'fresh');
    fs.mkdirSync(dir);
    const init = await mcpTool(d, 'init_workspace', {}, { 'x-tasklog-cwd': dir });
    expect(init.isError).toBeFalsy();
    expect(fs.statSync(path.join(dir, '.tasklog')).isDirectory()).toBe(true);
    const status = await mcpTool(d, 'workspace_status', {}, { 'x-tasklog-workspace': dir });
    expect(status.structuredContent.state).toBe('ready');
    const list = await callDaemon<{ workspaces: Array<{ root: string }> }>(env.state(d), 'GET', '/workspaces');
    expect(list.body.workspaces).toHaveLength(1);
  });

  it('auto-registers a valid root named by the header and persists it in workspaces.json', async () => {
    const d = await env.start();
    const ws = mkWorkspace(env.root);
    const r = await mcpTool(d, 'workspace_status', {}, { 'x-tasklog-workspace': ws });
    expect(r.structuredContent.state).toBe('ready');
    const saved = JSON.parse(fs.readFileSync(env.paths.workspacesJson, 'utf8'));
    expect(saved.workspaces).toHaveLength(1);
  });

  it('POST /workspaces is idempotent and canonicalizes case on Windows', async () => {
    const d = await env.start();
    const ws = mkWorkspace(env.root, 'MixedCase');
    const a = await callDaemon<{ root: string }>(env.state(d), 'POST', '/workspaces', { body: { root: ws } });
    const b = await callDaemon<{ root: string }>(env.state(d), 'POST', '/workspaces', { body: { root: ws.toUpperCase() } });
    if (process.platform === 'win32') {
      expect(b.body.root).toBe(a.body.root);
      const list = await callDaemon<{ workspaces: unknown[] }>(env.state(d), 'GET', '/workspaces');
      expect(list.body.workspaces).toHaveLength(1);
    } else {
      expect(a.status).toBe(200);
    }
  });

  it('rejects a relative or .tasklog-less root', async () => {
    const d = await env.start();
    const rel = await callDaemon<any>(env.state(d), 'POST', '/workspaces', { body: { root: 'relative/path' } });
    expect(rel.status).toBe(400);
    const dir = path.join(env.root, 'plain');
    fs.mkdirSync(dir);
    const none = await callDaemon<any>(env.state(d), 'POST', '/workspaces', { body: { root: dir } });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('no_workspace');
  });

  it('sets a corrupt workspaces.json aside as .bak and rebuilds it empty', async () => {
    fs.mkdirSync(env.paths.dir, { recursive: true });
    fs.writeFileSync(env.paths.workspacesJson, '{ not json');
    const d = await env.start();
    expect(fs.readFileSync(`${env.paths.workspacesJson}.bak`, 'utf8')).toBe('{ not json');
    const list = await callDaemon<{ workspaces: unknown[] }>(env.state(d), 'GET', '/workspaces');
    expect(list.body.workspaces).toEqual([]);
    expect(JSON.parse(fs.readFileSync(env.paths.workspacesJson, 'utf8')).workspaces).toEqual([]);
  });

  it('prunes a registered workspace whose directory disappeared', async () => {
    const ws = mkWorkspace(env.root);
    const d = await env.start();
    await callDaemon(env.state(d), 'POST', '/workspaces', { body: { root: ws } });
    fs.rmSync(ws, { recursive: true, force: true });
    const list = await callDaemon<{ workspaces: unknown[] }>(env.state(d), 'GET', '/workspaces');
    expect(list.body.workspaces).toEqual([]);
  });
});

describe('versioning', () => {
  it('a newer shim drains an older daemon, which exits and is respawned', async () => {
    const old = await env.start({ protocol: 1, version: '1.0.0' });
    const r = await ensureDaemon({
      paths: env.paths,
      log: env.log,
      protocol: 2,
      spawn: () => void env.start({ protocol: 2, version: '2.0.0' }),
    });
    expect(r.action).toBe('restarted');
    expect(r.probe.health.protocol).toBe(2);
    expect(r.probe.state.port).not.toBe(old.port);
    await old.stopped; // old daemon fully exited
  });

  it('an older shim facing a newer daemon errors and leaves the daemon running', async () => {
    const newer = await env.start({ protocol: 2, version: '2.0.0' });
    let spawned = 0;
    const err = await ensureDaemon({ paths: env.paths, log: env.log, protocol: 1, spawn: () => spawned++ }).catch((e) => e);
    expect(err).toBeInstanceOf(EnsureDaemonError);
    expect(err.kind).toBe('daemon_newer_than_shim');
    expect(spawned).toBe(0);
    const p = await probeDaemon(env.paths);
    expect(p?.health.pid).toBe(newer.pid);
    expect(p?.state.port).toBe(newer.port);
  });

  it('rejects a mismatched client protocol on non-probe endpoints with 409 protocol_mismatch', async () => {
    const d = await env.start({ protocol: 2 });
    const r = await callDaemon<any>(env.state(d), 'GET', '/workspaces', { protocol: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('protocol_mismatch');
    // /health works for any protocol.
    expect((await callDaemon(env.state(d), 'GET', '/health', { protocol: 1 })).status).toBe(200);
  });
});

describe('lifecycle', () => {
  it('exits after 30 minutes with no clients (injected clock)', async () => {
    const clock = new FakeClock();
    const d = await env.start({ clock });
    clock.advance(29 * 60_000);
    await sleep(50);
    expect(fs.existsSync(env.paths.daemonJson)).toBe(true); // still up (a probe would count as activity)
    clock.advance(2 * 60_000);
    await d.stopped;
    expect(fs.existsSync(env.paths.daemonJson)).toBe(false);
    expect(fs.existsSync(env.paths.lock)).toBe(false);
  });

  it('activity resets the idle timer', async () => {
    const clock = new FakeClock();
    const d = await env.start({ clock });
    clock.advance(25 * 60_000);
    await callDaemon(env.state(d), 'GET', '/health');
    clock.advance(25 * 60_000);
    await sleep(50);
    expect((await probeDaemon(env.paths))?.health.ok).toBe(true);
  });

  it('POST /shutdown drains and exits, releasing daemon.json and the lock', async () => {
    const d = await env.start();
    const r = await callDaemon(env.state(d), 'POST', '/shutdown');
    expect(r.status).toBe(200);
    await d.stopped;
    expect(fs.existsSync(env.paths.daemonJson)).toBe(false);
    expect(fs.existsSync(env.paths.lock)).toBe(false);
  });
});
