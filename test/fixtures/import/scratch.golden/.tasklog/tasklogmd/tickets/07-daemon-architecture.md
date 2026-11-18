---
kind: ticket
title: Daemon architecture
status: resolved
type: grilling
blocked_by: [3, 4]
created: 2026-01-01
updated: 2026-01-01
imported_from: .scratch/tasklogmd/issues/07-daemon-architecture.md
---

## Question

Design the daemon's architecture. Decide the transport between MCP clients and the daemon and its auth, workspace registration and discovery, auto-start and shutdown, the write protocol (optimistic concurrency, self-write suppression, debounce and coalescing), crash recovery and rebuild-from-disk, and how worktrees (several checkouts of one repo) appear as workspaces.

## Answer

Settled by grilling with the user (all recommendations accepted). Term added to `GLOSSARY.md`: Shim. Recorded as [ADR 0001](../../../docs/adr/0001-daemon-behind-stdio-shim.md).

**Channel and discovery**
- One loopback HTTP server on `127.0.0.1`, ephemeral port, MCP streamable HTTP, Host/Origin checks, bearer token regenerated on every daemon start. The stdio shim proxies to it; debugging tools use the same endpoint.
- `%LOCALAPPDATA%\tasklog\daemon.json` holds `{pid, port, token, version}`, user-readable only. Stale is detected by pid liveness plus a health check. Single instance is enforced by an exclusive lock on a separate lock file.

**Workspaces**
- Auto-registered when a shim connects from a directory at or under a `.tasklog/` repo root. The registry persists at `%LOCALAPPDATA%\tasklog\workspaces.json`, is pruned when a directory disappears, and is overridable with CLI `add` and `remove`.
- The HTTP API is stateless: every request carries `X-TaskLog-Workspace`, with an optional `workspace` argument override. Unregistered paths auto-register under the same rule.
- Each worktree is an independent workspace keyed by absolute root. No cross-worktree reconciliation in v1; claims are per-checkout until merged by git.

**Lifecycle**
- The shim spawns the daemon detached and waits up to about 10 s for a healthy state file. It hides daemon restarts (re-resolve, respawn, retry the in-flight request once), exits only when stdin closes, and on spawn failure stays up and returns an MCP error per call.
- Detached spawn: `spawn` with `detached`, `stdio: 'ignore'`, `windowsHide`, then `unref`. Whether this survives Claude Code's Windows tree kill is unverified: implementation ticket 1 is a spike with an explicit pass/fail. Fallbacks: `cmd /c start`, then a one-shot scheduled task.
- Shim sends a protocol-version integer. On mismatch the newer shim asks the daemon to drain and exit (`POST /shutdown`) and respawns it; other shims reattach. An older shim facing a newer daemon errors and does not restart it.
- Daemon exits after 30 minutes with no clients, or on `tasklog stop`, draining in-flight writes first.
- Serves immediately and indexes each workspace in the background. A request waits on its own workspace's scan up to about 5 s, then fails with a retryable "indexing" error.

**Write protocol**
- Synchronous write-through: verify the client's content hash against the bytes on disk (stale is rejected), patch in place, write a temp file in the same directory, atomically rename, update the model, record the new hash for self-write suppression, return the new hash.
- A per-file serial queue prevents interleaving. There is no write batching; debounce (about 100 ms per path) applies only to inbound watcher events.

**Reads, watching, recovery**
- Reads are served from the model; `get` also returns on-disk mtime. Writes always verify against disk. No push notifications in v1 (deferred extension).
- Watch scope is `.tasklog/**/*.md` only, no symlinks, never `.git` or `node_modules`. Each debounced event stats, reads and hashes the file, drops it if the hash equals the last self-written or read content, otherwise reparses. Deletes remove the item, new files and new effort directories are picked up, a rename is a delete plus an add. Files not matching the layout are ignored.
- Unparseable files stay in the model as invalid items (path, parse error, last good hash), flagged in listings and refused for writes, until they parse again.
- Duplicate Item IDs (for example from a git merge) are kept and flagged conflicted: lookup by that ID errors listing both paths, writes are refused, new numbers are still `max + 1` over all files, and nothing is renumbered automatically.
- The model is never persisted and there is no journal. Recovery is a full scan; leftover temp files are swept at start and ignored by name pattern; a watcher error or missed event triggers a workspace rescan diffed by hash. `daemon.json` and `workspaces.json` are written atomically; a corrupt `workspaces.json` is set aside as `.bak` and rebuilt empty.
