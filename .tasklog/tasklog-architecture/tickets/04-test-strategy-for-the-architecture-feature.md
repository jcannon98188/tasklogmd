---
kind: ticket
title: Test strategy for the Architecture feature
status: open
type: grilling
blocked_by: [3]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Decide how the Architecture feature is tested: fixture repos (which shapes, drawing on the tasklogmd, rpgengine and Gable examples from ticket 01), golden scans for the detection heuristics, how the match and merge edge cases from ticket 02 (rename, split, merge, hand-deletion, stale hash) are covered, how drift findings and the `architecture` tree are asserted, and how the tool and CLI result formats from ticket 03 are pinned. Name the test layers (unit, daemon integration, CLI) and what each owns.
