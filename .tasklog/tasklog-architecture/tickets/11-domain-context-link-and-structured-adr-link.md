---
kind: ticket
title: Domain context link and structured ADR link
status: resolved
type: grilling
created: 2026-11-20
updated: 2026-11-20T21:11:34Z
---

## Question

Repos with a `GLOSSARY-MAP.md` have several domain contexts, each with its own `GLOSSARY.md` and `docs/adr/`. The opening grilling deferred a structured ADR link; this ticket decides it together with a context link. Decide whether an element gains an optional `context` field (a path to its context folder) and an `adrs` list, or whether both stay plain-file conventions; how they are validated (existence, dangling warnings per ticket 03); how they interact with scan, which rewrites only `code` (tickets 02 and 03), and with the single-context case, where nothing is needed; and whether they appear in the `architecture` and `owners` results (default: no, tickets 03 and 07). If any field is added, name the slice, glossary terms and test cases for ticket 04's layers.

## Deferred

A reverse lookup ("which elements does this ADR affect?") would need a structured link. It goes to Not yet specified and is revisited only if real use asks for it.

## Answer

Both stay plain-file conventions. No new front-matter fields.

### Context link
No `context` field. A multi-context repo's `GLOSSARY-MAP.md` already says where each context lives, so an element's context is derived: its owned `code` paths fall under one context's folder. A single-context repo needs nothing. The `## Architecture` section of the tracker template (ticket 06) gains one line telling agents to consult `GLOSSARY-MAP.md` for an element's paths when it exists.

### ADR link
No `adrs` field. An element may carry an optional `## Decisions` body section of ordinary markdown links to ADRs. It is a preserved non-standard section, so the scan never touches it (ticket 02/03 rewrite only `code`).

### Validation, scan and results
- Nothing is validated: no existence check, no dangling warning, no new flag (ticket 03's `dangling` stays for `components`, `parent` and `uses` only).
- The scan neither reads nor writes the section.
- `architecture`, `owners` and `list_items` results are unchanged: they carry no context or ADR data.

### Build impact
No new slice, no new tool, no new glossary term, no new test case for ticket 04's layers. The only change is the one guidance line above, which joins the onboarding slice already in ticket 05.
