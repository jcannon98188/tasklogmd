# 09: Workflow tools

**What to build:** The wayfinder, implement-spec and triage skills can run on TaskLog: frontier and overview queries, claims, resolve and close with their map side effects, and triage. Spec reference: `.scratch/tasklogmd/spec.md`, section 5 (rules, frontier, overview, claims, resolution, triage, implement-spec). Tools: `frontier`, `overview`, `claim`, `release`, `resolve`, `close`, `add_decision`, `add_out_of_scope`, `triage`.

**Blocked by:** 08 Creation and numbering

**Status:** resolved

- [x] Given blockers resolved or closed, when `frontier` runs, then the ticket is ready; a missing, conflicted or invalid blocker keeps it blocked with a reason; cross-effort blockers resolve the same way.
- [x] Given an open ticket, when two claimants claim it, then one succeeds and the other gets `already_claimed` carrying `claimed_by`; the same claimant twice is idempotent.
- [x] Given a claim older than `stale_after` (default 24 h), when `frontier` or `overview` runs, then it is listed stale with its age; `release` returns it to `open`, and releasing another's claim needs `force`.
- [x] Given `resolve` with `gist`, when it runs, then `## Answer` is written, status is `resolved`, `claimed_by` is cleared and the Decisions-so-far line is appended once even if retried.
- [x] Given the map append fails, when `resolve` runs, then it returns `partial` with per-step results and a retry completes it.
- [x] Given `close` with `out_of_scope_gist`, when it runs, then the ticket is `closed`, `## Answer` holds the reason and the line is appended to Out of scope.
- [x] Given `overview` for an effort with drift, when it runs, then it flags a resolved ticket with no Decisions line and a Decisions line whose ticket is not resolved; with no `effort` it returns one line per effort.
- [x] Given `triage` called twice with different states, when it runs, then exactly one state tag and one category tag remain; `wontfix` also closes the ticket.
- [x] `set_fields` still cannot set `claimed`, `resolved` or `closed` directly.

## Comments

Notes for later tickets (10 search, 11 observability, 12 tracker doc, 14 CLI).

**New modules.** `src/model/workflow.ts` (pure reads: `computeFrontier`, `computeOverview`, `computeEffortLines`, `overviewMarkdown`, `parseStaleAfter`, `sectionText`, `parseLinkLines`); `src/daemon/workflow.ts` (`WorkflowService`: claim, release, resolve, close, addDecision, addOutOfScope, triage, composed from `WriteService.edit`); `src/daemon/workflow-tools.ts` (MCP tools, registered from `createMcpServer` with one added line; the service is created lazily per `WriteService` via a WeakMap, so `core.ts` is untouched).

**Shared-file edits (small).** `model/edit.ts`: new internal `Edit` variant `{op:'set_state', status?, claimed_by? (null removes), updated?, answer?, tags?}` applied atomically in one patch; no generic tool constructs it. `daemon/writes.ts`: `now` is now `readonly` public (workflow tools read it for `updated`). `daemon/mcp.ts`: import + one `registerWorkflowTools` call.

**Decisions.**
- `updated` is written by claim/release/resolve/close (and wontfix) as a UTC timestamp `2026-11-17T12:34:56Z` (new files still carry a date); staleness parses either form (date = UTC midnight). A missing/unparseable `updated` on a claim counts as stale with `age_seconds: null`. Generic edits and triage tag changes do not touch it.
- `hash` is optional on workflow tools: without it the model's hash is used and a `stale_hash` re-evaluates the preconditions against the refreshed model (up to 5 times), which is what makes two racing claims give one success and one `already_claimed`. With it, a stale hash fails `stale_hash`.
- Claims work on tickets only (`bad_request` otherwise). `claim` of own claim: no write, `changed:false`. `release`: open -> `not_claimed`; resolved/closed -> `bad_transition`; other claimant without `force` -> `already_claimed` with `claimed_by`.
- `resolve`/`close` accept open or claimed tickets. Retry semantics: a ticket already in the target state with an identical `## Answer` skips the ticket step (`skipped`) and re-runs the map step; a different answer is `bad_transition`. Result `steps: {ticket, map, notes?}`; map step is `skipped` with no gist or no map, `skipped` ("already present") when a line with the same link target exists. A map failure throws `partial` (retryable) with `details: {id, hash, steps, error}`; repeating the same call completes it.
- Map lines are `- [title](tickets/NN-slug.md): gist` (path relative to the map). `add_decision`/`add_out_of_scope` append `- <title_link>: <gist>`, idempotent on the link target; they return `{hash, changed}`. Missing map is `not_found`.
- `frontier` returns `{effort, ready[], claimed[], blocked[]}`; rows `id,title,type,tags,hash,blocked_by`, claimed adds `claimed_by, age_seconds, age, stale`, blocked adds `reasons[{blocker,state,title?,message}]` (state `open|claimed|missing|conflicted|invalid`). Invalid/conflicted tickets themselves are not listed (see `list_items`/`workspace_status`). Unknown effort is `not_found`. `stale_after`: hours as a number, or "90m"/"24h"/"2d".
- `overview` returns `{effort,title,destination,counts,done[{id,title,gist}],in_progress,ready,blocked,still_to_do,ruled_out:{closed,out_of_scope},drift[{type,id,message}],warnings,markdown}`; `format` `json` drops `markdown`, `markdown` returns only it. No `effort`: `{efforts:[{effort,title,counts,destination(first sentence)}],markdown}`. Drift types: `resolved_without_decision`, `decision_for_unresolved` (only for Decisions lines that point at a ticket of the effort).
- `triage`: states `needs-triage|needs-info|ready-for-agent|ready-for-human|wontfix`, categories `bug|enhancement` (enum-validated by the tool schema). Other tags are kept; the new state tag replaces the old one and a given category replaces the old category (omitted category leaves it). `wontfix` also closes with `note` (default "Closed as wontfix.") as Answer; other states append `note` to `## Comments` (skipped if already present). The triage disclaimer stays the skill's job.

**Tests.** `test/integration/workflow-tools.test.ts` (14 tests through the daemon over HTTP, covering every AC; the map failure uses `daemon.writes.beforeRename`).

**Limits.** The model only sees hand-added files after a scan (no watcher yet, ticket 07), so frontier on a workspace with hand-added blockers must start with those files present.
