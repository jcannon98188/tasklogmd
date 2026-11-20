---
kind: ticket
title: "Hotspots: ranking elements by ticket history"
status: resolved
type: grilling
created: 2026-11-20
updated: 2026-11-20T21:09:59Z
---

## Question

Elements touched by many tickets, resolved ones included, are candidates for the `codebase-design` skill's search for deepening opportunities. `architecture` counts only direct open and claimed tickets (ticket 03), and `list_items` with the `components` filter lists one element's tickets. Decide whether to add a hotspot view: its home (an option on `architecture`, a field, or a separate tool); what is counted (all statuses, direct only, optional date window); the result shape and ordering, including ties and elements with zero tickets; cost on a large workspace; and what it must not claim (a count is a signal, not a quality judgement). Name the slice it joins or whether it is a post-0.2.0 follow-up, and the test cases to add to ticket 04's integration layer.

## Answer

Settled by grilling with the user (all six recommendations accepted in one round). Adds the glossary term **Hotspot**.

**Scope**: not part of 0.2.0. It is a post-0.2.0 follow-up slice that depends only on slice 1 (element model and `components` index) and is not on the critical path. No existing slice grows. The design is fixed now so it is ready to build.

**Home**: a separate read-only tool, `hotspots`, in the style of `owners`. `architecture` stays the compact "what exists" tree with direct open/claimed counts and gains no mode. No new error codes.

**What is counted**: tickets that link the element directly through `components`, all statuses (open, claimed, resolved, closed), no roll-up to the parent container (matches ticket 03). Optional `since` date filters on the ticket's `updated` field, since tickets have no completion timestamp. The count is shown per status plus a `total`.

**Result shape**:
```
{ since?, elements: [{id, title, kind, parent?, tickets: {open, claimed, resolved, closed, total}}], warnings }
```
- Sorted by `total` descending, then `id` ascending (stable, testable ties).
- Elements with zero tickets are omitted by default; `include_zero: true` lists them last.
- `limit` defaults to 20.
- Dangling `components` names go to `warnings` and are never ranked.

**Cost**: one pass over the already-indexed tickets grouped by `components` in memory. O(tickets), no file reads, no drift scan.

**What it must not claim**: a count is a signal of attention, not a quality judgement; ticket volume can mean a healthy active area as easily as a troubled one. No score, rank label or "problem" wording in the output. The tool description says so in one sentence and points the `codebase-design` skill at it for deepening candidates. Glossary term **Hotspot** added.

**Tests** (ticket 04's integration layer, same synthetic workspace fixture, no new fixture): counts per status; direct-only with no roll-up; `since` window; tie-break order; zero omission and `include_zero`; `limit`; a dangling name lands in `warnings` and is not ranked.
