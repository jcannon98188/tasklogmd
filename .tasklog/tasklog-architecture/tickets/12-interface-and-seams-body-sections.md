---
kind: ticket
title: Interface and Seams body sections
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

Ticket 03 fixes element bodies as `## Description` and `## Responsibilities` and preserves other sections. The `codebase-design` skill's vocabulary (interface, seams, depth) suggests conventional `## Interface` and `## Seams` sections. Decide whether these are a pure documented convention (no code, no empty sections written by scan), or whether `create_element` and the scan should write them empty alongside the existing two; what each section is meant to hold and how long; whether the `architecture` tool ever shows them (default: no, bodies stay out per ticket 03); and where the convention is documented (tracker template per ticket 06, README). Name any glossary term and test case needed.
