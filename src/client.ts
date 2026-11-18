import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './fsutil.ts';
import type { Logger } from './log.ts';
import type { DataPaths } from './paths.ts';
import { readDaemonState, type DaemonState } from './state.ts';
import { PROTOCOL } from './version.ts';

export interface HealthBody {
  ok: boolean;
  version: string;
  protocol: number;
  pid: number;
  uptime: number;
  workspaces: Array<{ root: string; state: 'indexing' | 'ready' }>;
}

export interface DaemonCallResult<T = unknown> {
  status: number;
  body: T;
}

export async function callDaemon<T = unknown>(
  state: DaemonState,
  method: string,
  pathname: string,
  opts: { body?: unknown; protocol?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<DaemonCallResult<T>> {
  const res = await fetch(`http://127.0.0.1:${state.port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${state.token}`,
      'x-tasklog-protocol': String(opts.protocol ?? PROTOCOL),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: body as T };
}

export interface Probe {
  state: DaemonState;
  health: HealthBody;
}

/** A daemon is live when daemon.json exists, its pid is alive (implied by answering) and /health answers. */
export async function probeDaemon(paths: DataPaths): Promise<Probe | null> {
  const state = readDaemonState(paths);
  if (!state) return null;
  try {
    const r = await callDaemon<HealthBody>(state, 'GET', '/health', { timeoutMs: 2000 });
    if (r.status === 200 && r.body?.ok) return { state, health: r.body };
  } catch {
    /* unreachable: stale */
  }
  return null;
}

/**
 * Spawns the daemon detached from the caller's process tree (Spike 1 winner, spec section 2):
 * `cmd.exe /d /c start "" /b node <daemon>`, `stdio: 'ignore'`, `windowsHide: true`, NOT `detached`.
 * The cwd is the data directory, never the package directory (Spike 3: EBUSY on upgrade).
 */
export function spawnDaemonProcess(paths: DataPaths): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const daemonJs = path.join(here, 'daemon.js');
  fs.mkdirSync(paths.dir, { recursive: true });
  const common = { stdio: 'ignore', cwd: paths.dir, env: process.env } as const;
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, daemonJs], { ...common, windowsHide: true }).unref();
  } else {
    spawn(process.execPath, [daemonJs], { ...common, detached: true }).unref();
  }
}

export class EnsureDaemonError extends Error {
  constructor(
    readonly kind: 'daemon_newer_than_shim' | 'spawn_failed' | 'respawn_failed',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'EnsureDaemonError';
  }
}

export interface EnsureOptions {
  paths: DataPaths;
  log: Logger;
  protocol?: number;
  /** Starts a daemon without waiting. Defaults to the real detached spawn; tests inject in-process ones. */
  spawn?: () => void;
  timeoutMs?: number;
}

export interface Ensured {
  probe: Probe;
  action: 'reused' | 'spawned' | 'restarted';
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(50);
  }
}

/**
 * Finds a compatible daemon or starts one (spec section 2 lifecycle and versioning).
 * - none/stale: spawn, wait up to ~10 s for a healthy state file;
 * - older daemon: `POST /shutdown`, wait for it to go, respawn;
 * - newer daemon: throw `daemon_newer_than_shim`, never restart it.
 */
export async function ensureDaemon(opts: EnsureOptions): Promise<Ensured> {
  const { paths, log } = opts;
  const protocol = opts.protocol ?? PROTOCOL;
  const timeout = opts.timeoutMs ?? 10_000;
  const doSpawn = opts.spawn ?? (() => spawnDaemonProcess(paths));

  let probe = await probeDaemon(paths);
  let action: Ensured['action'] = 'reused';

  if (!probe) {
    log.info('shim.spawn', { reason: 'no live daemon' });
    try {
      doSpawn();
    } catch (e) {
      log.error('shim.spawn_failed', { error: (e as Error).message });
      throw new EnsureDaemonError('spawn_failed', `Could not start the TaskLog daemon: ${(e as Error).message}`);
    }
    probe = await waitFor(() => probeDaemon(paths), timeout);
    if (!probe) {
      log.error('shim.spawn_failed', { error: 'daemon did not become healthy' });
      throw new EnsureDaemonError('spawn_failed', 'The TaskLog daemon did not become healthy in time; run "tasklog serve" to see why.');
    }
    action = 'spawned';
  }

  if (probe.health.protocol > protocol) {
    log.warn('shim.version_skew', { daemon: probe.health.protocol, shim: protocol, action: 'refuse' });
    throw new EnsureDaemonError('daemon_newer_than_shim', 'The running daemon is newer than this client; upgrade tasklog.', {
      daemonProtocol: probe.health.protocol,
      shimProtocol: protocol,
    });
  }

  if (probe.health.protocol < protocol) {
    log.info('shim.version_skew', { daemon: probe.health.protocol, shim: protocol, action: 'restart' });
    try {
      await callDaemon(probe.state, 'POST', '/shutdown', { protocol });
    } catch {
      /* it may already be going */
    }
    const gone = await waitFor(async () => ((await probeDaemon(paths)) ? null : true), timeout);
    if (!gone) throw new EnsureDaemonError('respawn_failed', 'The older daemon did not exit; run "tasklog stop".');
    try {
      doSpawn();
    } catch (e) {
      throw new EnsureDaemonError('respawn_failed', `Could not restart the TaskLog daemon: ${(e as Error).message}`);
    }
    const next = await waitFor(async () => {
      const p = await probeDaemon(paths);
      return p && p.health.protocol === protocol ? p : null;
    }, timeout);
    if (!next) throw new EnsureDaemonError('respawn_failed', 'The restarted daemon did not become healthy in time.');
    probe = next;
    action = 'restarted';
  }

  return { probe, action };
}

/** Asks any daemon to drain and exit and waits for it to go. Returns whether one was running. */
export async function stopDaemon(paths: DataPaths, timeoutMs = 10_000): Promise<boolean> {
  const probe = await probeDaemon(paths);
  if (!probe) return false;
  try {
    await callDaemon(probe.state, 'POST', '/shutdown', { protocol: probe.health.protocol });
  } catch {
    /* going away */
  }
  await waitFor(async () => ((await probeDaemon(paths)) ? null : true), timeoutMs);
  return true;
}
