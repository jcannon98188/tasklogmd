---
kind: map
title: TaskLog.md build spec
status: open
created: 2026-01-01
updated: 2026-01-01
imported_from: .scratch/tasklogmd/map.md
---

## Destination

A **build spec** at `.scratch/tasklogmd/spec.md` for TaskLog.md: a per-user daemon with an in-memory model of markdown task files, fine-grained edit operations, file watching, and an MCP interface, tailored to the wayfinder and implement-spec workflows. The spec is detailed enough that `/to-tickets` and `/implement-spec` can build from it. **No implementation happens in this map.**

## Notes

- Domain language lives in `GLOSSARY.md`. Update it as terms resolve.
- Every grilling ticket calls the `grilling` and `domain-modeling` skills.
- The user prefers Node.js tooling.
- Tracker: local markdown (`docs/agents/issue-tracker.md`).

Settled while charting (grilled with the user):

- Destination is a build spec, not code.
- Markdown files are the only source of truth. The in-memory model is a derived index, rebuildable from disk.
- Daemon edits are minimal diffs under optimistic concurrency. The file always wins on conflict, and the watcher ignores the daemon's own writes.
- One per-user daemon serves many registered workspaces. It auto-starts on the first MCP connection. OS service install is deferred. Windows comes first.
- TypeScript on Node.
- MCP is the required interface. UTCP is adopted only if research shows Claude can use it natively.
- TaskLog has one **native format**, and it may break from every backlog.md convention. Backlog layout and scratch layout are **import-only** through a one-shot migration command that leaves the originals untouched.
- Machine-edited metadata (status, tags, claim, blocked-by, type) goes in YAML frontmatter. ACs and the resolution answer stay in the body.
- Tags are a `tags:` frontmatter list, searchable by AND/OR plus full text.
- The MCP surface has generic fine-grained operations plus workflow tools for the skills (frontier, claim, resolve, append to Decisions-so-far), composed from the generic ones.
- The spec includes a TaskLog tracker doc so wayfinder, implement-spec and triage call MCP tools instead of editing files.
- The primary consumer is an agent over MCP. A minimal CLI exists for starting the daemon and for debugging.

## Decisions so far

- [backlog.md schema](tickets/01-backlog-md-schema.md): frontmatter plus sentinel-wrapped body sections; import must resolve prefix-varying dependency IDs, treat "done" as the last configured status, and map labels to tags.
- [UTCP viability](tickets/02-utcp-viability.md): no native Claude support and it adds nothing over MCP for a local daemon; MCP only in v1.
- [MCP transport options](tickets/03-mcp-transport-options.md): stdio shim that spawns or connects to the daemon, plus loopback HTTP for debugging; Windows process-tree kill needs a spike.
- [Node file watching](tickets/04-node-file-watching.md): chokidar v6 with events treated as hints, content-hash self-write suppression, and a rescan on startup and error.
- [Native format](tickets/05-native-format.md): `.tasklog/<effort>/` with one item type (`kind`), permanent `effort/NN` IDs, a fixed four-value status enum, plain `##` headings with stable `#N` ACs, minimal-diff in-place edits, and a stored-nowhere content-hash concurrency token.

- [Daemon architecture](tickets/07-daemon-architecture.md): one loopback HTTP daemon behind a stdio shim that owns spawn and reconnect (ADR 0001); stateless workspace-scoped requests, write-through temp-and-rename with hash checks, rescan-only recovery, independent worktrees, duplicate IDs flagged not renumbered; Windows detach is implementation spike 1.
- [Workflow mapping](tickets/06-workflow-mapping.md): discrete generic tools plus workflow tools (`frontier`, `overview`, `claim`, `resolve`, `close`, `triage`); resolved or closed blockers satisfy; claims are per-checkout with no TTL and stale ones surfaced; implement-spec implementers only tick ACs and the orchestrator resolves; a shared content-hash parsed-item store amends the daemon model.
- [Import migration](tickets/08-import-migration.md): standalone `tasklog import` with auto-detect and dry-run; scratch efforts keep their names, backlog milestones become efforts (unmilestoned go to `backlog`); numeric IDs preserved with `imported_from` provenance; staged all-or-nothing write with per-file skips reported; idempotent by skipping already-imported items; effort is required on ticket creation.

- [Tracker doc and setup skill](tickets/09-tracker-doc.md): a new `issue-tracker-tasklog.md` seed template phrases every skill step as an MCP tool call; user-scope `claude mcp add` for the `tasklog` server; setup detects TaskLog, writes the docs, verifies, and offers `tasklog import .scratch`; `type` becomes optional on `create_item`.
- [Search design](tickets/10-search-design.md): `list_items` takes flat `tags_all`/`tags_any`/`tags_none` plus `text` over title, ID, tags and all body sections; case- and diacritic-folded word-or-prefix matching with implicit AND, quoted phrases and `-term`; field-weighted ranking with `matched_in`; tokens live in the shared parsed-item store and are scanned linearly; limit 50 (cap 200) with an offset cursor and a `stale_cursor` error.

- [Daemon HTTP API](tickets/11-daemon-http-api.md): `/mcp`, `/health`, `/shutdown` and `/workspaces`, all behind the bearer token with Host/Origin checks; the shim resolves the nearest `.tasklog/` root; `init_workspace` bootstraps; one integer protocol version with additive-only changes, newer shim restarts older daemon.
- [CLI surface](tickets/12-cli-surface.md): one `tasklog` binary with `shim`, `serve`, `start`, `stop`, `status`, `init`, `add`/`remove`/`list`, `import`, `doctor`; `status` and `stop` never start the daemon, `doctor` does; `--json` output, exit codes 0-4; no item-level commands in v1.
- [Logging and observability](tickets/13-logging-observability.md): JSON-lines `daemon.log` (5 MB x 3) and shared `shim.log` under `%LOCALAPPDATA%\tasklog\logs\`; one error table feeds MCP errors, CLI output and logs; `workspace_status` and `doctor` expose `problems[]` and an in-memory `recent_events[]`.
- [Test strategy](tickets/14-test-strategy.md): Vitest in four layers (unit, in-process integration, stdio-shim e2e, manual spike); injectable watcher, clock and debounce with rescan as oracle; a write-pause hook for stale-hash races; golden fixtures including this repo's `.scratch`; a five-point pass/fail bar for the Windows detach spike.
- [Windows packaging research](tickets/15-windows-packaging.md): facts only, findings on branch `research/windows-packaging`; Node 26 is Active LTS, Claude Code ends the shim's process tree about 300 ms after closing stdin, and `.cmd`-shim launch, in-place exe replacement and SmartScreen-on-npm are undocumented and need empirical checks.
- [Build spec](tickets/16-build-spec.md): the destination, written at `.scratch/tasklogmd/spec.md`; packaging is an npm global install on Node 24+, three spikes run first, and 13 vertical slices carry given/when/then ACs tagged by test layer.

## Not yet specified

Nothing remains. The last of the fog graduated into tickets: the daemon HTTP API, the CLI surface, logging and observability, test strategy, Windows packaging research, and the build spec itself.

## Out of scope

- Web UI, TUI or kanban board.
- Sync with GitHub or other trackers.
- Multi-user or remote access.
- Live read or write compatibility with the backlog layout or scratch layout.
- Installing the daemon as an OS service (deferred beyond this spec's v1).
