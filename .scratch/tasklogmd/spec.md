Status: ready-for-agent

# TaskLog.md build spec

TaskLog is a per-user daemon with an in-memory model of markdown task files, fine-grained edit operations, file watching, and an MCP interface, tailored to the wayfinder, implement-spec and triage skills. This spec is detailed enough for `/to-tickets` and `/implement-spec` to build from. It was assembled from the resolved tickets of the TaskLog map (`.scratch/tasklogmd/map.md`); each decision is stated once, in its home section, with its source ticket named. Where a later ticket amended an earlier one, only the final rule appears here and the amendment is listed in Appendix A. Domain terms are defined in `GLOSSARY.md`; the daemon-behind-shim decision is `docs/adr/0001-daemon-behind-stdio-shim.md`.

## 1. Overview, goals and non-goals

**Goals**
- Markdown files are the only source of truth. The model is a derived index, rebuildable from disk at any time.
- An agent over MCP can read, search and edit items with fine-grained operations that produce minimal diffs.
- The wayfinder, implement-spec and triage skills run entirely through MCP tool calls, with no hand-editing of files.
- Windows comes first. TypeScript on Node.

**Non-goals (v1)**
- Web UI, TUI or kanban board.
- Sync with GitHub or other trackers.
- Multi-user or remote access.
- Live read or write compatibility with the backlog layout or scratch layout (import only).
- Installing the daemon as an OS service.
- UTCP (no native Claude support and no gain over MCP; source: UTCP viability).
- Cross-worktree claim reconciliation, push notifications, and a Node single executable or installer.

## 2. Architecture

Source: Daemon architecture, Daemon HTTP API, MCP transport options, ADR 0001.

**Processes.** One per-user daemon serves every registered workspace. MCP clients never talk to it directly: Claude Code only spawns stdio servers, so a stdio **shim** starts the daemon on demand and proxies to the daemon's single loopback HTTP server. The CLI uses the same HTTP server.

**Channel and discovery**
- The daemon listens on `127.0.0.1` at an ephemeral port: MCP streamable HTTP at `POST /mcp`, plus the management endpoints below. Every request needs `Authorization: Bearer <token>`. The token is 256 random bits, regenerated at each daemon start, compared in constant time.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. A request carrying any `Origin` header is rejected.
- `%LOCALAPPDATA%\tasklog\daemon.json` holds `{pid, port, token, version, protocol}`, relying on the per-user ACL of `%LOCALAPPDATA%`. A daemon is stale when its pid is not alive or its health check fails. Single instance is enforced by an exclusive lock on a separate lock file. `daemon.json` and `workspaces.json` are written atomically.

**Management endpoints** (JSON, all behind the token; there is no unauthenticated surface)

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP streamable HTTP |
| `GET /health` | `{ok, version, protocol, pid, uptime, workspaces: [{root, state: indexing\|ready}]}` |
| `POST /shutdown` | drain in-flight writes, then exit |
| `GET /workspaces` | list registered workspaces |
| `POST /workspaces` | register (idempotent); `{root, init?: true}` also creates `.tasklog/` |
| `DELETE /workspaces` | unregister |

**Workspaces**
- The shim resolves the root: it walks up from its working directory to the nearest ancestor containing `.tasklog/` and sends that absolute path in `X-TaskLog-Workspace` on every request (an optional `workspace` tool argument overrides it). A nested repo is its own workspace.
- The daemon validates the root (absolute, exists, contains `.tasklog/`) and canonicalizes it with realpath and Windows case-folding. Unregistered roots auto-register under the same rule. The registry persists at `%LOCALAPPDATA%\tasklog\workspaces.json`, is pruned when a directory disappears, and is overridable with CLI `add` and `remove`. A corrupt `workspaces.json` is set aside as `.bak` and rebuilt empty.
- No `.tasklog/` found: the shim still connects; workspace-scoped tools fail with `no_workspace` and a hint to run `init`. `tasklog init` or an MCP `init_workspace` tool (wrapping `POST /workspaces` with `init: true`) bootstraps a workspace.
- Each git worktree is an independent workspace keyed by absolute root. There is no cross-worktree reconciliation in v1; claims are per-checkout until merged by git.

**Lifecycle**
- The shim spawns the daemon detached (`spawn` with `detached`, `stdio: 'ignore'`, `windowsHide`, then `unref`, or whatever Spike 1 selects) and waits up to about 10 s for a healthy state file. It hides daemon restarts (re-resolve, respawn, retry the in-flight request once), exits only when stdin closes, and on spawn failure stays up and returns an MCP error per call.
- Daemon exit: after 30 minutes with no clients, or on `tasklog stop`, draining in-flight writes first.
- The daemon serves immediately and indexes each workspace in the background. A request waits on its own workspace's scan up to about 5 s, then fails with the retryable `indexing` error.
- During drain, new requests get `shutting_down` (503, retryable), the shim's restart-and-retry-once trigger.

**Versioning**
- One integer `protocol`, sent by every client in `X-TaskLog-Protocol` and reported by `/health`. The semver `version` is informational. Within a protocol number, changes are additive only.
- A newer shim asks an older daemon to drain and exit (`POST /shutdown`) and respawns it; other shims reattach. An older shim facing a newer daemon errors and never restarts it.
- The CLI follows the same rule, except `tasklog stop` and `tasklog status`, which work against any protocol and never restart anything.

## 3. Native format

Source: Native format (amended by Tracker doc for `type`).

**Layout and identity**
- All items live under `.tasklog/<effort>/`: `map.md`, `spec.md`, `tickets/NN-slug.md`. The directory is the parent, so there is no `parent` field.
- One item type with `kind: map | spec | ticket`, one parser and one set of generic edit operations.
- Item IDs are `<effort>/NN`, `<effort>/map`, `<effort>/spec`. They never change. The filename slug is cosmetic and never auto-renamed. Renaming an effort is unsupported in v1 (it appears as a delete plus a new effort).

**Frontmatter** (unknown keys are preserved)
- `kind`, `title` (no H1 duplicate in the body), `status`, `type` (tickets only, optional: `research | prototype | grilling | task`, omitted for implementation tickets), `claimed_by` (absent when unclaimed), `blocked_by` (same-effort numbers, or `effort/NN` across efforts), `tags`, `created`, `updated`.
- `status` is a fixed enum: `open | claimed | resolved | closed`. Closed means ruled out without resolving. Triage roles are ordinary tags.
- Tags are lowercase `[a-z0-9-]`. Slugs are lowercase kebab-case derived from the title.

**Bodies** (plain `##` headings, no sentinels)
- Ticket: `## Question` (required), `## Acceptance criteria`, `## Answer`. Unknown sections are left alone and sections are never reordered. Briefs and triage notes live in an unknown `## Comments` section.
- ACs are written `- [ ] #N text`. A fine-grained edit addresses an AC by item plus `#N`. A hand-added AC without a number gets the next free one on the daemon's next write.
- Resolving and closing both write their explanation to `## Answer`. There is no `resolved_at` or `closed_reason`; `updated` records when.
- Map: fixed headings Destination, Notes, Decisions so far, Not yet specified, Out of scope. Decisions so far is an append-only list of `- [title](relative/path.md): gist`.
- Spec: free-form body, edited by whole-section replace only.

**Numbering and edits**
- New ticket and AC numbers are `max + 1`, with no stored counters. An AC deleted from the end may have its number reused. The daemon closes tickets and never deletes them.
- Writes patch in place and preserve CRLF, key order, comments, quoting, blank lines and unknown sections. A one-field edit produces a one-line diff. New files use LF and canonical key order.
- The concurrency token is a content hash of the whole file, returned on reads and required on content writes. It is stored nowhere, and a stale hash is rejected.

## 4. Model and write protocol

Source: Daemon architecture, Workflow mapping (shared-store amendment), Node file watching.

**Two-layer model** (in memory only; never persisted; no journal)
- The **parsed-item store** is global to the daemon, keyed by the content hash of the file bytes. It holds immutable parse results (frontmatter, section offsets, ACs, search tokens) and is reference-counted by the workspace indexes that point at it, evicted at zero.
- A **workspace index** is per workspace: `path → {item id, hash}` plus effort and ID lookups. It is the only layer that knows paths.

**Write protocol** (synchronous write-through)
1. Verify the client's content hash against the bytes on disk; a stale hash is rejected with `stale_hash`.
2. Patch in place, write a temp file in the same directory, atomically rename.
3. Hash and parse the new bytes, register the result in the store, record the hash for self-write suppression, return the new hash.
- A per-file serial queue prevents interleaving. There is no write batching and no delete tool. `get` also returns on-disk mtime. Reads come from the model; writes always verify against disk.

**Watching and recovery**
- Watcher: chokidar v6, with events treated as hints. Scope is `.tasklog/**/*.md` only, no symlinks, never `.git` or `node_modules`.
- Inbound events are debounced (about 100 ms per path). Each debounced event stats, reads and hashes the file, drops it if the hash equals the last self-written or read content, otherwise reparses. Deletes remove the item; new files and new effort directories are picked up; a rename is a delete plus an add. Files not matching the layout are ignored.
- Unparseable files stay in the model as invalid items (path, parse error, last good hash), flagged in listings and refused for writes until they parse again.
- Duplicate Item IDs (for example from a git merge) are kept and flagged conflicted: lookup by that ID errors listing both paths, writes are refused, new numbers are still `max + 1` over all files, and nothing is renumbered automatically. Conflict detection stays within one workspace.
- Recovery is a full scan at start. Leftover temp files are swept at start and ignored by name pattern. A watcher error or missed event triggers a workspace rescan diffed by hash.

## 5. MCP tool surface

Source: Workflow mapping, Search design, Tracker doc, Daemon HTTP API. Server name `tasklog`, so tools appear as `mcp__tasklog__*`. Every write returns the new `hash` and takes one change per call. Full Item IDs appear in `id`.

| Tool | Inputs | Returns |
|---|---|---|
| `list_items` | `effort?, kind?, status?, type?, tags_all?, tags_any?, tags_none?, text?, snippet?, limit?, cursor?` | `items[]` (`id, title, kind, status, type, tags, claimed_by, blocked_by, hash, flags, matched_in, snippet?`), `total`, `cursor?` |
| `get_item` | `id` | frontmatter, body, `hash`, `mtime`, `path` |
| `create_effort` | `effort, title, destination?` | map and spec IDs |
| `create_item` | `effort, title, type?, question, blocked_by?, tags?` | `id, hash` |
| `set_fields` | `id, hash, title?, type?, tags?, blocked_by?, reopen?` | `hash` |
| `replace_section`, `append_to_section` | `id, hash, heading, content` | `hash` |
| `add_ac`, `edit_ac`, `toggle_ac`, `remove_ac` | `id, hash, n?, text?, checked?` | `hash, n` |
| `frontier` | `effort, type?, tags?, stale_after?` | `ready[]`, `claimed[]` with age and stale flag, `blocked[]` with reasons |
| `overview` | `effort?, format?` | see below |
| `claim`, `release` | `id, claimant, hash?, force?` | `hash` |
| `resolve` | `id, answer, gist?, hash?` | `hash`, per-step results |
| `close` | `id, reason, out_of_scope_gist?, hash?` | `hash`, per-step results |
| `add_decision`, `add_out_of_scope` | `effort, title_link, gist` | `hash` |
| `triage` | `id, state, category?, note?, hash?` | `hash` |
| `workspace_status` | none | indexing state, counts, `problems[]`, `recent_events[]` |
| `init_workspace` | `root?` | registered root |

**Rules**
- `hash` is required on content edits (`set_fields`, section and AC edits) and optional on `claim`, `release`, `resolve`, `close` and `triage`, whose own status preconditions are the guard.
- `set_fields` cannot set `status` except `reopen: true` (back to `open`). `claimed` comes only from `claim`, `resolved` only from `resolve`, `closed` only from `close`, so the `## Answer` side effect cannot be skipped.
- `effort` is required on ticket creation, with no default; the tracker doc tells agents to start a new effort (map and spec) for each new body of work.
- `type` filters on `frontier` match only typed tickets.
- Workflow tools are composed from the same internal operations as the generic ones.

**Frontier.** A ticket is ready when it is `open` and every `blocked_by` entry is `resolved` or `closed`; a ruled-out blocker does not strand its dependents. A missing, conflicted or invalid blocker counts as not done and is reported as a reason. Cross-effort blockers resolve the same way. Order is ticket number.

**Overview.** Read-only, from the model, no `hash`. For one effort it returns: the map's Destination; counts by status; **Done** (resolved tickets with their Decisions-so-far gists); **In progress** (claimed tickets with `claimed_by`, age and stale flag); **Ready** (the frontier); **Blocked** (with the blocking tickets' titles and states); **Still to do** (the map's Not yet specified verbatim); **Ruled out** (closed tickets and the map's Out of scope). It flags drift: a resolved ticket with no Decisions-so-far line, or a Decisions line whose ticket is not resolved. With no `effort` it returns one line per effort (counts and the Destination's first sentence). Result is markdown plus structured content (`format: markdown | json`, default both).

**Claims**
- `claim` succeeds only on an `open` item and sets `status: claimed` and `claimed_by`; the per-file queue makes it atomic within a checkout. Re-claiming with the same claimant is idempotent; a different claimant gets `already_claimed`.
- No TTL and no auto-expiry. A claim is stale when `updated` is older than `stale_after` (default 24 h); `frontier` and `overview` list stale claims with their age. `release` returns a ticket to `open`; releasing someone else's claim needs `force`.
- Claims are per-checkout: two worktrees can both claim a ticket, and the collision surfaces as an ordinary git conflict. Documented, not prevented.

**Resolution**
- `resolve` writes `## Answer`, sets `resolved` and clears `claimed_by`. With `gist` and a map, it then appends `- [title](tickets/NN-slug.md): gist` to Decisions so far.
- The ticket is written first and the map second. There is no cross-file atomicity; the append is idempotent on its link target, so retrying is safe. Step results are `ok`, `skipped` or `failed`.
- `close` writes `## Answer`, sets `closed`, clears `claimed_by`, and with `out_of_scope_gist` appends to the map's Out of scope section.

**Triage.** Roles are tags. `triage` keeps exactly one state tag and one category tag, replacing rather than adding. `wontfix` is a state tag plus `status: closed` with the reason in `## Answer`. Briefs and notes go under `## Comments` via `append_to_section`, with the triage disclaimer kept as the first line. `.out-of-scope/` stays with the skill; the daemon never touches it.

**implement-spec and worktrees.** Implementers only `toggle_ac` on their own ticket in their own worktree, so each branch touches one ticket file and merges cleanly. They never claim, resolve or touch the map. The orchestrator calls `resolve` on the integration worktree after each merge (or once at the end), passing the merge commit as the answer if it has no written one. The daemon never runs git or commits; agents commit `.tasklog/` changes with the code.

## 6. Search

Source: Search design.

- **Tag filters:** flat ANDed parameters `tags_all`, `tags_any`, `tags_none`; tags lowercased on write and query and matched exactly. No expression language, nested OR or wildcards. Tag filters AND with `effort`, `kind`, `status`, `type` and `text`.
- **Text searched:** title, Item ID, tags, and every body section (`## Question`, `## Answer`, ACs, `## Comments`, unknown sections). Other frontmatter fields have structured filters instead.
- **Tokenisation:** lowercase, Unicode-normalise and fold diacritics, split on non-alphanumerics; identifier-like strings (`list_items`, `07-daemon`) are kept whole as well as in parts. Matching is whole-word or prefix. No stemming, fuzzy matching or stop words. A multi-word query is an implicit AND; `"quotes"` is an exact phrase; a leading `-` excludes a term.
- **Ranking:** field-weighted (title > tag > Question or Answer > other body; more matched terms score higher); ties by effort then ticket number. No BM25. Without `text`: effort then ticket number. Each result carries `matched_in`.
- **Index:** per-file token data in the parsed-item store, computed at parse time, keyed by content hash; queries scan linearly; nothing persisted.
- **Paging:** `limit` default 50, hard cap 200; offset `cursor` tied to the model version, with `total` (pre-paging match count). A stale cursor returns the retryable `stale_cursor`. `snippet: true` adds a ~160-character excerpt and is off by default.

## 7. Errors and logging

Source: Logging and observability, Workflow mapping, Daemon HTTP API.

**Error table.** One entry per code: stable `code`, a one-sentence human `message` ending with the next step, `retryable`, structured `details`. The same entry feeds MCP tool errors, CLI output and the log.

| Class | Codes | Log level |
|---|---|---|
| Caller-caused | `stale_hash` (retryable after re-read), `stale_cursor` (retryable), `not_found`, `already_claimed` (carries `claimed_by`), `not_claimed`, `bad_transition`, `bad_request` | info |
| Infrastructure | `indexing` (retry), `shutting_down` (retry), `unauthorized`, `protocol_mismatch`, `no_workspace` | info |
| State problems | `conflicted` (lists both paths), `invalid_item`, `partial` (retry; per-step results) | warn |
| Unexpected | `internal` (carries `request_id`) | error |

Management endpoints return `{error: {code, message, retryable}}` (HTTP 401 `unauthorized`, 409 `protocol_mismatch`, 503 `indexing` and `shutting_down`, 404 `no_workspace`, 400 `bad_request`). Inside `/mcp` the same codes surface as tool errors.

**Logs**
- Directory `%LOCALAPPDATA%\tasklog\logs\`. `daemon.log` is written only by the daemon; shims share one append-only, low-volume `shim.log` (spawn, reconnect, version skew, errors). `tasklog serve` in the foreground also mirrors to stderr.
- JSON lines `{ts, level, event, workspace?, request_id?, ...fields}` with stable dotted event names (`workspace.registered`, `scan.finished`, `item.write`). Levels `error | warn | info | debug`; default `info`; `TASKLOG_LOG_LEVEL` sets it; `serve --verbose` means `debug`.
- Rotation by size, no library: `daemon.log` at 5 MB keeping 3 files, checked at start and on each write; `shim.log` checked at start and rotated once at 1 MB with one backup, best-effort (a failed rename is ignored).
- Always logged at `info` and above: daemon start and stop (version, protocol, pid, port, never the token); workspace registered, unregistered, pruned; scan start and finish with counts, duration and rescan reason; every successful write as `item.write` (item ID, operation, new hash, never content); items becoming invalid or conflicted and clearing; every tool or request error. `debug` adds reads, individual watcher events and each self-write suppression decision; rescans log a summary count of suppressed events.

**Exposing problems.** `workspace_status` returns counts plus `problems[]` (current invalid and conflicted items with path, error and start time) and `recent_events[]` (the last 50 warn and error events for the workspace, from an in-memory ring buffer, never persisted). `doctor` includes both and prints the log paths; if the daemon is unreachable it falls back to the last 10 warn and error lines of `daemon.log`.

## 8. CLI

Source: CLI surface, Import migration. One binary, `tasklog`. No item-level commands and no `call` escape hatch in v1.

| Command | Behaviour | Needs daemon |
|---|---|---|
| `shim` | stdio MCP entry point; resolves workspace from the working directory; optional `--workspace <path>`; stdout carries only protocol traffic | starts it |
| `serve` | run the daemon in the foreground (what the shim's spawn runs; the debug route) | is it |
| `start` | spawn detached, return once healthy | starts it |
| `stop` | ask the daemon to drain and exit; no-op success if stopped | never starts |
| `status` | report daemon state; exit 3 if none running | never starts |
| `init` | create `.tasklog/` and register the workspace; registers via the daemon only if one is running, else the first shim connection auto-registers | offline |
| `add <path>`, `remove <path>`, `list` | manage the registry; the daemon is the only writer of `workspaces.json` | starts it |
| `import <path>` | see section 9 | offline |
| `doctor` | install verification | starts it |
| `--version` | version and protocol | offline |

- Output is human text by default; `--json` on `status`, `list`, `doctor`, `import`. Data on stdout, diagnostics on stderr. `--workspace` is accepted by `init`, `status`, `list`, `doctor` and `shim`.
- Exit codes: `0` success; `1` ran but failed (import with skipped files, any failing doctor check); `2` usage error; `3` `status` found no daemon; `4` protocol mismatch (CLI refuses to act against a newer daemon).
- `doctor` starts the daemon if none is running (proving spawn and health is the point; `status` is the non-starting probe) and reports `{name, ok, detail, fix}` for: Node version; data and log directories writable; `daemon.json` fresh or stale; daemon health and protocol match; `workspaces.json` readable; current directory resolves to a workspace; that workspace has no invalid or conflicted items (with `problems[]` and `recent_events[]`); `claude` on PATH and `tasklog` in `claude mcp list` (skipped, not failed, when `claude` is absent). Exit 0 if all pass, else 1.

## 9. Import

Source: Import migration, backlog.md schema, Native format.

**Invocation.** `tasklog import <path>` auto-detects a backlog layout (`backlog/` with `config.yml`) or a scratch layout (`.scratch/<effort>/`), writes into `.tasklog/` in the same workspace, and never modifies the source. It runs in-process with no daemon; the watcher or rescan picks the new files up. `--dry-run` reports without writing. `--effort <name>` forces everything into one effort; `--group-by none` is the equivalent opt-out of milestone splitting.

**Effort mapping.** Scratch: each effort directory becomes an effort of the same name (`issues/NN-*.md` becomes `tickets/NN-*.md`). Backlog: each milestone becomes its own effort named by the milestone slug; unmilestoned tasks go to one effort `backlog`. No milestone tag is added.

**IDs and links**
- Scratch `NN` becomes `effort/NN`. Backlog `BACK-743` in milestone `v2-launch` becomes `v2-launch/743` (prefix dropped, number kept). Dependencies resolve by numeric ID across active and archived tasks and may cross efforts; an unresolvable dependency is dropped from `blocked_by` and listed in the report.
- Two backlog tasks sharing a numeric ID in one effort: the second gets the next free number and the report flags it. Backlog subtasks (`BACK-743.1`) get a fresh number after the max and the tag `parent-743`.
- Scratch body links `issues/NN-x.md` are rewritten to `tickets/NN-x.md`; other relative links are left alone.
- Every imported item gets `imported_from: <source-relative path>` frontmatter, recording provenance and driving idempotency.

**Status mapping**
- Scratch: `open`, `claimed`, `resolved` map directly. A triage role in `Status:` becomes `open` plus the role tag; `wontfix` becomes `closed` plus the tag. `Label: wayfinder:map` and `Type:` fold into `kind` and `type`.
- Backlog: the last configured status becomes `resolved`, the first `open`, a middle status `claimed` (with `claimed_by` as the first assignee or `imported`, original status name kept as a tag). `drafts/` becomes `open` plus tag `draft`; `archive/` becomes `closed` plus tag `archived`; legacy `completed/` becomes `resolved`. Backlog `labels` become `tags`.

**Content with no native equivalent.** Unknown frontmatter keys are carried over verbatim; priority is also mirrored as a tag (`priority-high`). Backlog PLAN and NOTES sentinel sections become `## Implementation plan` and `## Implementation notes` with sentinels stripped and ACs written `- [ ] #N text`. Scratch `## Comments` and other sections are kept. Backlog `docs/`, `decisions/` and `milestones/` are not imported and are listed as skipped.

**Failures and reporting.** Everything is parsed first and built in a temp staging directory; a file that fails to parse is skipped and recorded, and import continues. Staging then moves into `.tasklog/` in one step, so there are never half-written efforts. The command prints imported, skipped (with reasons) and warnings (dropped dependencies, ID collisions, dropped sections) and exits non-zero if anything was skipped. No report file is written.

**Idempotency.** Re-running skips items whose `imported_from` is already present and never overwrites, so hand edits survive; new source files are added. If the target effort exists with non-imported items, only missing items are added, with a warning. There is no update-from-source mode. `created` and `updated` come from the source (`created_date` for backlog, file mtime for scratch).

**Test note.** The globs that find backlog task files after a prefix change were never traced; the importer needs a fixture test for it.

## 10. Tracker doc and setup

Source: Tracker doc and setup skill.

- A new seed template `issue-tracker-tasklog.md` in the setup skill, with the same headings the skills already read (Conventions, "publish to the issue tracker", "fetch the relevant ticket", Wayfinding operations). Every instruction is an MCP tool call; no file paths. The skills need no code change because they defer to the tracker doc. Full text: Appendix B.
- Discovery: the doc names the server `tasklog`. If its tools are missing, the agent tells the user to run `/setup-matt-pocock-skills` and never falls back to editing files.
- MCP config: user scope, `claude mcp add --scope user tasklog -- tasklog shim` (no `cmd /c` wrapper; verified by Spike 2), after checking `claude mcp list`. No repo-level `.mcp.json`. Other MCP clients get a printed snippet.
- The setup skill's Section A gains a "TaskLog" option: detect (a `.tasklog/` directory, or `tasklog` on PATH) and offer it first; write `docs/agents/issue-tracker.md`; update the `## Agent skills` block; write `triage-labels.md` with the five roles as tags; verify with `workspace_status` or `tasklog doctor`.
- Migration: if `.scratch/` has efforts, setup offers `tasklog import .scratch --dry-run`, shows the report, then runs the real import on approval and rewrites `docs/agents/issue-tracker.md`. It never edits or deletes `.scratch/`; the user commits `.tasklog/`.

## 11. Packaging

Source: Windows packaging research (branch `research/windows-packaging`); the choice is made here.

**Decision (v1): npm global install.**
- `npm i -g tasklog`, `engines` Node `>=24`. Node 26 is Active LTS and Node 24 is Maintenance LTS until 2028-04-30; Node 22 ends 2027-04-30 and is not accepted. `engines` is advisory unless engine-strict is set, so `doctor` checks the Node version.
- Registration: `claude mcp add --scope user tasklog -- tasklog shim`. Spike 2 showed the `.cmd` shim launches without a `cmd /c` wrapper. A global install avoids the `npx` first-run delay against Claude Code's 30 s MCP startup timeout.
- Not in v1: Node single executable (Stability 1.1, single-script embedding, `.exe` extension) and a bundled installer. Both bring code signing and SmartScreen reputation cost, and the Artifact Signing programme is open to individuals only in the USA and Canada.
- Data in `%LOCALAPPDATA%\tasklog\` (`daemon.json`, `workspaces.json`, lock file, `logs\`); this is machine-local state, so Local rather than Roaming.

**Build rules that follow from upgrading on a running Windows daemon**
- The published package is bundled into one ESM file per entry point, so a running daemon never lazy-loads a file an upgrade just replaced.
- No native addons in the daemon (chokidar v6 is pure JS).
- Upgrade path: `npm i -g tasklog`, then the protocol-mismatch restart from section 2; `tasklog stop` first is recommended and documented.

## 12. Testing

Source: Test strategy.

**Runner and layers.** Vitest, TypeScript, ESM. Four layers, each with its own directory and `npm` script:
1. **Unit:** parser, minimal-diff editor, search tokenizer and ranking, ID and numbering logic; pure, no filesystem, no clock.
2. **Integration:** the real daemon core in-process against a temp workspace on a real disk, driven through the HTTP API, no shim.
3. **MCP e2e:** the real built `tasklog shim` as a child process, spawned by the official MCP client SDK over stdio, talking to a real detached daemon.
4. **Spike and soak** (manual or opt-in): excluded from the default `npm test`.

**Watching and self-write suppression.** The core takes the watcher event source, clock and debounce as injectable dependencies. Most tests feed synthetic events (add, change, unlink, burst, duplicate) and advance time by hand, covering debounce, coalescing, hash-equality drops and rename as delete plus add. A small set of real-chokidar tests runs against a temp directory and waits on the daemon's own log events (`scan.finished`, `item.changed`), never fixed sleeps. **Rescan as oracle:** after any scenario, a full rescan must produce a model identical to the live incremental one.

**Concurrency and stale-hash** (integration layer, using a test hook that pauses a write between hash verification and rename)
- Two writers racing one file: exactly one succeeds, the other gets `stale_hash`.
- An external edit between a client's read and write is detected.
- The per-file queue applies interleaved edits to different ACs of one ticket in order.
- A write that fails mid-way leaves the original whole and no temp file behind.
- Each case also gets a seeded randomized run: N parallel clients applying random operations, asserting the file on disk always parses and equals a rescan.

**Fixture corpus** (`test/fixtures/`, real trees copied to a temp directory per test)
- Native: a normal workspace plus broken ones: invalid frontmatter, duplicate item IDs, an unknown frontmatter key (preserved), CRLF and LF, a UTF-8 BOM, non-ASCII titles for diacritic-folded search.
- Import: a backlog-layout tree (prefix change, milestones, subtasks, drafts, archive, unresolvable dependencies) and a scratch-layout tree (a copy of `.scratch/tasklogmd`), each with a checked-in golden native tree.
- Every minimal-diff edit test asserts the byte-exact file diff, not just the parsed result.

**CI split.** Unit and integration run on every change on Windows, and on Linux where the filesystem allows. MCP e2e runs on Windows only. Spikes and Claude-Code-in-the-loop checks stay manual, re-run by hand before a release.

## 13. Spikes

Three throwaway scripts, run before any feature slice, each recording pass or fail and the winning approach in this section. Spike 1 gates everything; Spikes 2 and 3 change packaging details only.

**Spike 1: detach and tree kill.** Real Windows 11 with the real Claude Code. Passes only if all five hold:
1. A shim launched via `claude mcp add` leaves the detached daemon running when Claude Code exits normally.
2. The same holds when Claude Code is killed as a process tree (Task Manager End Task, `taskkill /T /F`). Claude Code closes the shim's stdin and ends its process tree about 300 ms later.
3. A second Claude Code session's shim finds that daemon through `daemon.json` and connects without spawning another.
4. No console window flashes at spawn.
5. The daemon survives closing the terminal that started Claude Code.

If 1, 2 or 5 fails, move to the next fallback in order: `cmd /c start`, then a one-shot scheduled task. Report which approach passed and update section 2's lifecycle to name it. If every approach fails, reopen the architecture.

**Spike 2: launch from Claude Code.** Does `claude mcp add -- tasklog shim` work against the global-install `.cmd` shim without `cmd /c`, and does the shim reach healthy within the 30 s startup timeout (including a cold start that spawns the daemon)? Settles open verification item V1.

**Spike 2 result (2026-11-17, Claude Code 2.1.327, npm 11.19, Windows 11).** V1: yes. A stub package installed with `npm i -g <local path>` produced `tasklogspike2` and `tasklogspike2.cmd` in `%APPDATA%\npm`. `claude mcp add --scope user spike2 -- tasklogspike2 shim` (no `cmd /c`) connected, and a headless `claude -p` session called the stub's `ping` tool and got its reply. The `cmd /c` fallback was not needed and was not exercised. Cold start (no daemon; shim spawned a detached stub daemon and held `initialize` until it answered health) took about 130 ms to healthy, far inside the 30 s timeout. Caveats: the stub daemon is a trivial HTTP server, so a real daemon's startup (SQLite open, index build) is not measured; one run only. Code: `spikes/02-launch/`.

**Spike 3: upgrade with a running daemon.** Run `npm i -g` over a version while a daemon is up. Does the replace succeed, does the old daemon keep serving, and does the newer shim restart it? Settles V2.

**Open verification items** (research could not settle these from official sources)

| # | Question | Settled by |
|---|---|---|
| V1 | Do `.cmd` shims (npm global bins) launch correctly as an MCP server on Windows without a `cmd /c` wrapper? | Spike 2: yes, no wrapper needed |
| V2 | Can a running exe or its package files be replaced on upgrade? | Spike 3 |
| V3 | Does SmartScreen apply to files installed by npm? | observed during Slice 13 release testing |

## 14. Build slices

Each slice is a vertical tracer that `/to-tickets` turns into one ticket. Order is the build order; "depends on" names slice numbers. ACs use the native `- [ ] #N` form, are phrased "given / when / then", and end with the layer that proves them: `[unit]`, `[integration]`, `[e2e]`, `[manual]`. HITL slices need a real Windows session; the rest are AFK.

### Slice 1: Spikes (HITL)
Depends on: none. Scope: section 13's three spikes. Out of scope: any product code.
- [ ] #1 Given the five-point bar, when Spike 1 runs, then it records pass or fail per point and names the winning spawn approach in section 13. [manual]
- [ ] #2 Given Spike 2, when it runs, then V1 is answered and the `claude mcp add` command line is fixed in sections 10 and 11. [manual]
- [ ] #3 Given Spike 3, when it runs, then V2 is answered and the upgrade steps in section 11 are confirmed or corrected. [manual]

### Slice 2: Walking skeleton (AFK)
Depends on: 1. Scope: package and bundle setup; shim to daemon to `/health`; `daemon.json` and lock file; token, Host and Origin checks; workspace resolution and registration; `workspaces.json`; `workspace_status` and `init_workspace`; minimal `doctor`; `status`, `stop` and `serve`; logging setup. Out of scope: items.
- [ ] #1 Given no daemon, when a shim connects from a directory under a `.tasklog/` root, then it spawns the daemon, registers the workspace and `workspace_status` returns `ready`. [e2e]
- [ ] #2 Given a request without the bearer token, or with an `Origin` header, or a wrong `Host`, when sent to any endpoint, then it is rejected `unauthorized`. [integration]
- [ ] #3 Given a stale `daemon.json` (dead pid), when a shim starts, then it replaces it and connects. [integration]
- [ ] #4 Given a directory with no `.tasklog/`, when a tool needing a workspace is called, then it fails `no_workspace` with an `init` hint. [e2e]
- [ ] #5 Given a newer shim and an older daemon, when they connect, then the daemon drains, exits and is respawned; an older shim facing a newer daemon errors without restarting it. [integration]
- [ ] #6 Given idle clients, when 30 minutes pass, then the daemon exits. [integration, injected clock]

### Slice 3: Parser, scan and read tools (AFK)
Depends on: 2. Scope: frontmatter and body parser, the two-layer model, startup scan with invalid and conflicted items, `get_item`, `list_items` with structured filters and paging. Out of scope: text search, writes.
- [ ] #1 Given the native fixture workspace, when scanned, then every item is in the index with the right ID, kind, status and ACs. [integration]
- [ ] #2 Given an invalid file, when scanned, then it appears flagged invalid and `get_item` on it fails `invalid_item`. [integration]
- [ ] #3 Given duplicate Item IDs, when scanned, then both are kept, lookup fails `conflicted` listing both paths. [integration]
- [ ] #4 Given an unknown frontmatter key, CRLF, a BOM or unknown sections, when parsed, then all are preserved in the parse result. [unit]
- [ ] #5 Given `list_items` with filters and a cursor, when the model version changes, then the next page fails `stale_cursor`. [integration]

### Slice 4: Minimal-diff editor and write protocol (AFK)
Depends on: 3. Scope: `set_fields`, `replace_section`, `append_to_section`, `add_ac`, `edit_ac`, `toggle_ac`, `remove_ac`; hash verification; temp-and-rename; per-file queue; the concurrency test hook. Out of scope: watcher.
- [ ] #1 Given a one-field edit, when written, then the file diff is exactly one line, with CRLF, key order, comments and quoting preserved. [unit]
- [ ] #2 Given a stale hash, when a content edit is sent, then it fails `stale_hash` and the file is unchanged. [integration]
- [ ] #3 Given two writers racing one file, when both write, then exactly one succeeds and the other gets `stale_hash`. [integration]
- [ ] #4 Given a failure mid-write, when it occurs, then the original is whole and no temp file remains. [integration]
- [ ] #5 Given a hand-added AC without a number, when the next write occurs, then it gets the next free number. [integration]
- [ ] #6 Given the seeded randomized run, when N clients apply random operations, then the file always parses and equals a rescan. [integration]

### Slice 5: Watcher, self-write suppression and rescan (AFK)
Depends on: 4. Scope: chokidar v6 watcher, debounce, hash-equality drops, create, delete and rename handling, rescan on error. Out of scope: notifications.
- [ ] #1 Given a daemon write, when the watcher fires, then no reparse occurs. [integration, real chokidar]
- [ ] #2 Given an external edit, when the debounce elapses, then the model updates and the next write needs the new hash. [integration]
- [ ] #3 Given a burst of events for one path, when time advances, then they coalesce into one read. [unit, injected clock]
- [ ] #4 Given a rename, when seen, then the old item is removed and the new one added. [integration]
- [ ] #5 Given any scenario, when a full rescan runs, then its model equals the live incremental model. [integration]
- [ ] #6 Given a watcher error, when it fires, then a rescan runs and is logged with its reason. [integration]

### Slice 6: Creation and numbering (AFK)
Depends on: 4. Scope: `create_effort`, `create_item`, `max + 1` ticket numbers, slug derivation, canonical new-file format.
- [ ] #1 Given a new effort, when created, then `map.md` and `spec.md` exist with the fixed map headings, LF endings and canonical key order. [integration]
- [ ] #2 Given existing tickets, when one is created, then its number is `max + 1` over all files including conflicted ones. [integration]
- [ ] #3 Given `create_item` without `effort`, when called, then it fails `bad_request`. [integration]
- [ ] #4 Given `create_item` with `blocked_by` and `tags`, when created, then they are written normalized (lowercase tags, `effort/NN` cross-effort). [unit]
- [ ] #5 Given `type` omitted, when a ticket is created, then no `type` key is written. [unit]

### Slice 7: Workflow tools (AFK)
Depends on: 6. Scope: `frontier`, `overview`, `claim`, `release`, `resolve`, `close`, `add_decision`, `add_out_of_scope`, `triage`.
- [ ] #1 Given blockers resolved or closed, when `frontier` runs, then the ticket is ready; a missing, conflicted or invalid blocker keeps it blocked with a reason. [integration]
- [ ] #2 Given an open ticket, when two claimants claim it, then one succeeds and the other gets `already_claimed`; the same claimant twice is idempotent. [integration]
- [ ] #3 Given a claim older than `stale_after`, when `frontier` or `overview` runs, then it is listed stale with its age. [integration]
- [ ] #4 Given `resolve` with `gist`, when it runs, then `## Answer` is written, status is `resolved`, `claimed_by` is cleared and the Decisions line is appended once even if retried. [integration]
- [ ] #5 Given the map append fails, when `resolve` runs, then it returns `partial` with per-step results and a retry completes it. [integration]
- [ ] #6 Given `close` with `out_of_scope_gist`, when it runs, then the ticket is `closed` and the line is appended to Out of scope. [integration]
- [ ] #7 Given `overview` for a drifted effort, when it runs, then the drift is flagged. [integration]
- [ ] #8 Given `triage`, when called twice with different states, then exactly one state tag and one category tag remain. [integration]

### Slice 8: Search (AFK)
Depends on: 3. Scope: tokenization in the parsed-item store, `text`, `tags_all`, `tags_any`, `tags_none`, ranking, `matched_in`, `snippet`.
- [ ] #1 Given a title with diacritics, when searched without them, then it matches. [unit]
- [ ] #2 Given `"exact phrase"` and `-term`, when queried, then phrase and exclusion are honoured against the token sequence. [unit]
- [ ] #3 Given a title hit and a body hit, when ranked, then the title hit sorts first and `matched_in` lists the fields. [unit]
- [ ] #4 Given `list_items` with `limit` above 200, when called, then it is capped at 200 and `total` is the pre-paging count. [integration]
- [ ] #5 Given identifier text like `list_items`, when searched by a part or the whole, then it matches. [unit]

### Slice 9: Error table and observability (AFK)
Depends on: 7. Scope: the error table, `workspace_status` `problems[]` and `recent_events[]`, log rotation, `item.write` and other events.
- [ ] #1 Given each error code, when raised, then its MCP error, HTTP error and log entry carry the same code, message and `retryable`. [integration]
- [ ] #2 Given an unexpected exception, when it occurs, then the client gets `internal` with a `request_id` that appears in `daemon.log`. [integration]
- [ ] #3 Given `daemon.log` over 5 MB, when written, then it rotates keeping three files; `shim.log` rotates at 1 MB with one backup and ignores a failed rename. [integration]
- [ ] #4 Given an invalid item and a conflict, when `workspace_status` runs, then `problems[]` lists both with path, error and start time. [integration]
- [ ] #5 Given more than 50 warn events, when `workspace_status` runs, then `recent_events[]` returns the latest 50 only. [integration]
- [ ] #6 Given a successful write, when logged, then the entry has the item ID, operation and hash and no content. [integration]

### Slice 10: Full CLI (AFK)
Depends on: 2. Scope: `start`, `status`, `stop`, `add`, `remove`, `list`, `init`, `--json`, exit codes, the full `doctor` checks.
- [ ] #1 Given no daemon, when `status` runs, then it exits 3 and does not start one; `stop` exits 0. [e2e]
- [ ] #2 Given `add`, `remove` or `list` with no daemon, when run, then one is started and the registry is updated through it. [e2e]
- [ ] #3 Given a directory, when `init` runs offline, then `.tasklog/` exists and the first shim connection registers it. [e2e]
- [ ] #4 Given any `--json` command, when run, then stdout is valid JSON and diagnostics go to stderr. [integration]
- [ ] #5 Given a newer daemon, when a CLI command other than `stop` or `status` runs, then it exits 4. [integration]
- [ ] #6 Given a broken install (stale `daemon.json`, unwritable log directory, missing `claude`), when `doctor` runs, then each check reports `{name, ok, detail, fix}`, `claude` absent is skipped not failed, and the exit code is 1 only if a check failed. [integration]

### Slice 11: Import (AFK)
Depends on: 3. Scope: section 9 in full.
- [ ] #1 Given the scratch fixture (a copy of `.scratch/tasklogmd`), when imported, then the output equals the checked-in golden tree. [integration]
- [ ] #2 Given the backlog fixture, when imported, then milestones become efforts, prefixes are dropped, subtasks get `parent-NNN` tags and unresolvable dependencies are dropped and reported. [integration]
- [ ] #3 Given a file that fails to parse, when imported, then it is skipped and reported, the rest completes in one staged move and the exit code is 1. [integration]
- [ ] #4 Given a second run, when imported again, then already-imported items are skipped untouched and hand edits survive. [integration]
- [ ] #5 Given `--dry-run`, when run, then nothing is written. [integration]
- [ ] #6 Given a prefix change in the backlog fixture, when task files are located, then none are missed. [integration]

### Slice 12: Tracker doc, setup skill and registration (HITL)
Depends on: 7, 9, 10, 11. Scope: Appendix B template, the setup skill's TaskLog option, user-scope registration, scratch-to-native migration prompt.
- [ ] #1 Given a repo with `.tasklog/`, when `/setup-matt-pocock-skills` runs, then it offers TaskLog first, writes `docs/agents/issue-tracker.md` from the template and `triage-labels.md` with the five roles as tags. [manual]
- [ ] #2 Given `tasklog` not yet registered, when setup runs, then it runs `claude mcp add --scope user` per Spike 2's result and skips if already registered. [manual]
- [ ] #3 Given a repo with `.scratch/` efforts, when setup runs, then it shows the `import --dry-run` report, imports on approval and leaves `.scratch/` untouched. [manual]
- [ ] #4 Given the TaskLog tracker doc, when wayfinder, to-tickets, implement-spec and triage run a full pass, then none edits a file by hand. [manual]

### Slice 13: Release (HITL)
Depends on: 12. Scope: bundling to single ESM files, the `engines` field, publish, upgrade path, V3.
- [ ] #1 Given the published package, when installed globally on a clean Windows machine, then `tasklog --version` and `tasklog doctor` pass. [manual]
- [ ] #2 Given a running daemon, when a newer version is installed, then the newer shim restarts it and no lazy-load error occurs. [manual]
- [ ] #3 Given the bundle, when inspected, then there is one ESM file per entry point and no native addon. [integration]
- [ ] #4 Given a fresh npm install, when run, then whether SmartScreen warns is recorded as the answer to V3. [manual]

## Appendix A: Amendments applied

- Daemon architecture (model): Workflow mapping replaced the per-workspace model with the two-layer parsed-item store plus workspace index (section 4).
- Workflow mapping (`create_item`, `set_fields`): Tracker doc made `type` optional for implementation tickets (sections 3 and 5).
- Workflow mapping (`list_items`): Search design added `tags_none`, `snippet`, `total`, `matched_in` and the `stale_cursor` error (sections 5 and 6).
- Workflow mapping (error list): Logging and observability and the HTTP API added `unauthorized`, `protocol_mismatch`, `no_workspace`, `shutting_down`, `stale_cursor` and `internal` (section 7).
- Import migration (effort required): `effort` is required on `create_item` with no default (section 5).
- Daemon architecture (detached spawn): the approach is now gated by Spike 1 (sections 2 and 13).

## Appendix B: TaskLog tracker doc template

This is the content of the new seed template `issue-tracker-tasklog.md` in the setup skill. Slice 12 writes it into a repo as `docs/agents/issue-tracker.md`.

````markdown
# Issue tracker: TaskLog

Issues and specs for this repo live in TaskLog, accessed through the `tasklog` MCP server (tools appear as `mcp__tasklog__*`). If those tools are missing, tell the user to run `/setup-matt-pocock-skills`. Never fall back to editing files under `.tasklog/`.

## Conventions

- Items live in TaskLog. Never edit `.tasklog/` files by hand.
- Refer to items by Item ID (`effort/NN`), never by path.
- Start a new effort (map and spec) for each new body of work: `create_effort`.
- The daemon never runs git. Commit `.tasklog/` changes with the code and check git status yourself.
- Triage roles are tags: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Tool cheat-sheet: `list_items`, `get_item`, `create_effort`, `create_item`, `set_fields`, `replace_section`, `append_to_section`, `add_ac`, `edit_ac`, `toggle_ac`, `remove_ac`, `frontier`, `overview`, `claim`, `release`, `resolve`, `close`, `add_decision`, `add_out_of_scope`, `triage`, `workspace_status`.
- Content edits take the `hash` returned by the last read or write. On `stale_hash`, re-read and retry.

## When a skill says "publish to the issue tracker"

- A spec: `create_effort(effort, title, destination?)` if the effort is new, then `replace_section` on `<effort>/spec`; tag `ready-for-agent` through `set_fields`.
- Tickets: `create_item(effort, title, question, blocked_by, tags)` once per ticket in dependency order so blockers already have IDs; `add_ac` for each acceptance criterion; cross-reference by `effort/NN`.

## When a skill says "fetch the relevant ticket"

`get_item(id)`.

## Wayfinding operations

- Orient and pick: `overview(effort)`, then `frontier(effort)`; claim with `claim(id, claimant)` before any work.
- Resolve: `resolve(id, answer, gist)`; new tickets via `create_item` and `set_fields`; graduate fog with `replace_section` on the map's Not yet specified; ruled-out tickets via `close(id, reason, out_of_scope_gist)`.

## implement-spec

Read the graph with `list_items(effort, kind=ticket)` and `get_item`. Implementers only `toggle_ac` on their own ticket. The orchestrator calls `resolve` on the integration worktree.

## Triage

`list_items(tags_any=needs-triage)`, `get_item`, `append_to_section(id, "Comments", ...)` keeping the triage disclaimer as the first line, `triage(id, state, category, note)`, and `close` for `wontfix`.
````
