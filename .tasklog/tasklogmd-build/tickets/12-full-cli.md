---
kind: ticket
title: Full CLI
status: resolved
blocked_by: [4]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd-build/issues/12-full-cli.md
---

## Question

**What to build:** A person can run and debug TaskLog from the terminal: the rest of the `tasklog` command set, JSON output, exit codes and the full `doctor`. Spec reference: `.scratch/tasklogmd/spec.md`, section 8. Adds `start`, `add`, `remove`, `list`, `init`, the global `--workspace` and `--json` flags, and the remaining `doctor` checks, on top of the commands the skeleton already delivered.



- [x] Given no daemon, when `add`, `remove` or `list` runs, then a daemon is started and the registry is updated through it, so the daemon stays the only writer of `workspaces.json`.
- [x] Given a directory, when `init` runs with no daemon, then `.tasklog/` exists and the first shim connection registers it; with a daemon running, `init` registers through it.
- [x] Given `start`, when run, then it spawns the daemon detached and returns once healthy.
- [x] Given any `--json` command (`status`, `list`, `doctor`, `import`), when run, then stdout is valid JSON and diagnostics go to stderr.
- [x] Given a newer daemon, when a command other than `stop` or `status` runs, then it exits 4; `stop` and `status` work against any protocol.
- [x] Given a usage error, when a command is mistyped, then it exits 2.
- [x] Given a broken install (stale `daemon.json`, unwritable log directory, `workspaces.json` unreadable, `claude` missing), when `doctor` runs, then each check reports `{name, ok, detail, fix}`, a missing `claude` is skipped not failed, it includes workspace `problems[]` when a daemon is up, and the exit code is 1 only if a check failed.
- [x] `--workspace <path>` is accepted by `init`, `status`, `list`, `doctor` and `shim` in place of the current directory.

## Comments

Implemented on branch `t3/ticket-12-full-cli`.

- `src/commands.ts` is rewritten around a per-command arg spec: an unknown command, unknown flag, missing value or wrong positional count is exit 2, with usage on stderr. `CliIo` gained test seams `paths` and `env`. `import` is still ticket 13 (currently exit 2 as an unknown command).
- `src/doctor.ts`: `runDoctor` now returns `{checks, problems, recent_events, recent_log, daemonNewer}`. New checks:
  - `daemon-json` (fresh, absent or stale), judged before the daemon is ensured, so a stale file fails and is then replaced.
  - `workspaces-readable`, read straight from the file before the daemon starts, since the daemon sets a corrupt file aside.
  - `workspace-problems`, via `workspace_status` over `POST /mcp` (new `src/mcp-call.ts`).
  - `claude-mcp`: PATH lookup, then `claude mcp list`; skipped (ok) when claude is absent.
  Ticket 05 must keep `workspace_status` returning `problems[]` and `recent_events[]`.
- Doctor with a newer daemon prints its checks (the protocol check fails) and exits 4, not 1.
- `status --json` gained `workspace: {root, registered} | null`; `list --workspace` filters to that workspace.
- `init` with no daemon only creates `.tasklog/` and never starts one; with a daemon it POSTs `/workspaces {root, init: true}`.
- Tests: `test/integration/cli.test.ts` (in-process, spawn seam) plus one e2e. The e2e doctor test tolerates the machine's real `claude` lacking a tasklog registration.
