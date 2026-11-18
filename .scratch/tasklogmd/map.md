Label: wayfinder:map

# TaskLog.md build spec

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

<!-- one line per resolved ticket: [title](issues/NN-slug.md): gist -->

## Not yet specified

- Search design: full-text index, tag query syntax, ranking.
- Minimal CLI surface.
- Errors, logging and observability.
- Test strategy for the daemon, the watcher and the MCP surface.
- Windows packaging and distribution.
- The shape and structure of the final build spec, and the ticket that writes it.
- The content of the TaskLog tracker doc and the `/setup-matt-pocock-skills` change.

## Out of scope

- Web UI, TUI or kanban board.
- Sync with GitHub or other trackers.
- Multi-user or remote access.
- Live read or write compatibility with the backlog layout or scratch layout.
- Installing the daemon as an OS service (deferred beyond this spec's v1).
