# 11: Error table and observability

**What to build:** Every failure is reported the same way everywhere, and problems are visible without reading raw logs: one error table feeding MCP errors, HTTP errors and log entries, plus `problems[]`, `recent_events[]` and log rotation. Spec reference: `.scratch/tasklogmd/spec.md`, section 7.

**Blocked by:** 09 Workflow tools

**Status:** ready-for-agent

- [ ] Given each error code in the spec's error table, when raised, then its MCP error, HTTP error (management endpoints) and log entry carry the same code, message and `retryable`, and the log level follows the class (caller-caused and infrastructure `info`, state problems `warn`, unexpected `error`).
- [ ] Given an unexpected exception, when it occurs, then the client gets `internal` with a `request_id` that appears in `daemon.log`.
- [ ] Given `daemon.log` over 5 MB, when written, then it rotates keeping three files; given `shim.log` over 1 MB, a shim rotates it once at start keeping one backup and ignores a failed rename.
- [ ] Given an invalid item and a conflict, when `workspace_status` runs, then `problems[]` lists both with path, error and start time.
- [ ] Given more than 50 warn or error events, when `workspace_status` runs, then `recent_events[]` returns the latest 50 for that workspace from an in-memory ring buffer, never persisted.
- [ ] Given a successful write, when logged, then the entry is `item.write` with item ID, operation and new hash and no file content; the token is never logged.
- [ ] Logs are JSON lines with stable dotted event names, the default level is `info`, and `TASKLOG_LOG_LEVEL` and `serve --verbose` raise it to `debug`.
- [ ] Given the daemon unreachable, when `tasklog doctor` runs, then it falls back to the last 10 warn and error lines of `daemon.log` and prints the log paths.
