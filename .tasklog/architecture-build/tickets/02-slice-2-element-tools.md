---
kind: ticket
title: "Slice 2: Element tools"
status: resolved
blocked_by: [1]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20T21:40:25Z
---

## Question

Implement `create_element`, `architecture` (tree, direct open/claimed counts, drift, `root` and `depth` scoping, warnings) and read-only `owners` (shared path normalisation, longest-root match) per tasklog-architecture/spec. Drift may use the planner stub until slice 5 lands; keep result shapes exactly as specified. Tests per Testing Decisions (tree, drift, scoping, the twelve `owners` rows).

## Answer

Implemented on `impl/02-element-tools`, merged into `architecture-0.2.0` (32d4933). `create_element`, `architecture` (tree, scoping, drift, warnings) and read-only `owners` in `src/daemon/architecture-tools.ts`; pure reads in `src/model/`. Drift is a stub, `computeDrift(elements, files)` in `src/model/drift.ts`, emitting only `missing-path` and `unowned-code`; slice 5 replaces its body with a read-only detect-plus-plan run (architecture-build/05). Choices the specs left open: warnings are `{id, field, slug, detail}`; `unowned-code` is grouped by shallowest unowned directory; a component with a missing or non-container parent is left out of the tree and warned; `create_element` refuses a title whose slug exists with `bad_request`; only tickets carry the `dangling` flag. Not covered: a drive-letter workspace root through the tool API.
