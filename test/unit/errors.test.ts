import { describe, expect, it } from 'vitest';
import { ERROR_TABLE, errorEnvelope, TaskLogError, type ErrorCode } from '../../src/errors.ts';
import { createLogger } from '../../src/log.ts';
import { dataPaths } from '../../src/paths.ts';
import path from 'node:path';

describe('error table', () => {
  it('has a one-sentence message, retryable flag and HTTP status for every code', () => {
    for (const [code, e] of Object.entries(ERROR_TABLE)) {
      expect(e.message, code).toMatch(/\.$/);
      expect(typeof e.retryable).toBe('boolean');
      expect(e.http).toBeGreaterThanOrEqual(400);
    }
  });

  it('maps the infrastructure codes to the HTTP statuses of spec section 7', () => {
    const http = (c: ErrorCode) => new TaskLogError(c).http;
    expect([http('unauthorized'), http('protocol_mismatch'), http('indexing'), http('shutting_down'), http('no_workspace'), http('bad_request')]).toEqual([
      401, 409, 503, 503, 404, 400,
    ]);
  });

  it('builds the management envelope and keeps details out unless given', () => {
    const e = new TaskLogError('shutting_down');
    expect(errorEnvelope(e)).toEqual({ error: { code: 'shutting_down', message: ERROR_TABLE.shutting_down.message, retryable: true } });
    expect(new TaskLogError('already_claimed', { details: { claimed_by: 'x' } }).toJSON().details).toEqual({ claimed_by: 'x' });
  });
});

describe('logger ring buffer', () => {
  it('keeps only the last 50 warn and error events, filtered by workspace', () => {
    const log = createLogger({});
    for (let i = 0; i < 60; i++) log.warn('x', { workspace: 'a', i });
    log.error('y', { workspace: 'b' });
    log.info('ignored', { workspace: 'a' });
    const a = log.recentProblems('a');
    expect(a).toHaveLength(50);
    expect(a.at(-1)?.i).toBe(59);
    expect(log.recentProblems('b')).toHaveLength(1);
    expect(log.recentProblems()).toHaveLength(50);
  });
});

describe('data directory', () => {
  it('honours an explicit data dir for daemon.json, workspaces.json, lock and logs', () => {
    const p = dataPaths(path.resolve('some', 'dir'));
    expect(path.basename(p.daemonJson)).toBe('daemon.json');
    expect(path.basename(p.workspacesJson)).toBe('workspaces.json');
    expect(p.daemonLog.startsWith(p.logsDir)).toBe(true);
  });
});
