---
kind: ticket
title: "Slice 2: Element tools"
status: open
blocked_by: [1]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Implement `create_element`, `architecture` (tree, direct open/claimed counts, drift, `root` and `depth` scoping, warnings) and read-only `owners` (shared path normalisation, longest-root match) per tasklog-architecture/spec. Drift may use the planner stub until slice 5 lands; keep result shapes exactly as specified. Tests per Testing Decisions (tree, drift, scoping, the twelve `owners` rows).
