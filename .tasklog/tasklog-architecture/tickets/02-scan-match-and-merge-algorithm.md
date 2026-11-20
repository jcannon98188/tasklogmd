---
kind: ticket
title: Scan match and merge algorithm
status: resolved
type: grilling
blocked_by: [1]
created: 2026-11-20
updated: 2026-11-20T20:20:38Z
---

## Question

Given existing elements with owned `code` paths and a fresh scan, how exactly are they matched (path overlap rules), and what happens on renames, splits, merges, and ignored paths? Only `code` is rewritten on a rescan and matching is by owned code, never by name. Define the algorithm and its edge cases.

## Comments

From ticket 01: decide whether a hand-deleted element is re-proposed on rescan (for example the throwaway `spikes/02-launch/stub` container `tasklogspike2`). Also decide how a component's `code` path is matched when its container's `code` carve-outs change.

## Answer

The scan matches candidates to existing elements by owned files, never by name, and rewrites only `code`.

### Ownership
- `code` holds positive roots only, no negation syntax. A file belongs to the element with the longest matching root, so container carve-outs are implicit and components never depend on their container's `code`.
- Ticket 01's ignore rules apply only to proposing candidates. An existing element that owns an ignored path (tests, fixtures, tooling) is left alone: no rewrite, no drift.
- `.tasklog/architecture/ignore` is a user-owned file, one path or glob per line. Matching paths are never proposed and are reported as "ignored: user". The scan never writes it.

### Matching
1. Expand each candidate and each existing element to its owned files (longest-prefix rule, ticket 01 file list).
2. Only the same kind can match (container to container, component to component).
3. Take pairs from largest shared-file count down, one-to-one.
4. A pair matches only if shared files are at least 50% of the candidate's files and at least 50% of the element's files.
5. A tie between equally good pairs matches neither; both candidates are proposed and the report names the ambiguity.
6. Unmatched candidates become new `proposed` elements (`parent` and `uses` seeding per ticket 01; a new component's `parent` is the container owning its directory).

### Edge cases
- Rename or move: zero shared files, so the old element is reported as drift (missing path) and the new directory is proposed. No rename guessing. The report adds a "possible rename of X" hint when a missing-path element and a new candidate of the same kind share a basename; the hint changes nothing.
- Split: the larger half keeps the element if it passes the 50% rule; the other half is proposed.
- Merge: the candidate matches the element it overlaps more (if it passes 50% of both sides); the other element is left as drift.
- Hand-deleted element (for example `spikes/02-launch/stub`, `tasklogspike2`): re-proposed on every scan, since the scan keeps no memory. The ignore file is the only way to stop it.
- Component whose container's carve-outs change: no effect, by the ownership rule.
- Matched component now under a different container: `parent` is not rewritten; reported as drift ("parent mismatch").

### What a matched element gets
- Only the roots that overlap the matched candidate are replaced. Hand-added roots stay. If nothing changed, no write is made, so an unchanged repo produces zero diffs.
- The scan never deletes an element and never changes `review` in either direction. Proposed and accepted elements are treated the same. An element with no surviving roots and no match is kept and reported as drift.

### Missing paths
- A root is missing when no file lies under it in the scan's file list (git tracked plus untracked-not-ignored, or the built-in ignore list outside git). Gitignored and built-in-ignored paths (for example `dist/`) count as missing.
- A root with files but no code files is not missing; it is reported as "owns no code".

### Write safety
- Read all elements with their hashes once, compute the whole plan in memory, then write per element through the normal write path with that element's hash.
- An element whose hash went stale is skipped and listed as "skipped: changed during scan". No retry, no overwrite.
- The scan is not transactional: a partial result is valid and a rerun is idempotent. New-element slug collisions use ticket 01's slug rule against what exists at write time.

### Report categories this implies (exact format is ticket 03)
missing owned path, owns no code, unowned code, parent mismatch, ambiguous match, possible rename, ignored (test, fixture/template, tooling, user, not a workspace member), skipped (changed during scan).
