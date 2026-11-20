---
kind: ticket
title: "Slice 5: Scan apply"
status: open
blocked_by: [1, 3, 4]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Implement `scan_architecture` in the daemon architecture-tools module: git-aware file listing with the built-in ignore list, user ignore file, calling detect and plan, hashed per-element writes through the normal write path, `dry_run`, skipped-on-stale-hash, result shape per the spec. Wire `architecture` drift to the real plan. Integration, golden and concurrency tests per Testing Decisions (pause hook, racing scans, `create_element` interleave, seeded randomised run, Windows path/CRLF cases).
