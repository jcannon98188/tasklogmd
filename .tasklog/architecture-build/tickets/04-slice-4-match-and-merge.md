---
kind: ticket
title: "Slice 4: Match and merge"
status: resolved
blocked_by: [3]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20T21:34:59Z
---

## Question

Implement the pure `plan` function (existing elements plus candidates in, plan out) per the spec's Match and merge section: owned-file matching, 50% rule on both sides, one-to-one, ties, rename/split/merge handling, findings, ignore-file handling, curated fields untouched, idempotence. Table-driven unit tests with expected plans, as listed in Testing Decisions.

## Answer

Implemented on `impl/04-match-merge`, merged into `architecture-0.2.0` (364656d). Pure `plan(PlanInput): Plan` in `src/architecture/plan.ts` with 31 table-driven unit cases. Slice 5 fills `skipped` and handles slug collisions at write time.

Caveat for review and the real-repo check (architecture-build/08): an existing container counts files owned by components that do not exist yet, while its candidate excludes files owned by new component candidates. When a new component directory makes up more than half of a container's files, the 50% rule can fail and the container is re-proposed. Implemented as the spec states; revisit only if real use shows it.
