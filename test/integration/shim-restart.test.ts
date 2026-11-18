import net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDaemon, probeDaemon } from '../../src/client.ts';
import type { RunningDaemon } from '../../src/daemon/core.ts';
import { runShim } from '../../src/shim.ts';
import { makeEnv, mkWorkspace, sleep, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

/** Holds an unfinished request open, so the daemon's drain (shutdown) cannot complete until it is released. */
function holdRequest(d: RunningDaemon): net.Socket {
  const s = net.connect(d.port, '127.0.0.1');
  s.on('error', () => {});
  s.write(
    `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nAuthorization: Bearer ${d.token}\r\nX-TaskLog-Protocol: 1\r\n` +
      `Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`,
  );
  return s;
}

describe('restart while the old daemon drains', () => {
  it('ensureDaemon waits for a draining daemon to exit instead of reusing it or racing its lock', async () => {
    const a = await env.start();
    const held = holdRequest(a);
    await sleep(100);
    const draining = a.shutdown('test');
    await sleep(100);
    setTimeout(() => held.destroy(), 400);
    let b: RunningDaemon | undefined;
    const r = await ensureDaemon({
      paths: env.paths,
      log: env.log,
      spawn: () => void env.start().then((d) => (b = d)),
    });
    await draining;
    expect(r.action).toBe('spawned');
    expect(r.probe.health.pid).toBe(r.probe.state.pid);
    expect(r.probe.state.port).not.toBe(a.port);
    expect(b?.port).toBe(r.probe.state.port);
  });

  it('the shim retries a request that hit a draining daemon against a respawned one', async () => {
    const ws = mkWorkspace(env.root);
    const a = await env.start();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = [];
    let buf = '';
    output.on('data', (c) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (l.trim()) lines.push(JSON.parse(l));
      }
    });
    const done = runShim({
      input,
      output,
      cwd: ws,
      workspace: ws,
      paths: env.paths,
      log: env.log,
      spawn: () => void env.start(),
    });
    const waitFor = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const m = lines.find((l) => l.id === id);
        if (m) return m;
        await sleep(50);
      }
      throw new Error(`no reply to ${id}`);
    };
    const call = (id: number) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n');

    call(1);
    expect((await waitFor(1)).result.tools.length).toBeGreaterThan(0);

    const held = holdRequest(a);
    await sleep(100);
    const draining = a.shutdown('test');
    await sleep(100);
    setTimeout(() => held.destroy(), 400);
    call(2);
    const second = await waitFor(2);
    expect(second.error).toBeUndefined();
    expect(second.result.tools.length).toBeGreaterThan(0);
    await draining;
    const p = await probeDaemon(env.paths);
    expect(p?.state.port).not.toBe(a.port);

    input.end();
    await done;
  });
});
