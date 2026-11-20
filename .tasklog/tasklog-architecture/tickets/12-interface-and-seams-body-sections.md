---
kind: ticket
title: Interface and Seams body sections
status: resolved
type: grilling
created: 2026-11-20
updated: 2026-11-20T21:17:06Z
---

## Question

Ticket 03 fixes element bodies as `## Description` and `## Responsibilities` and preserves other sections. The `codebase-design` skill's vocabulary (interface, seams, depth) suggests conventional `## Interface` and `## Seams` sections. Decide whether these are a pure documented convention (no code, no empty sections written by scan), or whether `create_element` and the scan should write them empty alongside the existing two; what each section is meant to hold and how long; whether the `architecture` tool ever shows them (default: no, bodies stay out per ticket 03); and where the convention is documented (tracker template per ticket 06, README). Name any glossary term and test case needed.

## Answer

`## Interface` and `## Seams` are a documented convention only, like any other preserved body section.

- **Writing**: `create_element` and the scan write only `## Description` and `## Responsibilities`; no empty `## Interface` or `## Seams` is ever generated. Agents and humans add them when curating, naturally when flipping `review` to `accepted`. The scan only rewrites `code`, so it cannot clobber them.
- **Meaning**: `## Interface` is what a caller must know to use the element (entry points, contracts, invariants, ordering rules), not how it works inside. `## Seams` is where behaviour can be swapped without editing in place (injected dependencies, adapters, config switches, test doubles), naming what varies on each side. Together with Description (what it is) and Responsibilities (what it owns) this gives four conventional sections. Vocabulary comes from the `codebase-design` skill.
- **Size**: short bullets or prose, soft cap about 10 lines each, guidance only; nothing validated, truncated or warned about. Containers describe their external surface (CLI, HTTP, tool API); components describe module-level entry points.
- **Tools**: no change. The `architecture` tool still returns no bodies (ticket 03); readers use `get_item` with `sections: ["Interface", "Seams"]`. No new tool or parameter.
- **Documentation**: a short body-sections list (one line per heading) in the tracker template's `## Architecture` section from ticket 06, delivered by the existing setup patch, and the same list in the README's Architecture section.
- **Glossary**: no new terms; they are section names and `codebase-design` owns the vocabulary.
- **Tests**: one case that a rescan and a `replace_section` call preserve hand-written `## Interface` and `## Seams`; one case that `create_element` output contains only `## Description` and `## Responsibilities`.
- **Downstream**: ticket 09's review guidance can check a diff, run through `owners`, against `## Responsibilities` and `## Interface`.
