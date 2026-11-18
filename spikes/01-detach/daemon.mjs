// Stub daemon: loopback HTTP server + daemon.json state file. Throwaway spike code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const stateDir = process.env.SPIKE1_STATE;
const token = crypto.randomBytes(32).toString('hex');
const started = Date.now();
const log = (event, extra = {}) =>
  fs.appendFileSync(path.join(stateDir, 'daemon.log'), JSON.stringify({ t: Date.now(), pid: process.pid, event, ...extra }) + '\n');

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid, uptime: Date.now() - started }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const tmp = path.join(stateDir, 'daemon.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, token }));
  fs.renameSync(tmp, path.join(stateDir, 'daemon.json'));
  log('started', { port });
});

// Safety net so a failed cleanup cannot leave the stub running forever.
setTimeout(() => { log('safety-exit'); process.exit(0); }, 15 * 60 * 1000);
