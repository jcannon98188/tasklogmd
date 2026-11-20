---
kind: ticket
title: Scoped architecture view
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

On a large workspace the full `architecture` tree costs tokens every time an agent orients. Decide whether `architecture` gains an optional `root: <slug>` argument returning just that element's subtree, and its shape: what happens for a component slug versus a container slug; whether ancestors are included for context; how drift `findings` and `warnings` are filtered to the subtree; what a missing slug returns (`not_found`); whether a depth limit is also wanted. Name the slice it joins (probably slice 2, beside ticket 03's `architecture` result) and the test cases to add to ticket 04's integration layer. Respect tickets 03 and 07: counts stay direct, no bodies, no `code` arrays.
