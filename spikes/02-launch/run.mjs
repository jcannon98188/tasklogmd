// Spike 2 (V1): launch an npm-global .cmd shim from Claude Code as an MCP server on Windows.
// Usage: node spikes/02-launch/run.mjs   (uses stub name tasklogspike2 / MCP server spike2)
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stub = resolve(here, 'stub');
const BIN = 'tasklogspike2', SRV = 'spike2', PORT = 39217;
const LOG = join(tmpdir(), 'tasklogspike2.log');
const sh = (cmd) => spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 180000 });
const results = {};

function killDaemon() {
  const r = sh(`netstat -ano -p tcp`);
  for (const l of (r.stdout || '').split('\n'))
    if (l.includes(`127.0.0.1:${PORT}`) && l.includes('LISTENING')) {
      const pid = l.trim().split(/\s+/).pop();
      sh(`taskkill /F /PID ${pid}`);
    }
}

function attempt(label, addArgs) {
  sh(`claude mcp remove --scope user ${SRV}`);
  killDaemon();
  if (existsSync(LOG)) unlinkSync(LOG);
  const add = sh(`claude mcp add --scope user ${SRV} -- ${addArgs}`);
  console.log(`[${label}] add: ${add.status} ${add.stdout.trim()} ${add.stderr.trim()}`);
  const t0 = Date.now();
  const run = sh(`claude -p "Call the ping tool from the ${SRV} MCP server and reply with exactly the text it returns." --allowedTools "mcp__${SRV}__ping" --output-format json`);
  const ms = Date.now() - t0;
  const out = (run.stdout || '') + (run.stderr || '');
  const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '(no log: shim never ran)';
  const ok = out.includes('PONG-SPIKE2-7731');
  results[label] = { ok, headlessTotalMs: ms };
  console.log(`[${label}] ok=${ok} totalMs=${ms}\n--- shim log ---\n${log}\n--- claude out (truncated) ---\n${out.slice(0, 1500)}\n`);
  const lines = log.trim().split('\n');
  const ts = (k) => Number((lines.find((l) => l.includes(k)) || '').split(' ')[0]) || null;
  if (ts('shim start') && ts('healthy')) results[label].coldStartToHealthyMs = ts('healthy') - ts('shim start');
  return ok;
}

try {
  const inst = sh(`npm i -g "${stub}"`);
  console.log('npm i -g:', inst.status, inst.stderr.trim().slice(-300));
  const where = sh(`where ${BIN}`).stdout;
  console.log('where:', where.trim());
  results.shimFiles = where.trim().split(/\r?\n/);
  if (!attempt('bare', `${BIN} shim`)) attempt('cmd-c', `cmd /c ${BIN} shim`);
} finally {
  sh(`claude mcp remove --scope user ${SRV}`);
  killDaemon();
  const un = sh(`npm uninstall -g ${BIN}`);
  console.log('cleanup uninstall:', un.status);
  console.log('RESULTS', JSON.stringify(results, null, 2));
}
