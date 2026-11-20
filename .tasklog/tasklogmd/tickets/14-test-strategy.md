---
kind: ticket
title: Test strategy
status: resolved
type: grilling
blocked_by: [11]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/14-test-strategy.md
---

## Question

Decide the test strategy for the daemon, the watcher and the MCP surface. Cover the test runner and layers (unit tests for the parser and minimal-diff editor, integration tests against a temp workspace, MCP-level tests through the real stdio shim), how file-watching and self-write suppression are tested deterministically on Windows, how concurrency and stale-hash cases are exercised, a fixture corpus (including imported backlog and scratch trees), and what the Windows process-detach spike must prove before the rest is built.

## Answer

Settled by grilling with the user (all recommendations accepted). Builds on [Daemon architecture](07-daemon-architecture.md), [Daemon HTTP API](11-daemon-http-api.md) and [Logging and observability](13-logging-observability.md). No new glossary terms.

**Runner and layers**: Vitest, TypeScript, ESM. Four layers, each with its own directory and `npm` script:
1. Unit: parser, minimal-diff editor, search tokenizer and ranking, ID and numbering logic; pure, no filesystem, no clock.
2. Integration: the real daemon core in-process against a temp workspace on a real disk, driven through the HTTP API, no shim.
3. MCP e2e: the real built `tasklog shim` as a child process, spawned by the official MCP client SDK over stdio, talking to a real detached daemon.
4. Spike and soak (manual or opt-in): the process-detach proof and long-running watcher checks, excluded from the default `npm test`.

**Watching and self-write suppression**
- The core takes the watcher event source, clock and debounce as injectable dependencies. Most tests feed synthetic events (add, change, unlink, burst, duplicate) and advance time by hand, covering debounce, coalescing, hash-equality drops and rename as delete plus add.
- A small set of real-chokidar tests runs against a temp directory and waits on the daemon's own log events (`scan.finished`, `item.changed`), never fixed sleeps. They prove Windows delivers events and that a daemon write causes no reparse.
- Rescan as oracle: after any scenario, a full rescan must produce a model identical to the live incremental one.

**Concurrency and stale-hash** (integration layer, using a test hook that pauses a write between hash verification and rename)
- Two writers racing one file: exactly one succeeds, the other gets `stale_hash`.
- An external edit between a client's read and write is detected.
- The per-file queue applies interleaved edits to different ACs of one ticket in order.
- A write that fails mid-way leaves the original whole and no temp file behind.
- Each case also gets a seeded randomized run: N parallel clients applying random operations, asserting the file on disk always parses and equals a rescan.

**Fixture corpus** (`test/fixtures/`, real directory trees copied to a temp directory per test)
- Native: a normal workspace plus deliberately broken ones: invalid frontmatter, duplicate item IDs, an unknown frontmatter key (preserved), CRLF and LF, a UTF-8 BOM, non-ASCII titles for diacritic-folded search.
- Import: a backlog-layout tree (prefix change, milestones, subtasks, drafts, archive, unresolvable dependencies) and a scratch-layout tree (a copy of this repo's own `.scratch/tasklogmd`, so the importer is proven on real wayfinder output), each with a checked-in golden native tree.
- Every minimal-diff edit test asserts the byte-exact file diff, not just the parsed result.

**Windows process-detach spike** (implementation ticket 1; a throwaway script on real Windows 11 with the real Claude Code; gates the rest of the build). It passes only if all five hold:
1. A shim launched via `claude mcp add` leaves the detached daemon running when Claude Code exits normally.
2. The same holds when Claude Code is killed as a process tree (Task Manager End Task, `taskkill /T /F`).
3. A second Claude Code session's shim finds that daemon through `daemon.json` and connects without spawning another.
4. No console window flashes at spawn.
5. The daemon survives closing the terminal that started Claude Code.

If 1, 2 or 5 fails, the spike moves to the next fallback in order, `cmd /c start`, then a one-shot scheduled task. It reports which approach passed, and the spec's lifecycle section is updated to name the winner.

**CI split**: unit and integration run on every change on Windows, and on Linux where the filesystem allows (the core is portable). MCP e2e runs on Windows only. The detach spike and Claude-Code-in-the-loop checks stay manual, re-run by hand before a release.
