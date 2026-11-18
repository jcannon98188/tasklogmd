# 09: Workflow tools

**What to build:** The wayfinder, implement-spec and triage skills can run on TaskLog: frontier and overview queries, claims, resolve and close with their map side effects, and triage. Spec reference: `.scratch/tasklogmd/spec.md`, section 5 (rules, frontier, overview, claims, resolution, triage, implement-spec). Tools: `frontier`, `overview`, `claim`, `release`, `resolve`, `close`, `add_decision`, `add_out_of_scope`, `triage`.

**Blocked by:** 08 Creation and numbering

**Status:** ready-for-agent

- [ ] Given blockers resolved or closed, when `frontier` runs, then the ticket is ready; a missing, conflicted or invalid blocker keeps it blocked with a reason; cross-effort blockers resolve the same way.
- [ ] Given an open ticket, when two claimants claim it, then one succeeds and the other gets `already_claimed` carrying `claimed_by`; the same claimant twice is idempotent.
- [ ] Given a claim older than `stale_after` (default 24 h), when `frontier` or `overview` runs, then it is listed stale with its age; `release` returns it to `open`, and releasing another's claim needs `force`.
- [ ] Given `resolve` with `gist`, when it runs, then `## Answer` is written, status is `resolved`, `claimed_by` is cleared and the Decisions-so-far line is appended once even if retried.
- [ ] Given the map append fails, when `resolve` runs, then it returns `partial` with per-step results and a retry completes it.
- [ ] Given `close` with `out_of_scope_gist`, when it runs, then the ticket is `closed`, `## Answer` holds the reason and the line is appended to Out of scope.
- [ ] Given `overview` for an effort with drift, when it runs, then it flags a resolved ticket with no Decisions line and a Decisions line whose ticket is not resolved; with no `effort` it returns one line per effort.
- [ ] Given `triage` called twice with different states, when it runs, then exactly one state tag and one category tag remain; `wontfix` also closes the ticket.
- [ ] `set_fields` still cannot set `claimed`, `resolved` or `closed` directly.
