import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive, sleep } from './fsutil.ts';
import type { Logger } from './log.ts';
import type { DataPaths } from './paths.ts';
import { lockHolder, readDaemonState, type DaemonState } from './state.ts';
import { PROTOCOL, VERSION } from './version.ts';

export interface HealthBody {
  ok: boolean;
  version: string;
  protocol: number;
  pid: number;
  uptime: number;
  /** True once the daemon is shutting down: it still answers /health but refuses work. */
  draining?: boolean;
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
 * True once the daemon `pid` has fully exited: its process is gone, or it removed its state file and released
 * the single-instance lock (so a new daemon can take the lock).
 */
async function daemonExited(paths: DataPaths, pid: number): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  const s = readDaemonState(paths);
  const stateGone = !s || s.pid !== pid;
  return stateGone && lockHolder(paths) !== pid;
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
  /** This client's release; defaults to the built VERSION. */
  version?: string;
  /** Starts a daemon without waiting. Defaults to the real detached spawn; tests inject in-process ones. */
  spawn?: () => void;
  timeoutMs?: number;
}

export interface Ensured {
  probe: Probe;
  action: 'reused' | 'spawned' | 'restarted';
}

/** Parses major.minor.patch, ignoring prerelease/build; null for anything that is not a real version (e.g. the dev build). */
function parseRelease(v: string): [number, number, number] | null {
  if (v === '0.0.0' || v.startsWith('0.0.0-') || v.startsWith('0.0.0+')) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when both versions are real releases and `daemon` is strictly older than `client`. */
function isOlderRelease(daemon: string, client: string): boolean {
  const d = parseRelease(daemon);
  const c = parseRelease(client);
  if (!d || !c) return false;
  for (let i = 0; i < 3; i++) if (d[i] !== c[i]) return d[i]! < c[i]!;
  return false;
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
 * - older daemon (protocol, or same protocol but an older release): `POST /shutdown`, wait for it to go, respawn;
 * - newer daemon: throw `daemon_newer_than_shim`, never restart it.
 */
export async function ensureDaemon(opts: EnsureOptions): Promise<Ensured> {
  const { paths, log } = opts;
  const protocol = opts.protocol ?? PROTOCOL;
  const version = opts.version ?? VERSION;
  const timeout = opts.timeoutMs ?? 10_000;
  const doSpawn = opts.spawn ?? (() => spawnDaemonProcess(paths));
  const probeLive = async (): Promise<Probe | null> => {
    const p = await probeDaemon(paths);
    return p && !p.health.draining ? p : null;
  };

  let probe = await probeDaemon(paths);
  let action: Ensured['action'] = 'reused';

  if (probe?.health.draining) {
    // Still answers /health while it drains, but refuses work and holds the lock: wait for it to exit, then respawn.
    log.info('shim.spawn', { reason: 'daemon draining', pid: probe.state.pid });
    const old = probe.state.pid;
    if (!(await waitFor(async () => ((await daemonExited(paths, old)) ? true : null), timeout))) {
      throw new EnsureDaemonError('respawn_failed', 'The daemon that was shutting down did not exit; run "tasklog stop".');
    }
    probe = null;
  }

  if (!probe) {
    log.info('shim.spawn', { reason: 'no live daemon' });
    try {
      doSpawn();
    } catch (e) {
      log.error('shim.spawn_failed', { error: (e as Error).message });
      throw new EnsureDaemonError('spawn_failed', `Could not start the TaskLog daemon: ${(e as Error).message}`);
    }
    probe = await waitFor(probeLive, timeout);
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

  const olderRelease = isOlderRelease(probe.health.version, version);
  if (probe.health.protocol < protocol || olderRelease) {
    log.info('shim.version_skew', {
      daemon: probe.health.protocol,
      shim: protocol,
      ...(olderRelease ? { daemonVersion: probe.health.version, shimVersion: version } : {}),
      action: 'restart',
    });
    try {
      await callDaemon(probe.state, 'POST', '/shutdown', { protocol });
    } catch {
      /* it may already be going */
    }
    const old = probe.state.pid;
    const gone = await waitFor(async () => ((await daemonExited(paths, old)) ? true : null), timeout);
    if (!gone) throw new EnsureDaemonError('respawn_failed', 'The older daemon did not exit; run "tasklog stop".');
    try {
      doSpawn();
    } catch (e) {
      throw new EnsureDaemonError('respawn_failed', `Could not restart the TaskLog daemon: ${(e as Error).message}`);
    }
    const next = await waitFor(async () => {
      const p = await probeLive();
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
