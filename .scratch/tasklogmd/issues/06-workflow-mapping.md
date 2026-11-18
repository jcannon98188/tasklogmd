Type: grilling
Status: resolved
Blocked by: 05

## Question

Map the wayfinder, implement-spec and triage workflows onto TaskLog operations. Decide the MCP tool list and signatures (generic fine-grained tools and workflow tools), the frontier query, claim semantics when several agents or worktrees run concurrently (including stale-claim recovery), how resolution and Decisions-so-far are recorded, and how implement-spec's per-ticket branches and worktrees interact with files that live in the repo.

## Answer

Settled by grilling with the user (all recommendations accepted; the user added the shared cache and the overview query). Terms added to `GLOSSARY.md`: Claim, Frontier, Stale claim, Overview.

> Amended by the tracker doc ticket (09): `type` is optional on `create_item` and `set_fields`, omitted for implementation tickets.

**Tool surface** (full Item ID in `id`; every write returns the new `hash`; one write per call, no batching in v1; no delete tool)

| Tool | Inputs | Returns |
|---|---|---|
| `list_items` | `effort?, kind?, status?, type?, tags_all?, tags_any?, text?, limit?, cursor?` | summaries: `id, title, kind, status, type, tags, claimed_by, blocked_by, hash, flags` |
| `get_item` | `id` | frontmatter, body, `hash`, `mtime`, `path` |
| `create_effort` | `effort, title, destination?` | map and spec IDs |
| `create_item` | `effort, title, type, question, blocked_by?, tags?` | `id, hash` |
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
| `workspace_status` | none | indexing state, counts, invalid and conflicted items |

- `hash` is required on content edits (`set_fields`, section and AC edits) and optional on `claim`, `release`, `resolve`, `close` and `triage`: their own status preconditions are the guard.
- `set_fields` cannot set `status` except `reopen: true` (back to `open`). `claimed` and `resolved` come only from `claim` and `resolve`; `closed` only from `close`, so the `## Answer` side effect cannot be skipped.
- Search is `list_items(text, tags_all, tags_any)` for now; syntax and ranking belong to the search design ticket.
- Workflow tools are composed from the same internal operations as the generic ones.

**Overview** (added at the user's request: "what's done, in progress, still to do")
- `overview(effort?)` returns, for one effort: the map's Destination; counts by status; **Done** (resolved tickets with their Decisions-so-far gists); **In progress** (claimed tickets with `claimed_by`, age and a stale flag); **Ready** (the frontier); **Blocked** (with the blocking tickets' titles and states); **Still to do** (the map's Not yet specified verbatim); **Ruled out** (closed tickets and the map's Out of scope).
- It also flags drift: a resolved ticket with no matching Decisions-so-far line, or a Decisions line whose ticket is not resolved.
- With no `effort`, it returns one line per effort in the workspace (counts and the Destination's first sentence).
- It is a read from the model: no writes, no `hash`. The result is markdown text for the agent plus the same data as structured content (`format: markdown | json`, default both).

**Frontier**
- Ready means `open` and every `blocked_by` entry is `resolved` or `closed`; a ruled-out blocker does not strand its dependents.
- A missing, conflicted or invalid blocker counts as not done and is reported as a reason. Cross-effort blockers resolve the same way. Order is ticket number.

**Claims**
- `claim` succeeds only on an `open` item and sets `status: claimed` and `claimed_by`. The per-file queue makes it atomic within a checkout. Re-claiming with the same claimant is idempotent; a different claimant gets `already_claimed`.
- No TTL and no auto-expiry. A claim is stale when `updated` is older than `stale_after` (default 24 h); `frontier` and `overview` list stale claims with their age. `release` returns a ticket to `open`; releasing someone else's claim needs `force`.
- Claims are per-checkout (ADR 0001): two worktrees can both claim a ticket, and the collision surfaces as an ordinary git conflict. Documented, not prevented.

**Resolution**
- `resolve` writes `## Answer`, sets `resolved` and clears `claimed_by`. With `gist` and a map, it then appends `- [title](tickets/NN-slug.md): gist` to Decisions-so-far.
- The ticket is written first and the map second. There is no cross-file atomicity; the append is idempotent on its link target, so retrying is safe. Step results are `ok`, `skipped` or `failed`.
- `close` writes `## Answer`, sets `closed`, clears `claimed_by`, and with `out_of_scope_gist` appends to the map's Out of scope section.

**Triage**
- Roles are tags. `triage` keeps exactly one state tag and one category tag by replacing, not adding.
- `wontfix` is a state tag plus `status: closed`, with the reason in `## Answer`.
- Briefs and triage notes go under a `## Comments` heading (an unknown section to the format, left alone by the daemon) via `append_to_section`; the tracker doc tells agents to keep the triage disclaimer as the first line. `.out-of-scope/` stays with the skill; the daemon never touches it.

**implement-spec and worktrees**
- Implementers only `toggle_ac` on their own ticket in their own worktree, so each branch touches one ticket file and merges cleanly. They never claim, resolve or touch the map.
- The orchestrator calls `resolve` on the integration worktree after each merge (or once at the end). With no written answer, it passes the merge commit as the answer.
- implement-spec does not use claims: the orchestrator owns concurrency. The daemon never runs git or commits; agents commit `.tasklog/` changes with the code and check git status themselves.

**Typical call sequences**
- wayfinder: `overview`, `frontier`, `claim`, `get_item`, then work, then `resolve` (with `gist`), then `create_item` and `set_fields` for new tickets, `replace_section` on the map's Not yet specified, and `close` plus `out_of_scope_gist` for ruled-out tickets.
- implement-spec: `list_items(effort, kind=ticket)` and `get_item` to read the graph, then per-worktree `toggle_ac`, then `resolve` on the integration worktree.
- triage: `list_items(tags_any=needs-triage)`, `get_item`, `append_to_section(## Comments)`, `triage`, and `close` for wontfix.

**Errors** (fixed machine-readable codes with a `retryable` flag)
`indexing` (retry), `stale_hash` (retry after re-read), `not_found`, `conflicted` (lists both paths), `invalid_item`, `already_claimed` (carries `claimed_by`), `not_claimed`, `bad_transition`, `partial` (retry; carries per-step results). Wording and logging are for the errors and observability fog.

**Amendment to the daemon architecture (ticket 07): shared parsed-item cache**
- The model has two layers. The **parsed-item store** is global to the daemon, keyed by the content hash of the file bytes, holding immutable parse results (frontmatter, section offsets, ACs, and later search tokens), reference-counted by the workspace indexes that point at it and evicted at zero. A **workspace index** is per workspace: `path → {item id, hash}` plus effort and ID lookups, the only layer that knows paths.
- Scan and watch still read and hash every file; a hash already in the store skips the parse. Writes hash the new bytes, parse once and register the result (the same hash used for self-write suppression).
- In memory only, so the model stays derived and rebuilt from disk. No mtime-and-size shortcut that avoids the read. Duplicate-ID conflict detection stays within one workspace.
