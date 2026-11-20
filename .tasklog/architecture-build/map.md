---
kind: map
title: Build the Architecture feature (0.2.0)
status: open
created: 2026-11-20
updated: 2026-11-20
---

## Destination

TaskLog 0.2.0 released with the Architecture feature as specified in tasklog-architecture/spec. Each ticket is one implementation slice; the spec's Implementation Decisions and Testing Decisions are the source of truth.

## Notes

## Decisions so far

- [Slice 3: Detection](tickets/03-slice-3-detection.md): Pure detection package, fixtures and goldens merged; one deviation on root-level unowned code to verify in the real-repo check.
- [Slice 1: Element model](tickets/01-slice-1-element-model.md): Element model, `components` field, index, reserved name and `workspace_status` counts merged.
- [Slice 4: Match and merge](tickets/04-slice-4-match-and-merge.md): Pure match-and-merge planner merged; one known 50%-rule edge case when many new components appear at once.
- [Slice 2: Element tools](tickets/02-slice-2-element-tools.md): `create_element`, `architecture` and `owners` merged; drift is a stub until slice 5 swaps in the planner.
- [Slice 5: Scan apply](tickets/05-slice-5-scan-apply.md): `scan_architecture` and real drift merged; found a 50%-rule re-proposal loop, raised as ticket 11.

## Not yet specified

## Out of scope
