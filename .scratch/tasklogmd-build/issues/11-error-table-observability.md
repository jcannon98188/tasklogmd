# 11: Error table and observability

**What to build:** Every failure is reported the same way everywhere, and problems are visible without reading raw logs: one error table feeding MCP errors, HTTP errors and log entries, plus `problems[]`, `recent_events[]` and log rotation. Spec reference: `.scratch/tasklogmd/spec.md`, section 7.

**Blocked by:** 09 Workflow tools

**Status:** ready-for-agent

- [x] Given each error code in the spec's error table, when raised, then its MCP error, HTTP error (management endpoints) and log entry carry the same code, message and `retryable`, and the log level follows the class (caller-caused and infrastructure `info`, state problems `warn`, unexpected `error`).
- [x] Given an unexpected exception, when it occurs, then the client gets `internal` with a `request_id` that appears in `daemon.log`.
- [x] Given `daemon.log` over 5 MB, when written, then it rotates keeping three files; given `shim.log` over 1 MB, a shim rotates it once at start keeping one backup and ignores a failed rename.
- [x] Given an invalid item and a conflict, when `workspace_status` runs, then `problems[]` lists both with path, error and start time.
- [x] Given more than 50 warn or error events, when `workspace_status` runs, then `recent_events[]` returns the latest 50 for that workspace from an in-memory ring buffer, never persisted.
- [x] Given a successful write, when logged, then the entry is `item.write` with item ID, operation and new hash and no file content; the token is never logged.
- [x] Logs are JSON lines with stable dotted event names, the default level is `info`, and `TASKLOG_LOG_LEVEL` and `serve --verbose` raise it to `debug`.
- [x] Given the daemon unreachable, when `tasklog doctor` runs, then it falls back to the last 10 warn and error lines of `daemon.log` and prints the log paths.

## Comments

Implemented on branch `t3/ticket-11-error-table-observability`.

- Audit: every `new TaskLogError(...)` in `src` uses a table code; the table (`src/errors.ts`) was already complete and is unchanged. Gaps fixed:
  1. MCP and HTTP failures now share one log entry via `toTaskLogError` / `logTaskLogError` (`request.error` with code, message, retryable, via, request_id, workspace; level from the class). An unexpected exception is one `error` entry that also holds the cause and stack, replacing the separate `request.internal_error`.
  2. The SDK's plain-text invalid-argument errors are rerouted to `bad_request` (wrapper around the `tools/call` handler in `mcp.ts`; relies on the SDK's private `_requestHandlers`, guarded).
  3. `ctx.resolved` (set by `resolveWorkspace`) tags request errors with their workspace so they reach `recent_events[]`.
- `recent_events[]`: the ring is now 50 per workspace (was 50 global, filtered after). `problems[]` entries gain `path` and, for conflicts, `error`; `paths` remains.
- Rotation byte accounting uses UTF-8 byte length. `doctor` output and `--json` also give the `daemon.log` / `shim.log` paths (`log_files`).
- Tests: `test/integration/observability.test.ts`, plus a doctor fallback test in `cli.test.ts`.

