#!/usr/bin/env node
// Stub shim/CLI, one ESM file. `tasklogspike3 ping` ensures a compatible daemon and queries it.
// Implements spec section 2 versioning: newer shim restarts an older daemon; older shim errors, never restarts.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '__VERSION__';
const PROTOCOL = __PROTOCOL__;
const home = process.env.TASKLOGSPIKE3_HOME;
const stateFile = path.join(home, 'daemon.json');
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
async function call(state, p) {
  const r = await fetch(`http://127.0.0.1:${state.port}${p}`, { headers: { authorization: `Bearer ${state.token}`, 'x-tasklog-protocol': String(PROTOCOL) }, signal: AbortSignal.timeout(3000) });
  return { status: r.status, body: await r.json() };
}
async function health() {
  const s = readState();
  if (!s) return null;
  try { const r = await call(s, '/health'); return r.status === 200 ? { state: s, h: r.body } : null; } catch { return null; }
}
function spawnDaemon() {
  const cwd = process.env.SPIKE_DAEMON_CWD === 'pkg' ? path.resolve(here, '..') : process.cwd();
  spawn(process.execPath, [path.join(here, 'daemon.mjs')], { detached: true, stdio: 'ignore', windowsHide: true, cwd, env: process.env }).unref();
}
async function waitHealthy(notPid) {
  for (let i = 0; i < 100; i++) {
    const x = await health();
    if (x && x.h.pid !== notPid) return x;
    await sleep(100);
  }
  return null;
}
const out = (o, code = 0) => { console.log(JSON.stringify({ shimVersion: VERSION, shimProtocol: PROTOCOL, ...o })); process.exit(code); };

async function ensure() {
  let x = await health();
  if (!x) { spawnDaemon(); x = await waitHealthy(); if (!x) out({ error: 'spawn_failed' }, 2); return { x, action: 'spawned' }; }
  if (x.h.protocol === PROTOCOL) return { x, action: 'reused' };
  if (x.h.protocol > PROTOCOL) out({ error: 'daemon_newer_than_shim', daemonProtocol: x.h.protocol, daemonVersion: x.h.version, daemonPid: x.h.pid, action: 'none' }, 3);
  // Daemon older: ask it to drain and exit, then respawn.
  const oldPid = x.h.pid;
  await call(x.state, '/shutdown');
  for (let i = 0; i < 100; i++) { try { process.kill(oldPid, 0); await sleep(100); } catch { break; } }
  spawnDaemon();
  const y = await waitHealthy(oldPid);
  if (!y) out({ error: 'respawn_failed', oldPid }, 2);
  return { x: y, action: 'restarted', oldPid };
}

const cmd = process.argv[2];
if (cmd === 'ping') {
  const { x, action, oldPid } = await ensure();
  const e = await call(x.state, '/echo');
  out({ action, oldPid, daemonPid: x.h.pid, daemonVersion: x.h.version, daemonProtocol: x.h.protocol, echo: e.body.echo });
} else if (cmd === 'stop') {
  const x = await health();
  if (x) await call(x.state, '/shutdown');
  out({ stopped: !!x });
} else out({ error: 'usage: tasklogspike3 ping|stop' }, 1);
