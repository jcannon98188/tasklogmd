// Spike 3 runner. Usage: node spikes/03-upgrade/run.mjs
// Real `npm i -g` of a stub package `tasklogspike3` (v1 = protocol 1, v2 = protocol 2). Cleans up always.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tlspike3-'));
const NAME = 'tasklogspike3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const note = (k, v) => { results.push([k, v]); console.log(`[${k}]`, typeof v === 'string' ? v : JSON.stringify(v)); };

function sh(cmd, env = {}) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, cwd: work });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function build(version, protocol, withLazy) {
  const dir = path.join(work, `pkg-${version}`, 'package');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const sub = (f) => fs.readFileSync(path.join(here, 'stub', f), 'utf8').replaceAll('__VERSION__', version).replaceAll('__PROTOCOL__', String(protocol));
  fs.writeFileSync(path.join(dir, 'dist', 'daemon.mjs'), sub('daemon.mjs'));
  fs.writeFileSync(path.join(dir, 'dist', 'shim.mjs'), sub('shim.mjs'));
  if (withLazy) fs.writeFileSync(path.join(dir, 'dist', 'lazy.mjs'), sub('lazy.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: NAME, version, type: 'module', bin: { [NAME]: 'dist/shim.mjs' }, files: ['dist'], engines: { node: '>=24' } }, null, 2));
  const packed = sh(`npm pack "${dir}" --pack-destination "${work}"`);
  if (packed.code) throw new Error('pack failed ' + packed.stderr);
  return path.join(work, `${NAME}-${version}.tgz`);
}

const globalRoot = sh('npm root -g').stdout.trim();
const pkgDir = path.join(globalRoot, NAME);
const pids = new Set();

async function readState(home) { try { return JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')); } catch { return null; } }
async function q(home, p, expectedState) {
  const s = expectedState ?? (await readState(home));
  if (!s) return { error: 'no daemon.json' };
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { headers: { authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(3000) });
    return { status: r.status, body: await r.json() };
  } catch (e) { return { error: String(e.cause?.code ?? e.message) }; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function shim(home, args, env = {}) {
  const r = sh(`${NAME} ${args}`, { TASKLOGSPIKE3_HOME: home, ...env });
  let j = null; try { j = JSON.parse(r.stdout.trim()); } catch {}
  if (j?.daemonPid) pids.add(j.daemonPid);
  return { code: r.code, json: j, stderr: r.stderr.trim().slice(0, 300) };
}

async function scenario(label, daemonCwd, tgz1, tgz2) {
  console.log(`\n===== scenario ${label} =====`);
  const home = path.join(work, `home-${label}`);
  fs.mkdirSync(home, { recursive: true });
  const env = { SPIKE_DAEMON_CWD: daemonCwd };
  const k = (s) => `${label}: ${s}`;

  const i1 = sh(`npm i -g "${tgz1}"`);
  note(k('install v1'), { code: i1.code, stderr: i1.stderr.slice(0, 300) });
  if (i1.code) return;

  const p1 = shim(home, 'ping', env);
  note(k('v1 shim ping (spawn daemon)'), p1);
  const oldPid = p1.json?.daemonPid;
  const oldState = await readState(home);
  // Do NOT call /lazy before the upgrade: it would cache the module and hide the lazy-load failure.

  // Poll the old daemon during the install to see whether it keeps serving.
  const polls = [];
  let polling = true;
  const poller = (async () => { while (polling) { const r = await q(home, '/echo', oldState); polls.push(r.error ? `ERR:${r.error}` : r.status); await sleep(150); } })();
  const i2 = sh(`npm i -g "${tgz2}"`);
  polling = false; await poller;
  note(k('install v2 over running v1 daemon'), { code: i2.code, stdout: i2.stdout.trim().slice(0, 300), stderr: i2.stderr.slice(0, 1500) });
  note(k('polls during install'), { n: polls.length, distinct: [...new Set(polls)] });
  note(k('installed version after'), (() => { try { return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version; } catch (e) { return 'unreadable: ' + e.code; } })());
  note(k('installed dist files after'), (() => { try { return fs.readdirSync(path.join(pkgDir, 'dist')); } catch (e) { return 'unreadable: ' + e.code; } })());

  note(k('old daemon alive'), alive(oldPid));
  note(k('old daemon /health after install'), await q(home, '/health', oldState));
  note(k('old daemon /echo after install'), await q(home, '/echo', oldState));
  note(k('old daemon /lazy after install'), await q(home, '/lazy', oldState));
  const log1 = fs.readdirSync(home).filter((f) => f.startsWith('daemon-1.0.0'));
  note(k('old daemon log'), log1.map((f) => fs.readFileSync(path.join(home, f), 'utf8').trim().split('\n').slice(-2).join(' | ')));

  if (i2.code) { note(k('stopping: install failed'), 'skipping shim-restart steps'); return; }

  const p2 = shim(home, 'ping', env);
  note(k('v2 shim ping (restart expected)'), p2);
  note(k('old pid dead after restart'), !alive(oldPid));
  note(k('new daemon /echo'), await q(home, '/echo'));
  const newState = await readState(home);
  note(k('new daemon /lazy (no lazy file in v2, expect not_found, no ENOENT)'), await q(home, '/lazy'));
  note(k('new daemon pid differs'), newState?.pid !== oldPid);

  // Older shim vs newer daemon: reinstall v1 over (downgrade) while the v2 daemon runs.
  const i3 = sh(`npm i -g "${tgz1}"`);
  note(k('downgrade install v1 over running v2 daemon'), { code: i3.code, stderr: i3.stderr.slice(0, 300) });
  const p3 = shim(home, 'ping', env);
  note(k('v1 shim vs v2 daemon (expect exit 3, no restart)'), p3);
  const after = await readState(home);
  note(k('v2 daemon untouched'), { samePid: after?.pid === newState?.pid, alive: alive(newState?.pid) });
}

async function cleanup() {
  console.log('\n===== cleanup =====');
  for (const f of fs.readdirSync(work)) {
    if (!f.startsWith('home-')) continue;
    try { const s = JSON.parse(fs.readFileSync(path.join(work, f, 'daemon.json'), 'utf8')); pids.add(s.pid); } catch {}
    for (const l of fs.readdirSync(path.join(work, f))) { const m = l.match(/-(\d+)\.log$/); if (m) pids.add(Number(m[1])); }
  }
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await sleep(500);
  const un = sh(`npm rm -g ${NAME}`);
  console.log('npm rm -g', un.code, un.stderr.slice(0, 300));
  try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch (e) { console.log('rm pkgDir failed', e.code); }
  for (const ext of ['', '.cmd', '.ps1']) { try { fs.rmSync(path.join(path.dirname(globalRoot), NAME + ext), { force: true }); } catch {} }
  console.log('leftover pkg dir:', fs.existsSync(pkgDir), '| leftover bins:', fs.readdirSync(path.dirname(globalRoot)).filter((f) => f.startsWith(NAME)));
  console.log('stub daemons still alive:', [...pids].filter(alive));
  fs.writeFileSync(path.join(here, 'last-run.json'), JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
}

try {
  if (fs.existsSync(pkgDir)) throw new Error(`${pkgDir} already exists; refusing to run`);
  const tgz1 = build('1.0.0', 1, true);
  const tgz2 = build('2.0.0', 2, false);
  await scenario('A-cwd-elsewhere', 'elsewhere', tgz1, tgz2);
  await cleanup1();
  await scenario('B-cwd-in-package-dir', 'pkg', tgz1, tgz2);
} catch (e) {
  console.error('SPIKE ERROR', e);
} finally {
  await cleanup();
}

// Between scenarios: kill daemons and uninstall so scenario B starts clean.
async function cleanup1() {
  for (const f of fs.readdirSync(work)) {
    if (!f.startsWith('home-')) continue;
    for (const l of fs.readdirSync(path.join(work, f))) { const m = l.match(/-(\d+)\.log$/); if (m && alive(Number(m[1]))) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch {} } }
  }
  await sleep(500);
  sh(`npm rm -g ${NAME}`);
}
