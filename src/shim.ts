import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ensureDaemon, EnsureDaemonError, type Probe } from './client.ts';
import type { Logger } from './log.ts';
import type { DataPaths } from './paths.ts';
import { PROTOCOL } from './version.ts';
import { findWorkspaceRoot } from './workspaces.ts';

export interface ShimOptions {
  input: Readable;
  /** Carries ONLY protocol traffic. */
  output: Writable;
  cwd: string;
  /** `--workspace <path>`: overrides the walk up from cwd. */
  workspace?: string;
  paths: DataPaths;
  log: Logger;
  protocol?: number;
  spawn?: () => void;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
}

/**
 * Stdio MCP shim: proxies newline-delimited JSON-RPC from stdin to the daemon's `POST /mcp` and writes
 * replies to stdout. It hides daemon restarts (re-resolve, respawn, retry the in-flight request once),
 * exits only when stdin closes, and on spawn failure stays up answering each call with an error.
 */
export async function runShim(opts: ShimOptions): Promise<void> {
  const { log } = opts;
  const protocol = opts.protocol ?? PROTOCOL;
  let current: Probe | null = null;
  let ensuring: Promise<Probe> | null = null;

  const resolveWorkspace = () => (opts.workspace ? path.resolve(opts.workspace) : findWorkspaceRoot(opts.cwd));

  function ensure(force = false): Promise<Probe> {
    if (!force && current) return Promise.resolve(current);
    if (!ensuring) {
      ensuring = ensureDaemon({ paths: opts.paths, log, protocol, spawn: opts.spawn })
        .then((r) => (current = r.probe))
        .finally(() => (ensuring = null));
    }
    return ensuring;
  }

  const write = (obj: unknown) => opts.output.write(JSON.stringify(obj) + '\n');
  const fail = (id: JsonRpcMessage['id'], message: string, data?: unknown) => {
    if (id === undefined || id === null) return;
    write({ jsonrpc: '2.0', id, error: { code: -32000, message, ...(data !== undefined ? { data } : {}) } });
  };

  async function post(probe: Probe, text: string): Promise<{ status: number; body: unknown; raw: string }> {
    const ws = resolveWorkspace();
    const res = await fetch(`http://127.0.0.1:${probe.state.port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${probe.state.token}`,
        'x-tasklog-protocol': String(protocol),
        'x-tasklog-cwd': opts.cwd,
        ...(ws ? { 'x-tasklog-workspace': ws } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: text,
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, raw };
  }

  async function handle(line: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    let probe: Probe;
    try {
      probe = await ensure();
    } catch (e) {
      fail(msg.id, (e as Error).message, e instanceof EnsureDaemonError ? { kind: e.kind, ...e.details } : undefined);
      return;
    }

    let result: Awaited<ReturnType<typeof post>> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await post(probe, line);
        const code = (result.body as { error?: { code?: string } } | null)?.error?.code;
        if (result.status === 503 && code === 'shutting_down') throw new Error('daemon shutting down');
        break;
      } catch (e) {
        if (attempt === 1) {
          log.error('shim.request_failed', { error: (e as Error).message });
          fail(msg.id, `Could not reach the TaskLog daemon: ${(e as Error).message}`);
          return;
        }
        log.info('shim.reconnect', { reason: (e as Error).message });
        current = null;
        try {
          probe = await ensure(true);
        } catch (e2) {
          fail(msg.id, (e2 as Error).message, e2 instanceof EnsureDaemonError ? { kind: e2.kind, ...e2.details } : undefined);
          return;
        }
      }
    }
    if (!result) return;

    if (result.status === 202 || result.status === 204 || !result.raw) return; // notification accepted
    if (result.status >= 400 && result.body && typeof result.body === 'object' && 'error' in result.body && !('jsonrpc' in result.body)) {
      // Management-style error envelope (e.g. protocol_mismatch): surface as a JSON-RPC error.
      const err = (result.body as { error: { code: string; message: string } }).error;
      fail(msg.id, `${err.code}: ${err.message}`, err);
      return;
    }
    opts.output.write(result.raw.trim() + '\n');
  }

  const rl = readline.createInterface({ input: opts.input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const p = handle(line)
      .catch((e: unknown) => log.error('shim.handler_error', { error: (e as Error).message }))
      .finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise<void>((r) => rl.once('close', () => r()));
  await Promise.allSettled([...pending]);
}
