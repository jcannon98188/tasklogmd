// Stub stdio MCP shim: finds or spawns the stub daemon, proxies a `ping` tool. Throwaway spike code.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.SPIKE1_STATE;
const daemonScript = path.join(here, 'daemon.mjs');
const stateFile = path.join(stateDir, 'daemon.json');
const log = (event, extra = {}) =>
  fs.appendFileSync(path.join(stateDir, 'shim.log'), JSON.stringify({ t: Date.now(), pid: process.pid, event, ...extra }) + '\n');

const approach = () => {
  try { return fs.readFileSync(path.join(stateDir, 'approach.txt'), 'utf8').trim(); } catch { return 'spawn'; }
};

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

function health(st) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: st.port, path: '/health', headers: { authorization: `Bearer ${st.token}` }, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function launchDaemon() {
  const a = approach();
  const env = { ...process.env, SPIKE1_STATE: stateDir };
  log('spawn', { approach: a });
  if (a === 'spawn') {
    const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
  } else if (a === 'cmdstart') {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, daemonScript], { stdio: 'ignore', windowsHide: true, env });
    child.unref();
  } else if (a === 'schtask') {
    const name = 'spike1-daemon';
    // Env travels via a wrapper command line because a scheduled task does not inherit it.
    const tr = `cmd.exe /d /c set "SPIKE1_STATE=${stateDir}" && "${process.execPath}" "${daemonScript}"`;
    execFileSync('schtasks', ['/create', '/tn', name, '/tr', tr, '/sc', 'once', '/st', '00:00', '/f'], { stdio: 'ignore', windowsHide: true });
    execFileSync('schtasks', ['/run', '/tn', name], { stdio: 'ignore', windowsHide: true });
  }
}

let daemonReady = null;
function ensureDaemon() {
  if (daemonReady) return daemonReady;
  daemonReady = (async () => {
    const st = readState();
    if (st) {
      const h = await health(st);
      if (h) { log('reuse', { daemonPid: h.pid }); return st; }
      log('stale-state', { pid: st.pid });
      try { fs.rmSync(stateFile); } catch {}
    }
    launchDaemon();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const s2 = readState();
      if (s2 && (await health(s2))) { log('daemon-healthy', { daemonPid: s2.pid }); return s2; }
    }
    throw new Error('daemon did not become healthy');
  })();
  return daemonReady;
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const text = (s) => ({ content: [{ type: 'text', text: s }] });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spike1-shim', version: '0.0.0' } } });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [
      { name: 'ping', description: 'Ping the stub daemon and return its pid.', inputSchema: { type: 'object', properties: {} } },
      { name: 'slow', description: 'Ping the stub daemon, then block for 90 seconds.', inputSchema: { type: 'object', properties: {} } },
    ] } });
  } else if (method === 'tools/call') {
    try {
      const st = await ensureDaemon();
      const h = await health(st);
      log('tool', { name: params.name, daemonPid: h?.pid });
      if (params.name === 'slow') await new Promise((r) => setTimeout(r, 90000));
      send({ id, result: text(`daemon pid ${h?.pid}`) });
    } catch (e) {
      send({ id, result: { ...text(`error: ${e.message}`), isError: true } });
    }
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: 'method not found' } });
  }
}

log('shim-start');
ensureDaemon().catch((e) => log('ensure-failed', { message: e.message }));

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => { log('stdin-closed'); process.exit(0); });
