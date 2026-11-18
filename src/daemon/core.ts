import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { errorEnvelope, isTaskLogError, TaskLogError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { DataPaths } from '../paths.ts';
import { acquireLock, removeDaemonState, writeDaemonState, type Lock } from '../state.ts';
import { PROTOCOL, VERSION } from '../version.ts';
import { WorkspaceRegistry } from '../workspaces.ts';
import { createMcpServer, type RequestContext } from './mcp.ts';
import { ModelManager } from './models.ts';
import type { WatcherOptions } from './watcher.ts';
import { WriteService } from './writes.ts';

export const IDLE_MS = 30 * 60 * 1000;

/** Injectable time source so idle exit is testable with a fake clock. */
export interface Clock {
  now(): number;
  /** Repeating timer; returns a cancel function. */
  every(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  every(fn, ms) {
    const t = setInterval(fn, ms);
    t.unref();
    return () => clearInterval(t);
  },
};

export interface DaemonOptions {
  paths: DataPaths;
  log: Logger;
  clock?: Clock;
  idleMs?: number;
  /** Overridable so tests can simulate a newer or older daemon. */
  protocol?: number;
  version?: string;
  /** Called once after a full shutdown (the entry point calls process.exit here). */
  onExit?: (reason: string) => void;
  /** How long a request waits on its workspace's initial scan before failing `indexing` (default 5 s). */
  indexWaitMs?: number;
  /** Test seam: awaited at the start of each workspace scan, to hold indexing open. */
  beforeScan?: (root: string) => Promise<void>;
  /** Watcher wiring; tests inject a synthetic event source and fake timers. */
  watcher?: WatcherOptions;
}

export interface RunningDaemon {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  /** The in-memory model (parsed-item store plus workspace indexes); exposed for tests and in-process callers. */
  readonly models: ModelManager;
  /** The write protocol: ticket 07 (watcher) asks it `isSelfWrite`; tests set its `beforeRename` hook. */
  readonly writes: WriteService;
  /** Drain in-flight requests, then release everything. Resolves when fully stopped. */
  shutdown(reason: string): Promise<void>;
  /** Resolves when the daemon has fully stopped. */
  readonly stopped: Promise<void>;
}

export class AlreadyRunningError extends Error {
  constructor() {
    super('another tasklog daemon holds the lock');
    this.name = 'AlreadyRunningError';
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest();
function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new TaskLogError('bad_request', { message: 'Request body too large; send a smaller request.' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new TaskLogError('bad_request', { message: 'Request body must be a JSON object; fix it and retry.' });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const header = (req: http.IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const { paths, log } = opts;
  const clock = opts.clock ?? systemClock;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const protocol = opts.protocol ?? PROTOCOL;
  const version = opts.version ?? VERSION;
  const pid = process.pid;
  const startedAt = clock.now();

  const lock: Lock | null = acquireLock(paths, pid);
  if (!lock) throw new AlreadyRunningError();

  let server: http.Server | undefined;
  try {
    const registry = new WorkspaceRegistry(paths, log);
    const models = new ModelManager(registry, log, { indexWaitMs: opts.indexWaitMs, beforeScan: opts.beforeScan, watcher: opts.watcher });
    registry.load();
    const writes = new WriteService(models, log, { now: () => clock.now() });
    models.writeGuard = writes; // the watcher consults it to label and sequence around the daemon's own writes
    models.startAll();

    const token = randomBytes(32).toString('hex'); // 256 random bits, regenerated each start
    let port = 0;
    let draining = false;
    let inflight = 0;
    let drainWaiters: Array<() => void> = [];
    let lastActivity = clock.now();
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((r) => (resolveStopped = r));
    let shutdownPromise: Promise<void> | null = null;

    const noteDone = () => {
      inflight--;
      if (inflight === 0) {
        const w = drainWaiters;
        drainWaiters = [];
        w.forEach((f) => f());
      }
    };

    function authenticate(req: http.IncomingMessage): void {
      const host = header(req, 'host');
      const hostOk = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
      const authz = header(req, 'authorization') ?? '';
      const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : '';
      // Evaluate every check (no early exit on the token) so timing reveals nothing extra.
      const tokenOk = constantTimeEqual(bearer, token);
      if (!hostOk || req.headers.origin !== undefined || !tokenOk) throw new TaskLogError('unauthorized');
    }

    function checkProtocol(req: http.IncomingMessage): void {
      const p = header(req, 'x-tasklog-protocol');
      if (p === undefined) throw new TaskLogError('bad_request', { message: 'Missing X-TaskLog-Protocol header; send the client protocol number.' });
      if (Number(p) !== protocol) {
        throw new TaskLogError('protocol_mismatch', { details: { client: Number(p), daemon: protocol } });
      }
    }

    async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, requestId: string): Promise<void> {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const text = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new TaskLogError('bad_request', { message: 'MCP request body is not valid JSON; fix it and retry.' });
      }
      const ctx: RequestContext = {
        workspace: header(req, 'x-tasklog-workspace'),
        cwd: header(req, 'x-tasklog-cwd'),
        requestId,
      };
      const mcp = createMcpServer({ registry, models, writes, log, version }, ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    }

    async function route(req: http.IncomingMessage, res: http.ServerResponse, requestId: string): Promise<void> {
      authenticate(req);
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      const m = req.method ?? 'GET';

      // Exempt from the protocol check so any client can probe and stop any daemon.
      if (p === '/health' && m === 'GET') {
        sendJson(res, 200, {
          ok: true,
          version,
          protocol,
          pid,
          uptime: Math.round((clock.now() - startedAt) / 1000),
          workspaces: registry.list(),
        });
        return;
      }
      if (p === '/shutdown' && m === 'POST') {
        sendJson(res, 200, { ok: true });
        void shutdown('requested');
        return;
      }

      if (draining) throw new TaskLogError('shutting_down');
      checkProtocol(req);

      if (p === '/mcp') return handleMcp(req, res, requestId);
      if (p === '/workspaces') {
        if (m === 'GET') return sendJson(res, 200, { workspaces: registry.list() });
        if (m === 'POST') {
          const b = await readJsonBody(req);
          const root = registry.register(b.root as string, { init: b.init === true });
          return sendJson(res, 200, { root });
        }
        if (m === 'DELETE') {
          const b = await readJsonBody(req);
          if (typeof b.root !== 'string') throw new TaskLogError('bad_request', { message: 'DELETE /workspaces needs {root}; add it and retry.' });
          return sendJson(res, 200, { removed: registry.unregister(b.root) });
        }
      }
      throw new TaskLogError('bad_request', { message: `Unknown endpoint ${m} ${p}; check the path.` });
    }

    server = http.createServer((req, res) => {
      const requestId = randomUUID();
      inflight++;
      lastActivity = clock.now();
      res.on('close', noteDone);
      route(req, res, requestId).catch((e: unknown) => {
        let te: TaskLogError;
        if (isTaskLogError(e)) {
          te = e;
        } else {
          te = new TaskLogError('internal', { details: { request_id: requestId } });
          log.error('request.internal_error', { request_id: requestId, error: (e as Error)?.message, stack: (e as Error)?.stack });
        }
        log[te.level]('request.error', { request_id: requestId, code: te.code, path: req.url });
        if (!res.headersSent) sendJson(res, te.http, errorEnvelope(te));
        else res.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as { port: number }).port;

    writeDaemonState(paths, { pid, port, token, version, protocol });
    log.info('daemon.start', { version, protocol, pid, port });

    const cancelIdle = clock.every(() => {
      if (inflight === 0 && !draining && clock.now() - lastActivity >= idleMs) void shutdown('idle');
    }, 60_000);

    function shutdown(reason: string): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        draining = true;
        log.info('daemon.draining', { reason });
        cancelIdle();
        if (inflight > 0) await new Promise<void>((r) => drainWaiters.push(r));
        const srv = server!;
        await new Promise<void>((r) => {
          srv.close(() => r());
          srv.closeAllConnections();
        });
        models.disposeAll();
        removeDaemonState(paths, pid, port);
        lock!.release();
        log.info('daemon.stop', { reason, version, protocol, pid, port });
        resolveStopped();
        opts.onExit?.(reason);
      })();
      return shutdownPromise;
    }

    return { pid, port, token, models, writes, shutdown, stopped };
  } catch (e) {
    try {
      server?.close();
    } catch {
      /* ignore */
    }
    lock.release();
    throw e;
  }
}
