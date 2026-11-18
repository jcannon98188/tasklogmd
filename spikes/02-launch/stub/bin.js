#!/usr/bin/env node
// Stub for `tasklog shim`: a stdio MCP server that cold-starts a detached stub daemon first.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import readline from 'node:readline';

const PORT = 39217;
const LOG = join(tmpdir(), 'tasklogspike2.log');
const log = (m) => appendFileSync(LOG, `${Date.now()} ${m}\n`);
const here = dirname(fileURLToPath(import.meta.url));

if (process.argv[2] === 'daemon') {
  http.createServer((_, res) => res.end('ok')).listen(PORT, '127.0.0.1');
  log('daemon listening');
} else {
  log(`shim start argv=${process.argv.slice(2).join(' ')}`);
  const health = () =>
    new Promise((r) => {
      const q = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => { res.resume(); r(true); });
      q.on('error', (e) => { if (!globalThis.__e) { globalThis.__e = 1; log(`probe error: ${e.code} ${e.message}`); } r(false); });
    });
  let ready = (async () => {
    if (!(await health())) {
      const c = spawn(process.execPath, [join(here, 'bin.js'), 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
      log('spawned daemon');
      for (let i = 0; i < 100; i++) {
        const t = Date.now();
        const ok = await health();
        log(`probe ${i} ok=${ok} took=${Date.now() - t}ms`);
        if (ok) { log('healthy'); return; }
        await new Promise((r) => setTimeout(r, 100));
      }
      log('UNHEALTHY (gave up)');
      return;
    }
    log('healthy (daemon already up)');
  })();
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'initialize') {
      await ready; // handshake only completes once the daemon is healthy
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tasklogspike2', version: '0.0.1' } } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'Returns the magic word', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'PONG-SPIKE2-7731' }] } });
    } else if (m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  });
  rl.on('close', () => process.exit(0));
}
