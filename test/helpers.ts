import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, type Clock, type DaemonOptions, type RunningDaemon } from '../src/daemon/core.ts';
import { createLogger, type Logger } from '../src/log.ts';
import { dataPaths, type DataPaths } from '../src/paths.ts';
import { sleep } from '../src/fsutil.ts';
import { callDaemon } from '../src/client.ts';
import type { DaemonState } from '../src/state.ts';

/** A fresh temp directory. Tests never touch the real %LOCALAPPDATA%\tasklog. */
export function tmpDir(prefix = 'tasklog-test-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function mkWorkspace(parent: string, name = 'ws'): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, '.tasklog'), { recursive: true });
  return root;
}

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'native');

/** Copies a native fixture workspace (test/fixtures/native/<name>) into a fresh temp dir; returns its root. */
export function copyFixture(name: string, parent: string = tmpDir(), as = name): string {
  const dest = path.join(parent, as);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return fs.realpathSync.native(dest);
}

export class FakeClock implements Clock {
  private t = 1_000_000;
  private timers: Array<{ fn: () => void; ms: number; next: number }> = [];
  now() {
    return this.t;
  }
  every(fn: () => void, ms: number) {
    const timer = { fn, ms, next: this.t + ms };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }
  /** Advance time, firing timers due in between. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      this.t = due.next;
      due.next += due.ms;
      due.fn();
    }
    this.t = end;
  }
}

export interface TestEnv {
  root: string;
  paths: DataPaths;
  log: Logger;
  /** Starts an in-process daemon and tracks it for cleanup. */
  start(opts?: Partial<DaemonOptions>): Promise<RunningDaemon>;
  state(d: RunningDaemon, protocol?: number): DaemonState;
  cleanup(): Promise<void>;
}

export function makeEnv(): TestEnv {
  const root = tmpDir();
  const paths = dataPaths(path.join(root, 'data'));
  const log = createLogger({ file: paths.daemonLog });
  const daemons: RunningDaemon[] = [];
  return {
    root,
    paths,
    log,
    async start(opts = {}) {
      const d = await startDaemon({ paths, log, ...opts });
      daemons.push(d);
      return d;
    },
    state: (d) => ({ pid: d.pid, port: d.port, token: d.token, version: 'test', protocol: 1 }),
    async cleanup() {
      await Promise.all(daemons.map((d) => d.shutdown('test-cleanup')));
      rmDir(root);
    },
  };
}

export { callDaemon, sleep };

/** Raw HTTP helper that lets tests set arbitrary headers (including Host and Origin). */
export async function rawRequest(
  port: number,
  pathname: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; body: any }> {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(data);
        } catch {
          /* empty */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
