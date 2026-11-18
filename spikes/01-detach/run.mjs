// Spike 1 driver: `node spikes/01-detach/run.mjs [--only spawn|cmdstart|schtask]`
// Registers a stub shim with the real Claude Code, then checks whether the shim-spawned stub daemon
// survives (1) normal exit, (2) taskkill /T /F, (5) closing the launching terminal, plus
// (3) second-session reuse and (4) no console window. Throwaway code; cleans up after itself.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = 'spike1-shim'; // unique name; never touch anything called `tasklog`
const TASK = 'spike1-daemon';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike1-'));
const logPath = (n) => path.join(stateDir, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJsonl = (n) => { try { return fs.readFileSync(logPath(n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readState = () => { try { return JSON.parse(fs.readFileSync(logPath('daemon.json'), 'utf8')); } catch { return null; } };
async function waitFor(fn, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); } return fn(); }

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const approaches = only ? [only] : ['spawn', 'cmdstart', 'schtask'];
const toolArgs = ['--model', 'haiku', '--allowedTools', `mcp__${SERVER}__ping,mcp__${SERVER}__slow`, '--no-session-persistence'];
const prompt = (tool) => `Call the MCP tool ${tool} from the ${SERVER} server exactly once, then reply with only its result.`;

function killDaemon() {
  const st = readState();
  if (st && alive(st.pid)) spawnSync('taskkill', ['/F', '/PID', String(st.pid)], { stdio: 'ignore' });
  spawnSync('schtasks', ['/delete', '/tn', TASK, '/f'], { stdio: 'ignore' });
  try { fs.rmSync(logPath('daemon.json')); } catch {}
}
function startClaude(tool) {
  const p = spawn('claude', ['-p', prompt(tool), ...toolArgs], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, SPIKE1_STATE: stateDir } });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (p.out += d));
  p.done = new Promise((r) => p.on('exit', r));
  return p;
}
const toolCalled = (name) => readJsonl('shim.log').some((e) => e.event === 'tool' && e.name === name);
const spawnCount = () => readJsonl('shim.log').filter((e) => e.event === 'spawn').length;

function startWatcher() {
  const out = logPath('windows.log');
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'windows.ps1'), '-Mode', 'watch', '-OutFile', out, '-Seconds', '300'], { stdio: 'ignore', windowsHide: true });
  return { p, out };
}

async function runApproach(approach) {
  const r = { approach, points: {}, notes: [] };
  fs.writeFileSync(logPath('approach.txt'), approach);
  fs.rmSync(logPath('shim.log'), { force: true });
  killDaemon();

  const watcher = startWatcher();
  await waitFor(() => fs.existsSync(watcher.out), 15000);
  await sleep(500);

  // 1. normal exit
  const c1 = startClaude('ping');
  await c1.done;
  await sleep(1500);
  const st1 = readState();
  r.points['1 normal exit'] = !!(toolCalled('ping') && st1 && alive(st1.pid));
  if (!toolCalled('ping')) r.notes.push('session 1 never called ping: ' + c1.out.slice(0, 300));

  // 3. second session reuses the daemon
  const spawnsBefore = spawnCount();
  const c3 = startClaude('ping');
  await c3.done;
  const ev = readJsonl('shim.log');
  const last = ev.filter((e) => e.event === 'shim-start').pop();
  const reused = ev.some((e) => e.event === 'reuse' && e.pid === last?.pid);
  const st3 = readState();
  r.points['3 second session reuses daemon'] = !!(reused && spawnCount() === spawnsBefore && st1 && st3 && st3.pid === st1.pid && toolCalled('ping'));

  // 2. taskkill /T /F of the whole Claude Code tree, mid-session, with a freshly spawned daemon
  killDaemon();
  await sleep(500);
  const shimsBefore = readJsonl('shim.log').filter((e) => e.event === 'tool' && e.name === 'slow').length;
  const c2 = startClaude('slow');
  const called = await waitFor(() => readJsonl('shim.log').filter((e) => e.event === 'tool' && e.name === 'slow').length > shimsBefore, 90000);
  if (called) {
    const stK = readState();
    const shimPid = readJsonl('shim.log').filter((e) => e.event === 'shim-start').pop().pid;
    spawnSync('taskkill', ['/T', '/F', '/PID', String(c2.pid)], { stdio: 'ignore' });
    await sleep(2500);
    r.points['2 taskkill /T /F'] = !!(stK && alive(stK.pid) && !alive(shimPid) && !alive(c2.pid));
    r.notes.push(`tree kill: daemon alive=${!!(stK && alive(stK.pid))}, shim alive=${alive(shimPid)}, claude alive=${alive(c2.pid)}`);
  } else {
    r.points['2 taskkill /T /F'] = false;
    r.notes.push('session 2 never reached slow tool: ' + c2.out.slice(0, 300));
  }

  // 4. window enumeration over the two cold-start spawns above
  await sleep(500);
  watcher.p.kill();
  const lines = fs.readFileSync(watcher.out, 'utf8').split('\n').filter((l) => l.startsWith('NEW|'));
  const daemonPids = new Set(readJsonl('daemon.log').map((e) => e.pid));
  const suspicious = lines.filter((l) => {
    const f = l.split('|');
    return daemonPids.has(Number(f[3])) || /ConsoleWindowClass|PseudoConsoleWindow|CASCADIA/i.test(f[4]) || /^(conhost|cmd|node|OpenConsole|WindowsTerminal|powershell)$/i.test(f[6] ?? '');
  });
  r.points['4 no console window at spawn'] = suspicious.length === 0;
  if (suspicious.length) r.notes.push('windows seen: ' + suspicious.join(' ;; '));
  r.notes.push(`window watcher saw ${lines.length} new visible windows total`);

  // 5. close the launching terminal programmatically (WM_CLOSE on its window, like the X button)
  killDaemon();
  await sleep(500);
  fs.writeFileSync(logPath('term.cmd'), ['@echo off', 'title spike1term', `claude -p "${prompt('slow')}" ${toolArgs.join(' ')}`, ''].join('\r\n'));
  const slowBefore = readJsonl('shim.log').filter((e) => e.event === 'tool' && e.name === 'slow').length;
  const ps = (...a) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'windows.ps1'), ...a], { encoding: 'utf8' }).stdout.trim();
  const baseline = ps('-Mode', 'list');
  const term = spawn('cmd.exe', ['/d', '/k', logPath('term.cmd')], { detached: true, stdio: 'ignore', env: { ...process.env, SPIKE1_STATE: stateDir, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' } });
  term.unref();
  const called5 = await waitFor(() => readJsonl('shim.log').filter((e) => e.event === 'tool' && e.name === 'slow').length > slowBefore, 90000);
  if (called5) {
    const st5 = readState();
    const shimPid5 = readJsonl('shim.log').filter((e) => e.event === 'shim-start').pop().pid;
    const out = ps('-Mode', 'close', '-Title', 'spike1term', '-Exclude', baseline);
    r.notes.push('terminal close: ' + out.replace(/\r?\n/g, ' / '));
    await sleep(8000);
    const closed = !alive(term.pid) || !alive(shimPid5);
    if (out.includes('no-window-found') || !closed) {
      r.points['5 terminal closed'] = 'unverified';
      r.notes.push('could not close the terminal window or the shim outlived it');
      if (alive(term.pid)) spawnSync('taskkill', ['/T', '/F', '/PID', String(term.pid)], { stdio: 'ignore' });
    } else {
      r.points['5 terminal closed'] = !!(st5 && alive(st5.pid));
    }
  } else {
    r.points['5 terminal closed'] = 'unverified';
    r.notes.push('terminal session never reached slow tool');
    spawnSync('taskkill', ['/T', '/F', '/PID', String(term.pid)], { stdio: 'ignore' });
  }
  return r;
}

function cleanup() {
  killDaemon();
  spawnSync('claude', ['mcp', 'remove', '-s', 'user', SERVER], { stdio: 'ignore', windowsHide: true });
}

const results = [];
try {
  spawnSync('claude', ['mcp', 'remove', '-s', 'user', SERVER], { stdio: 'ignore', windowsHide: true });
  const add = spawnSync('claude', ['mcp', 'add', '-s', 'user', SERVER, '-e', `SPIKE1_STATE=${stateDir}`, '--', process.execPath, path.join(here, 'shim.mjs')], { encoding: 'utf8' });
  if (add.status !== 0) throw new Error('claude mcp add failed: ' + add.stdout + add.stderr);

  for (const a of approaches) {
    const r = await runApproach(a);
    results.push(r);
    const survival = ['1 normal exit', '2 taskkill /T /F', '5 terminal closed'].map((k) => r.points[k]);
    console.log(`\n=== approach: ${a} ===`);
    for (const [k, v] of Object.entries(r.points)) console.log(`  ${v === true ? 'PASS' : v === false ? 'FAIL' : 'UNVERIFIED'}  ${k}`);
    for (const n of r.notes) console.log('  note: ' + n);
    if (survival.every((v) => v === true)) { r.winner = true; break; }
  }
} finally {
  cleanup();
}
const winner = results.find((r) => r.winner);
console.log('\nWinner: ' + (winner ? winner.approach : 'NONE (reopen architecture)'));
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify({ date: new Date().toISOString(), claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), winner: winner?.approach ?? null, results }, null, 2));
fs.rmSync(stateDir, { recursive: true, force: true });
process.exit(winner ? 0 : 1);
