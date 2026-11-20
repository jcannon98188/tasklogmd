---
kind: ticket
title: Cli surface
status: resolved
type: grilling
blocked_by: [8, 11]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/12-cli-surface.md
---

## Question

Decide the minimal CLI surface. Cover the command list (start, stop, status, the shim entry point, `tasklog import` with `--dry-run`, `--effort` and `--group-by none`, and a doctor or debug command the setup skill can call to verify an install), their flags, exit codes, and output format (human text versus JSON), and which commands talk to the daemon over the HTTP API and which work without it.

## Answer

Settled by grilling with the user (all recommendations accepted). Builds on [Daemon HTTP API](11-daemon-http-api.md) and [Import migration](08-import-migration.md). No new glossary terms.

**Commands** (one binary, `tasklog`; no item-level commands and no `call` escape hatch in v1)
- `shim`: stdio MCP entry point.
- `serve`: daemon in the foreground (what the shim's detached spawn runs; also the debugging route).
- `start`: spawn the daemon detached and return once healthy.
- `stop`: ask the daemon to drain and exit.
- `status`.
- `init`: create `.tasklog/` and register the workspace.
- `add <path>`, `remove <path>`, `list`: manage the workspace registry.
- `import <path>` with `--dry-run`, `--effort`, `--group-by none`.
- `doctor`.
- `--version`.

**Daemon dependence**
- Never start a daemon: `status`, `stop` (a no-op success when already stopped).
- Start one if needed, then call the API: `add`, `remove`, `list` (the daemon stays the only writer of `workspaces.json`).
- Offline: `import`, `serve`.
- `init` creates files offline and registers via the daemon only if one is running; otherwise the first shim connection auto-registers.

**Output and exit codes**
- Human text by default; `--json` on `status`, `list`, `doctor`, `import`. Data on stdout, diagnostics on stderr.
- `0` success; `1` ran but failed (import with skipped files, any failing `doctor` check); `2` usage error; `3` `status` found no daemon; `4` protocol mismatch (CLI refuses to act against a newer daemon).

**`doctor`** starts the daemon if none is running (proving spawn and health is the point; `status` is the non-starting probe). It reports checks as `{name, ok, detail, fix}`: Node version, data and log directories writable, `daemon.json` fresh or stale, daemon health and protocol match, `workspaces.json` readable, current directory resolves to a workspace, that workspace has no invalid or conflicted items, and `claude` on PATH with `tasklog` in `claude mcp list` (skipped, not failed, when `claude` is absent). Exit 0 if all pass, else 1.

**Shim and global flags**
- `tasklog shim` needs no arguments; it resolves the workspace from its working directory, with one optional `--workspace <path>` override. Stdout carries only MCP protocol traffic; all logging goes to the log file.
- `--workspace` is also accepted by `init`, `status`, `list` and `doctor`.
- The exact `claude mcp add` command line is left to the packaging decision (it depends on how the binary is distributed).
