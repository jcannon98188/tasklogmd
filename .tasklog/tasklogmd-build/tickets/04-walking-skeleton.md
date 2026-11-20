---
kind: ticket
title: Walking skeleton
status: resolved
blocked_by: [1]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd-build/issues/04-walking-skeleton.md
---

## Question

**What to build:** The thinnest end-to-end path: a TypeScript package whose stdio shim starts the per-user daemon on demand, connects to it over authenticated loopback HTTP, and answers `workspace_status` for the workspace found from the shim's working directory. Spec reference: `.scratch/tasklogmd/spec.md`, sections 2, 7 (logging setup), 8 (`status`, `stop`, `serve`, minimal `doctor`) and 12. Uses the spawn approach the detach spike selected. Includes package and bundling setup, the Vitest layers, `daemon.json` and the lock file, the token, Host and Origin checks, workspace resolution and `workspaces.json`, `init_workspace`, and logging setup.



- [x] Given no daemon, when a shim connects from a directory under a `.tasklog/` root, then it spawns the daemon, registers the workspace, and `workspace_status` returns `ready`.
- [x] Given a request without the bearer token, or with an `Origin` header, or with a wrong `Host`, when sent to any endpoint, then it is rejected `unauthorized`.
- [x] Given a stale `daemon.json` (dead pid), when a shim starts, then it replaces it and connects.
- [x] Given a directory with no `.tasklog/`, when a workspace-scoped tool is called, then it fails `no_workspace` with an `init` hint, and `init_workspace` creates and registers it.
- [x] Given a newer shim and an older daemon, when they connect, then the daemon drains, exits and is respawned; an older shim facing a newer daemon errors without restarting it.
- [x] Given idle clients, when 30 minutes pass (injected clock), then the daemon exits.
- [x] Given a corrupt `workspaces.json`, when the daemon starts, then it is set aside as `.bak` and rebuilt empty.
- [x] `tasklog status` exits 3 with no daemon and never starts one; `tasklog stop` on a stopped daemon exits 0; `tasklog serve` runs the daemon in the foreground.
- [x] A minimal `tasklog doctor` runs the daemon health and protocol checks and exits 0 or 1.

## Comments

Implementation notes for later tickets (branch `t3/tasklog-walking-skeleton`).

**npm scripts.** `build` (esbuild, `scripts/build.mjs`: one self-contained ESM file per entry, `dist/cli.js` = the `tasklog` bin and `dist/daemon.js` = the spawned daemon; no splitting), `typecheck` (`tsc --noEmit`, covers `src` and `test`), `test` (build, then all of Vitest), `test:unit`, `test:integration`, `test:e2e` (builds first), `test:soak` (opt-in, `test/soak`, passes with no tests). Vitest config: `vitest.config.ts` (one config, layers selected by directory, 30 s timeouts).

**Test layers.** `test/unit` (pure), `test/integration` (in-process daemon via `startDaemon` against a temp dir, helpers in `test/helpers.ts`: `makeEnv()`, `FakeClock`, `mkWorkspace`, `rawRequest` for arbitrary Host/Origin), `test/e2e` (real `dist/cli.js shim` spawned by the MCP SDK `StdioClientTransport`, real detached daemon; `afterEach` runs `tasklog stop` and kills the pid as a fallback). All tests set `TASKLOG_HOME` (e2e) or pass explicit `DataPaths` (integration); nothing touches the real `%LOCALAPPDATA%\tasklog`.

**Data dir.** `dataDir()` in `src/paths.ts`: `TASKLOG_HOME`, else `%LOCALAPPDATA%\tasklog` (XDG fallback off Windows). `dataPaths(dir)` gives `daemonJson`, `lock` (`daemon.lock`), `workspacesJson`, `logsDir`, `daemonLog`, `shimLog`.

**Module layout (`src/`).**
- `errors.ts`: `ErrorCode` union and `ERROR_TABLE` (all spec section 7 codes already present, with message, retryable, HTTP status, log level), `TaskLogError(code, {message?, details?})` with `.http`, `.level`, `.toJSON()`; `errorEnvelope()` for management endpoints. Ticket 11 should extend behaviour, not re-create the table.
- `log.ts`: `createLogger({file, level, stderr, maxBytes, keep, rotateOnWrite})` returning `error/warn/info/debug` plus `recentProblems(workspace?)` (50-entry in-memory ring of warn/error). Size rotation (`rotate()`) is already implemented (`daemonLoggerOptions` 5 MB x3, `shimLoggerOptions` 1 MB x2, start-only) but untested; ticket 11 owns its tests.
- `paths.ts`, `fsutil.ts` (`writeFileAtomic`, `readJsonFile`, `pidAlive`, `sleep`), `state.ts` (`daemon.json` read/write, exclusive `wx` lock file with owner pid, stale-lock reclaim), `version.ts` (`VERSION` injected by esbuild define, `PROTOCOL = 1`).
- `workspaces.ts`: `findWorkspaceRoot(cwd)`, `canonicalize()` (realpath + Windows lowercase), `WorkspaceRegistry` (`load` with corrupt-file `.bak` handling, `register(root, {init})`, `unregister`, `list`, prune). `workspaces.json` is `{version: 1, workspaces: [root,...]}`. Workspace `state` is always `ready` for now; ticket 05 introduces real indexing.
- `daemon/core.ts`: `startDaemon({paths, log, clock?, idleMs?, protocol?, version?, onExit?})` returns `{pid, port, token, shutdown(reason), stopped}`. Auth (Host, Origin, constant-time bearer) runs before everything; `/health` and `/shutdown` skip the protocol check, other endpoints require `X-TaskLog-Protocol` equal to the daemon's (409 `protocol_mismatch`, 400 if missing). Drain: new requests get 503 `shutting_down`; in-flight requests finish first. Injectable `Clock {now, every}`; idle check every 60 s, exit after `idleMs` (30 min) with nothing in flight.
- `daemon/mcp.ts`: `createMcpServer(deps, ctx)` builds a fresh stateless `McpServer` per request (SDK streamable HTTP, `enableJsonResponse`). Add tools here. `resolveWorkspace(deps, ctx, arg?)` is the one helper workspace-scoped tools must call (arg override, else `X-TaskLog-Workspace`, else `no_workspace` with an init hint; auto-registers). Tool errors are `isError` results with `structuredContent: {error: {code, message, retryable, details?}}`.
- `daemon/run.ts` (`runDaemonProcess`, shared by `serve` and `dist/daemon.js`), `daemon-main.ts` (entry).
- `client.ts`: `callDaemon`, `probeDaemon`, `ensureDaemon({paths, log, protocol?, spawn?})` (spawn if none/stale; older daemon: `/shutdown`, wait, respawn; newer: throws `EnsureDaemonError('daemon_newer_than_shim')`), `stopDaemon`, `spawnDaemonProcess` (real spawn, see below). The `spawn` option is the test seam; integration tests start in-process daemons through it.
- `shim.ts`: `runShim({input, output, cwd, workspace?, paths, log, protocol?, spawn?})`, a newline-JSON-RPC stdio to `POST /mcp` proxy (it does not use the SDK). Sends `X-TaskLog-Workspace` (nearest `.tasklog/` ancestor of cwd, or `--workspace`), `X-TaskLog-Cwd` (added so `init_workspace` can default to the working directory when no workspace exists yet), `X-TaskLog-Protocol`. On a failed request or 503 `shutting_down` it re-ensures the daemon and retries once; on ensure failure it stays up and answers each request with a JSON-RPC error. Exits when stdin closes.
- `commands.ts` (`runCommand(argv, io)`, `EXIT` codes), `doctor.ts` (`runDoctor` returning `{name, ok, detail, fix}[]`: node-version, data-dir/log-dir writable, daemon-health, protocol, workspaces-readable, workspace-resolves (informational)), `cli.ts` (bin entry).

**Spawn.** As selected by Spike 1: `cmd.exe /d /c start "" /b node dist/daemon.js`, `stdio: 'ignore'`, `windowsHide: true`, not `detached`, `cwd` = the data dir (outside the package, per Spike 3). Non-Windows uses a plain detached spawn. `dist/daemon.js` is located next to the running `dist/cli.js`, so the spawn only works from the bundle (tests that run from `src` inject `spawn`).

**Deviations and limits.**
- Added the `X-TaskLog-Cwd` header and `workspace` arg on `workspace_status` (the spec's table says no inputs; the arg mirrors the spec's optional `workspace` override).
- `doctor` omits the checks that need later tickets (`daemon.json` fresh/stale, invalid or conflicted items, `claude` on PATH). Ticket 12 owns the full set.
- CLI commands `start`, `init`, `add`, `remove`, `list`, `import` are not implemented (ticket 12/13). `--json` works for `status` and `doctor`; exit code 4 is defined but unused.
- Not tested: real console-window flash and tree-kill survival are Spike 1 matters (manual). The e2e tests run the real spawn path, so a daemon is confirmed to detach and survive the shim, but not under `taskkill /T`.
- `typescript@5.9` is used (not 7.x) and Vitest 5.1; the MCP SDK is 1.32.2 with zod 4.
