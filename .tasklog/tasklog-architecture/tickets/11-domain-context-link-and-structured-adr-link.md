---
kind: ticket
title: Domain context link and structured ADR link
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

Repos with a `GLOSSARY-MAP.md` have several domain contexts, each with its own `GLOSSARY.md` and `docs/adr/`. The opening grilling deferred a structured ADR link; this ticket decides it together with a context link. Decide whether an element gains an optional `context` field (a path to its context folder) and an `adrs` list, or whether both stay plain-file conventions; how they are validated (existence, dangling warnings per ticket 03); how they interact with scan, which rewrites only `code` (tickets 02 and 03), and with the single-context case, where nothing is needed; and whether they appear in the `architecture` and `owners` results (default: no, tickets 03 and 07). If any field is added, name the slice, glossary terms and test cases for ticket 04's layers.
