import fs from 'node:fs';
import path from 'node:path';
import { callDaemon, ensureDaemon, EnsureDaemonError, type HealthBody } from './client.ts';
import type { Logger } from './log.ts';
import type { DataPaths } from './paths.ts';
import { PROTOCOL } from './version.ts';
import { findWorkspaceRoot } from './workspaces.ts';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

function writable(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.doctor-${process.pid}.tmp`);
    fs.writeFileSync(f, 'x');
    fs.rmSync(f);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Minimal doctor (ticket 04): node, directories, daemon health, protocol, registry. Starts the daemon if needed. */
export async function runDoctor(opts: { paths: DataPaths; log: Logger; cwd: string; spawn?: () => void }): Promise<DoctorCheck[]> {
  const { paths } = opts;
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node-version',
    ok: major >= 24,
    detail: `Node ${process.versions.node}`,
    fix: 'Install Node 24 or newer.',
  });

  for (const [name, dir] of [['data-dir-writable', paths.dir], ['log-dir-writable', paths.logsDir]] as const) {
    const err = writable(dir);
    checks.push({ name, ok: !err, detail: err ?? dir, fix: `Make ${dir} writable by the current user.` });
  }

  let health: HealthBody | null = null;
  let state = null;
  try {
    const r = await ensureDaemon({ paths, log: opts.log, spawn: opts.spawn });
    health = r.probe.health;
    state = r.probe.state;
    checks.push({
      name: 'daemon-health',
      ok: true,
      detail: `pid ${health.pid}, up ${health.uptime}s${r.action === 'reused' ? '' : ` (${r.action})`}`,
      fix: '',
    });
    checks.push({ name: 'protocol', ok: true, detail: `protocol ${health.protocol}, version ${health.version}`, fix: '' });
  } catch (e) {
    const newer = e instanceof EnsureDaemonError && e.kind === 'daemon_newer_than_shim';
    checks.push({
      name: 'daemon-health',
      ok: false,
      detail: (e as Error).message,
      fix: newer ? 'Upgrade tasklog (npm i -g tasklog).' : 'Run "tasklog serve" in a terminal to see why the daemon will not start.',
    });
    checks.push({
      name: 'protocol',
      ok: false,
      detail: newer ? `daemon protocol is newer than ${PROTOCOL}` : 'daemon unreachable',
      fix: newer ? 'Upgrade tasklog (npm i -g tasklog).' : 'Fix the daemon-health check first.',
    });
  }

  if (state) {
    try {
      const r = await callDaemon<{ workspaces: unknown[] }>(state, 'GET', '/workspaces');
      checks.push({ name: 'workspaces-readable', ok: r.status === 200, detail: `${r.body?.workspaces?.length ?? 0} registered`, fix: 'Run "tasklog stop"; a corrupt workspaces.json is set aside on the next start.' });
    } catch (e) {
      checks.push({ name: 'workspaces-readable', ok: false, detail: (e as Error).message, fix: 'Run "tasklog stop" and retry.' });
    }
  }

  const root = findWorkspaceRoot(opts.cwd);
  checks.push({
    name: 'workspace-resolves',
    ok: true, // informational: not being in a workspace is not an install fault
    detail: root ? `workspace ${root}` : 'current directory is not inside a .tasklog/ workspace',
    fix: root ? '' : 'Run "tasklog init" (or the init_workspace tool) to create one.',
  });
  return checks;
}
