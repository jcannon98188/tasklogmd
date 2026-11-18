// The error table (spec section 7). One entry per code; the same entry feeds MCP tool errors,
// HTTP management errors, CLI output and the log. Later tickets add behaviour, not codes.

import type { Logger } from './log.ts';

export type ErrorCode =
  | 'stale_hash'
  | 'stale_cursor'
  | 'not_found'
  | 'already_claimed'
  | 'not_claimed'
  | 'bad_transition'
  | 'bad_request'
  | 'indexing'
  | 'shutting_down'
  | 'unauthorized'
  | 'protocol_mismatch'
  | 'no_workspace'
  | 'conflicted'
  | 'invalid_item'
  | 'partial'
  | 'internal';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface ErrorEntry {
  /** One sentence ending with the next step. */
  message: string;
  retryable: boolean;
  /** HTTP status on management endpoints. */
  http: number;
  level: LogLevel;
}

export const ERROR_TABLE: Record<ErrorCode, ErrorEntry> = {
  stale_hash: { message: 'The item changed since you read it; re-read it and retry.', retryable: true, http: 409, level: 'info' },
  stale_cursor: { message: 'The list changed since this cursor was issued; restart the listing.', retryable: true, http: 409, level: 'info' },
  not_found: { message: 'No such item; check the Item ID with list_items.', retryable: false, http: 404, level: 'info' },
  already_claimed: { message: 'The item is already claimed by someone else; pick another or ask them to release it.', retryable: false, http: 409, level: 'info' },
  not_claimed: { message: 'The item is not claimed; claim it first.', retryable: false, http: 409, level: 'info' },
  bad_transition: { message: 'The item is not in a state that allows this change; check its status.', retryable: false, http: 409, level: 'info' },
  bad_request: { message: 'The request is malformed; fix the arguments and retry.', retryable: false, http: 400, level: 'info' },
  indexing: { message: 'The workspace is still being indexed; retry in a few seconds.', retryable: true, http: 503, level: 'info' },
  shutting_down: { message: 'The daemon is shutting down; retry and it will be restarted.', retryable: true, http: 503, level: 'info' },
  unauthorized: { message: 'The request is not authorized; the client must read the current daemon.json token.', retryable: false, http: 401, level: 'info' },
  protocol_mismatch: { message: 'The client and daemon protocol versions differ; upgrade the older one or run "tasklog stop".', retryable: false, http: 409, level: 'info' },
  no_workspace: { message: 'No .tasklog/ workspace found here; run "tasklog init" or call init_workspace.', retryable: false, http: 404, level: 'info' },
  conflicted: { message: 'Two files claim this Item ID; resolve the duplicate on disk.', retryable: false, http: 409, level: 'warn' },
  invalid_item: { message: 'The item file does not parse; fix it on disk.', retryable: false, http: 409, level: 'warn' },
  partial: { message: 'Some steps did not complete; retry to finish them.', retryable: true, http: 500, level: 'warn' },
  internal: { message: 'Unexpected internal error; check daemon.log for the request_id.', retryable: false, http: 500, level: 'error' },
};

export class TaskLogError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  /** `message` overrides the table's sentence (keep it ending with the next step). */
  constructor(code: ErrorCode, opts: { message?: string; details?: Record<string, unknown> } = {}) {
    const entry = ERROR_TABLE[code];
    super(opts.message ?? entry.message);
    this.name = 'TaskLogError';
    this.code = code;
    this.retryable = entry.retryable;
    this.details = opts.details ?? {};
  }

  get http(): number {
    return ERROR_TABLE[this.code].http;
  }

  get level(): LogLevel {
    return ERROR_TABLE[this.code].level;
  }

  toJSON(): ErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(Object.keys(this.details).length ? { details: this.details } : {}) };
  }
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** Management-endpoint envelope: `{error: {code, message, retryable}}`. */
export function errorEnvelope(e: TaskLogError): { error: ErrorBody } {
  return { error: e.toJSON() };
}

export function isTaskLogError(e: unknown): e is TaskLogError {
  return e instanceof TaskLogError;
}

/**
 * Normalises anything thrown into a table error. An unexpected exception becomes `internal` carrying
 * the request_id; the original is returned as `cause` so the log (never the client) gets the stack.
 */
export function toTaskLogError(e: unknown, requestId: string): { error: TaskLogError; cause?: unknown } {
  if (isTaskLogError(e)) return { error: e };
  return { error: new TaskLogError('internal', { details: { request_id: requestId } }), cause: e };
}

/** The one log entry for a failure: same code, message and retryable as the MCP/HTTP error; level from the class. */
export function logTaskLogError(
  log: Pick<Logger, LogLevel>,
  te: TaskLogError,
  ctx: { requestId: string; workspace?: string; via: 'mcp' | 'http'; path?: string; cause?: unknown },
): void {
  const cause = ctx.cause as Error | undefined;
  log[te.level]('request.error', {
    request_id: ctx.requestId,
    ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
    code: te.code,
    message: te.message,
    retryable: te.retryable,
    via: ctx.via,
    ...(ctx.path ? { path: ctx.path } : {}),
    ...(Object.keys(te.details).length ? { details: te.details } : {}),
    ...(cause !== undefined ? { error: cause?.message ?? String(cause), stack: cause?.stack } : {}),
  });
}
