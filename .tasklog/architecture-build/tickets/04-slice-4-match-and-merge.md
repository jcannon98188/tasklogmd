---
kind: ticket
title: "Slice 4: Match and merge"
status: open
blocked_by: [3]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Implement the pure `plan` function (existing elements plus candidates in, plan out) per the spec's Match and merge section: owned-file matching, 50% rule on both sides, one-to-one, ties, rename/split/merge handling, findings, ignore-file handling, curated fields untouched, idempotence. Table-driven unit tests with expected plans, as listed in Testing Decisions.
