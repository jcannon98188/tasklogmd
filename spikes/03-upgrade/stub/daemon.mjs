// Stub daemon, one ESM file. __VERSION__ and __PROTOCOL__ are substituted at build time.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = '__VERSION__';
const PROTOCOL = __PROTOCOL__;
const home = process.env.TASKLOGSPIKE3_HOME;
const token = crypto.randomBytes(32).toString('hex');
const stateFile = path.join(home, 'daemon.json');
const log = (m) => fs.appendFileSync(path.join(home, `daemon-${VERSION}-${process.pid}.log`), `${new Date().toISOString()} ${m}\n`);
const started = Date.now();
let inflight = 0;
let draining = false;

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
  if (draining) return send(503, { error: 'shutting_down' });
  inflight++;
  try {
    if (req.url === '/health') return send(200, { ok: true, version: VERSION, protocol: PROTOCOL, pid: process.pid, uptime: Date.now() - started });
    if (req.url === '/echo') return send(200, { echo: 'pong', version: VERSION, pid: process.pid });
    if (req.url === '/slow') { await new Promise((r) => setTimeout(r, 1500)); return send(200, { slow: 'done', pid: process.pid }); }
    if (req.url === '/lazy') {
      // Simulates an unbundled daemon lazy-loading a sibling file after an upgrade replaced it.
      const m = await import('./lazy.mjs');
      return send(200, { lazy: m.default });
    }
    if (req.url === '/shutdown') {
      draining = true;
      send(200, { draining: true });
      inflight--; // this request itself
      const wait = setInterval(() => {
        if (inflight > 0) return;
        clearInterval(wait);
        try {
          const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (cur.pid === process.pid) fs.rmSync(stateFile);
        } catch {}
        log('drained, exiting');
        server.close();
        process.exit(0);
      }, 50);
      return;
    }
    send(404, { error: 'not_found' });
  } catch (e) {
    log(`error ${req.url}: ${e.code ?? ''} ${e.message}`);
    send(500, { error: String(e.code ?? e.message) });
  } finally {
    if (req.url !== '/shutdown') inflight--;
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, token, version: VERSION, protocol: PROTOCOL }));
  fs.renameSync(tmp, stateFile);
  log(`listening on ${port}, cwd ${process.cwd()}`);
});
