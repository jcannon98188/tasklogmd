---
kind: ticket
title: Scoped architecture view
status: resolved
type: grilling
created: 2026-11-20
updated: 2026-11-20T21:08:05Z
---

## Question

On a large workspace the full `architecture` tree costs tokens every time an agent orients. Decide whether `architecture` gains an optional `root: <slug>` argument returning just that element's subtree, and its shape: what happens for a component slug versus a container slug; whether ancestors are included for context; how drift `findings` and `warnings` are filtered to the subtree; what a missing slug returns (`not_found`); whether a depth limit is also wanted. Name the slice it joins (probably slice 2, beside ticket 03's `architecture` result) and the test cases to add to ticket 04's integration layer. Respect tickets 03 and 07: counts stay direct, no bodies, no `code` arrays.

## Slice and tests

Joins slice 2, beside the `architecture` result. Integration-layer cases to add to the test strategy: container root returns its children; component root returns the parent stub with one child; `depth: 0` omits children; missing slug returns `not_found`; Item ID form returns `bad_request`; `findings` filtered by id and by path; `unowned-code` dropped when scoped; `warnings` filtered; counts stay direct on a scoped call; CRLF and Windows path case for the path filter.

## Answer

`architecture({root?: <slug>, depth?, drift?})` returns a scoped tree in the same shape as the full result (`containers: [...]`, `findings`, `warnings`), so callers parse one format.

### Selector
- `root` is a bare slug, like `parent`, `uses[].to` and a ticket's `components`. An Item ID form (`architecture/<slug>`) or an empty or wrong-typed value is `bad_request`. A slug naming no element is `not_found`. No new error codes.

### Shape
- **Container root**: that container with its children, as the full tree shows it.
- **Component root**: the parent container as a stub (`id`, `title`, `review`, `uses`, `tickets`) whose `children` hold only the requested component. No siblings.
- **`depth`**: optional integer. `0` returns the selected containers with no `children`; `1` (the default, full depth) includes children. Values above 1 are clamped; negative or non-integer is `bad_request`. It applies with or without `root`; for a component root it has no effect.
- Counts stay direct only (a container's `tickets` is not summed over its children, the stub included), `uses` stays on the declaring element only, no bodies, no `code` arrays. Scoping removes elements and filters diagnostics; it never changes what an element carries.

### Filtering (with `root`)
- **`findings`** are kept when the finding's `id` is the root or one of its children, or its `path` falls under a `code` root owned by the subtree (longest-root match, using the shared path normalisation from the Owner lookup decision). `unowned-code` findings are dropped from a scoped view; they stay on the unscoped call and in `tasklog scan`.
- **`warnings`** are kept when the dangling reference sits on an element inside the subtree (its `parent` or `uses[].to`), or when it is a ticket `components` entry naming a slug inside the subtree. A ticket warning naming a missing slug belongs to no subtree and appears only on the unscoped call.

### Cost
- Drift still runs the full scan plan read-only and then filters, so a scoped call saves tokens, not CPU. No scoped-plan optimisation in 0.2.0; revisit if real-repo use shows the scan is slow.
