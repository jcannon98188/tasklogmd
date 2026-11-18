import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_TABLE, logTaskLogError, TaskLogError, type ErrorCode } from '../../src/errors.ts';
import { createLogger, daemonLoggerOptions, parseLevel, rotate, shimLoggerOptions } from '../../src/log.ts';
import { copyFixture, makeEnv, mkWorkspace, tmpDir, rmDir, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const lines = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>)
    : [];

async function mcp(d: { port: number; token: string }, root: string | undefined, name: string, args: object = {}) {
  const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${d.token}`,
      'x-tasklog-protocol': '1',
      ...(root ? { 'x-tasklog-workspace': root } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await res.json()) as { result: { isError?: boolean; structuredContent: any } }).result;
}

describe('one error table feeds MCP errors, HTTP errors and log entries', () => {
  const classes: Record<string, ErrorCode[]> = {
    info: ['stale_hash', 'stale_cursor', 'not_found', 'already_claimed', 'not_claimed', 'bad_transition', 'bad_request', 'indexing', 'shutting_down', 'unauthorized', 'protocol_mismatch', 'no_workspace'],
    warn: ['conflicted', 'invalid_item', 'partial'],
    error: ['internal'],
  };

  it('logs every code with its table code, message and retryable at the level of its class', () => {
    const file = path.join(env.root, 'table.log');
    const log = createLogger({ file });
    for (const [level, codes] of Object.entries(classes)) {
      for (const code of codes) {
        const te = new TaskLogError(code);
        logTaskLogError(log, te, { requestId: 'r1', via: 'http' });
        const entry = lines(file).at(-1)!;
        expect(entry, code).toMatchObject({ level, event: 'request.error', code, message: te.message, retryable: ERROR_TABLE[code].retryable });
      }
    }
    expect(Object.values(classes).flat().sort()).toEqual(Object.keys(ERROR_TABLE).sort());
  });

  it('an MCP tool error and its log entry agree on code, message and retryable', async () => {
    const root = copyFixture('duplicate-ids', env.root);
    const d = await env.start();
    const r = await mcp(d, root, 'get_item', { id: 'dup/03' });
    const err = r.structuredContent.error;
    expect(err.code).toBe('conflicted');
    const entry = lines(env.paths.daemonLog).find((l) => l.event === 'request.error' && l.code === 'conflicted')!;
    expect(entry).toMatchObject({ level: 'warn', message: err.message, retryable: err.retryable, via: 'mcp', workspace: expect.any(String) });
  });

  it('an HTTP management error and its log entry agree, with no stray fields in the envelope', async () => {
    const d = await env.start();
    const res = await fetch(`http://127.0.0.1:${d.port}/workspaces`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${d.token}`, 'x-tasklog-protocol': '1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string; retryable: boolean } };
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'retryable']);
    const entry = lines(env.paths.daemonLog).find((l) => l.event === 'request.error' && l.code === 'bad_request')!;
    expect(entry).toMatchObject({ level: 'info', message: error.message, retryable: error.retryable, via: 'http' });

    const unauth = await fetch(`http://127.0.0.1:${d.port}/health`, { headers: { authorization: 'Bearer nope' } });
    expect(unauth.status).toBe(401);
    expect(lines(env.paths.daemonLog).some((l) => l.event === 'request.error' && l.code === 'unauthorized' && l.level === 'info')).toBe(true);
  });

  it('an unexpected exception is internal with a request_id that appears in daemon.log', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    d.models.ready = () => Promise.reject(new Error('kaboom'));
    const r = await mcp(d, root, 'list_items');
    const err = r.structuredContent.error;
    expect(err.code).toBe('internal');
    expect(err.details.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(err)).not.toContain('kaboom');
    const entry = lines(env.paths.daemonLog).find((l) => l.request_id === err.details.request_id)!;
    expect(entry).toMatchObject({ level: 'error', code: 'internal', error: 'kaboom' });
  });

  it('invalid tool arguments surface as bad_request', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const r = await mcp(d, root, 'list_items', { kind: 'nonsense' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('bad_request');
  });
});

describe('workspace_status problems[] and recent_events[]', () => {
  it('lists an invalid item and a conflict with path, error and start time', async () => {
    const root = copyFixture('invalid', env.root);
    const dup = copyFixture('duplicate-ids', env.root);
    const d = await env.start();
    const bad = (await mcp(d, root, 'workspace_status')).structuredContent;
    expect(bad.problems[0]).toMatchObject({ type: 'invalid', path: expect.stringContaining('.tasklog/gamma/tickets/'), error: expect.any(String) });
    expect(bad.problems[0].since).toMatch(/^\d{4}-\d\d-\d\dT/);
    const conflict = (await mcp(d, dup, 'workspace_status')).structuredContent;
    expect(conflict.problems).toHaveLength(1);
    expect(conflict.problems[0]).toMatchObject({ type: 'conflicted', path: expect.stringContaining('.tasklog/dup/tickets/03-'), error: expect.any(String), since: expect.any(String) });
    expect(conflict.problems[0].paths).toHaveLength(2);
    // The warn events that went with them are in recent_events, per workspace.
    expect(bad.recent_events.some((e: any) => e.event === 'item.invalid')).toBe(true);
    expect(bad.recent_events.every((e: any) => e.workspace === bad.root)).toBe(true);
  });

  it('returns the latest 50 warn/error events for that workspace only, from memory', async () => {
    const root = mkWorkspace(env.root, 'noisy');
    const other = mkWorkspace(env.root, 'quiet');
    const d = await env.start();
    const canonical = (await mcp(d, root, 'workspace_status')).structuredContent.root as string;
    const quiet = (await mcp(d, other, 'workspace_status')).structuredContent.root as string;
    for (let i = 0; i < 70; i++) env.log.warn('test.noise', { workspace: canonical, i });
    for (let i = 0; i < 80; i++) env.log.warn('test.other', { workspace: quiet, i });
    const ev = (await mcp(d, root, 'workspace_status')).structuredContent.recent_events;
    expect(ev).toHaveLength(50);
    expect(ev.at(-1)).toMatchObject({ event: 'test.noise', i: 69 });
    expect(ev[0]).toMatchObject({ i: 20 });
    expect(ev.every((e: any) => e.workspace === canonical)).toBe(true);
  });
});

describe('logging content', () => {
  it('logs a successful write as item.write with id, operation and hash, never content or the token', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const got = (await mcp(d, root, 'get_item', { id: 'alpha/03' })).structuredContent;
    const secret = 'SECRET-BODY-TEXT-xyzzy';
    const r = await mcp(d, root, 'append_to_section', { id: 'alpha/03', hash: got.hash, heading: 'Comments', content: secret });
    expect(r.isError).toBeFalsy();
    const raw = fs.readFileSync(env.paths.daemonLog, 'utf8');
    const w = lines(env.paths.daemonLog).find((l) => l.event === 'item.write' && l.id === 'alpha/03')!;
    expect(w).toMatchObject({ level: 'info', operation: expect.any(String), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Object.keys(w).sort()).toEqual(['event', 'hash', 'id', 'level', 'operation', 'ts', 'workspace']);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(d.token);
  });

  it('writes JSON lines with ts, level and a dotted event, and defaults to info', () => {
    const file = path.join(env.root, 'lvl.log');
    const log = createLogger({ file, level: parseLevel(undefined) });
    log.debug('scan.detail');
    log.info('scan.finished', { workspace: 'w' });
    const out = lines(file);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'info', event: 'scan.finished', workspace: 'w' });
    expect(Date.parse(out[0]!.ts)).not.toBeNaN();
  });

  it('TASKLOG_LOG_LEVEL and --verbose raise the level to debug', () => {
    expect(parseLevel('debug')).toBe('debug');
    expect(parseLevel('bogus')).toBe('info');
    const file = path.join(env.root, 'dbg.log');
    createLogger({ file, level: parseLevel('debug') }).debug('watch.suppressed');
    expect(lines(file)).toHaveLength(1);
  });
});

describe('log rotation', () => {
  it('rotates daemon.log at 5 MB keeping three files', () => {
    expect(daemonLoggerOptions).toEqual({ maxBytes: 5 * 1024 * 1024, keep: 3 });
    const file = path.join(env.root, 'daemon.log');
    const log = createLogger({ file, maxBytes: 400, keep: 3 });
    for (let i = 0; i < 40; i++) log.info('x.y', { i, pad: 'p'.repeat(40) });
    const files = fs.readdirSync(env.root).filter((f) => f.startsWith('daemon.log')).sort();
    expect(files).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    // the newest entry is in the live file, older ones in the backups
    expect(lines(file).at(-1)!.i).toBe(39);
    expect(lines(`${file}.1`).at(-1)!.i).toBeLessThan(lines(file)[0]!.i);
  });

  it('rotates an oversized daemon.log at start', () => {
    const file = path.join(env.root, 'daemon.log');
    fs.writeFileSync(file, 'x'.repeat(500));
    createLogger({ file, maxBytes: 400, keep: 3 }).info('daemon.start');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(500));
    expect(lines(file)).toHaveLength(1);
  });

  it('rotates shim.log once at start keeping one backup, and not on write', () => {
    expect(shimLoggerOptions).toEqual({ maxBytes: 1024 * 1024, keep: 2, rotateOnWrite: false });
    const file = path.join(env.root, 'shim.log');
    fs.writeFileSync(file, 'a'.repeat(300));
    fs.writeFileSync(`${file}.1`, 'old');
    const log = createLogger({ file, maxBytes: 200, keep: 2, rotateOnWrite: false });
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('a'.repeat(300));
    for (let i = 0; i < 20; i++) log.info('shim.spawn', { i });
    expect(fs.readdirSync(env.root).filter((f) => f.startsWith('shim.log'))).toEqual(['shim.log', 'shim.log.1']);
    expect(lines(file).length).toBe(20);
  });

  it('ignores a failed rename', () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'shim.log');
      fs.writeFileSync(file, 'a'.repeat(300));
      fs.mkdirSync(`${file}.1`); // a directory cannot be replaced by renaming a file onto it
      fs.writeFileSync(path.join(`${file}.1`, 'keep'), 'x');
      expect(() => rotate(file, 2)).not.toThrow();
      const log = createLogger({ file, maxBytes: 200, keep: 2, rotateOnWrite: false });
      expect(() => log.info('shim.spawn')).not.toThrow();
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      rmDir(dir);
    }
  });
});
