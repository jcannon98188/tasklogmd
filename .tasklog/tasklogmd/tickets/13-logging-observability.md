---
kind: ticket
title: Logging observability
status: resolved
type: grilling
blocked_by: [11]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/13-logging-observability.md
---

## Question

Decide logging and observability for the daemon and shim. Cover the log file location on Windows, format (structured lines or plain text), levels, rotation and size limits, what is always logged (workspace registration, rescans, self-write suppression decisions, conflicts, invalid items, tool errors), how the machine-readable error codes from the workflow mapping map to log entries and to human-readable messages, and how `workspace_status` and the doctor command expose recent problems.

## Answer

Settled by grilling with the user (all recommendations accepted). Builds on [Workflow mapping](06-workflow-mapping.md), [Daemon HTTP API](11-daemon-http-api.md) and [CLI surface](12-cli-surface.md). No new glossary terms.

**Files**
- `%LOCALAPPDATA%\tasklog\logs\`, beside `daemon.json`. `daemon.log` is written only by the daemon. Shims share one append-only, low-volume `shim.log` (spawn, reconnect, version-skew events, errors). `tasklog serve` in the foreground also mirrors to stderr.

**Format and levels**
- JSON lines: `{ts, level, event, workspace?, request_id?, ...fields}` with stable dotted event names (`workspace.registered`, `scan.finished`). No plain-text format; the human view is `doctor` and `workspace_status`.
- Levels `error`, `warn`, `info`, `debug`; default `info`, set by `TASKLOG_LOG_LEVEL`; `serve --verbose` means `debug`.

**Rotation** (size-based, no library)
- `daemon.log`: rotate at 5 MB, keep 3 files (`daemon.log`, `.1`, `.2`); checked at start and on each write.
- `shim.log`: each shim checks at start and rotates once at 1 MB, keeping one backup; best-effort, so a failed rename on Windows (file open in another shim) is ignored.

**Always logged** (`info` and above)
- Daemon start and stop with version, protocol, pid and port (never the token).
- Workspace registered, unregistered, pruned.
- Scan start and finish with item counts and duration, and the reason for every rescan (startup, watcher error, missed event).
- Every successful write as `item.write` with item ID, operation and new hash, never file content.
- Items becoming invalid or conflicted, and clearing.
- Every tool or request error.
- `debug` adds per-request reads, individual watcher events and each self-write suppression decision; rescans log a summary count of suppressed events.

**Error codes to messages and logs**
- One entry per code in the spec's error table (the workflow mapping codes plus the HTTP API codes): stable `code`, one-sentence human `message` ending with the next step, `retryable`, structured `details`. The same entry feeds MCP tool errors, CLI output and the log, so wording lives in one place.
- Log level by class: caller-caused (`stale_hash`, `not_found`, `already_claimed`, `not_claimed`, `bad_transition`, `bad_request`) and infrastructure (`indexing`, `shutting_down`) log at `info`; state problems (`conflicted`, `invalid_item`, `partial`) at `warn`; unexpected exceptions at `error`, returned as code `internal` with a `request_id` pointing at the log entry.

**Exposing problems**
- `workspace_status` returns its counts plus `problems[]` (current invalid and conflicted items with path, error and start time) and `recent_events[]` (the last 50 `warn` and `error` events for that workspace, from an in-memory ring buffer in the daemon, never persisted).
- `doctor` includes both lists and prints the log file paths; if the daemon is unreachable it falls back to the last 10 `warn` and `error` lines read from `daemon.log`.
