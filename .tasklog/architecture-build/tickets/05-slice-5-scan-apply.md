---
kind: ticket
title: "Slice 5: Scan apply"
status: resolved
blocked_by: [1, 3, 4]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20T21:44:59Z
---

## Question

Implement `scan_architecture` in the daemon architecture-tools module: git-aware file listing with the built-in ignore list, user ignore file, calling detect and plan, hashed per-element writes through the normal write path, `dry_run`, skipped-on-stale-hash, result shape per the spec. Wire `architecture` drift to the real plan. Integration, golden and concurrency tests per Testing Decisions (pause hook, racing scans, `create_element` interleave, seeded randomised run, Windows path/CRLF cases).

## Answer

Implemented on `impl/05-scan-apply`, merged into `architecture-0.2.0` (a91abde). `scan_architecture(dry_run?)` in `src/daemon/architecture-scan.ts` and `architecture-tools.ts`; `architecture` drift now runs the real plan. Hashed per-element writes, stale hash skipped as "changed during scan", writing scans serialised per workspace, new elements created `proposed` through `WriteService.createElementFile`. 23 integration tests (six fixture goldens in `scan-result.golden.json`, concurrency, CRLF, git and non-git listing); full suite 545 tests green. Deviations: scan goldens are `scan-result.golden.json` (slice 3 owns `scan.golden.json`); finding ids use the bare slug while `created`/`updated` use `architecture/<slug>`; an uninitialised workspace fails `no_workspace` rather than `bad_request`; drift reports `unowned-code` per top-level directory. Open spec problem: under the 50% rule, deleting two or more components of a container makes the container look like a new element, and if the old container owns `.` every later scan proposes another (`app-10`). Raised as architecture-build/11.
