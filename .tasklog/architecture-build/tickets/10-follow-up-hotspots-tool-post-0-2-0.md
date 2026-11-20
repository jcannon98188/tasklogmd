---
kind: ticket
title: "Follow-up: hotspots tool (post-0.2.0)"
status: open
blocked_by: [1]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Implement read-only `hotspots(since?, include_zero?, limit?)` per the spec: rank elements by direct linked-ticket count across all statuses with per-status breakdown, sort by total then id, omit zeros unless `include_zero`, limit 20, dangling names to `warnings`, no score or problem wording; tool description notes a count is a signal and points `codebase-design` at it. Integration tests on the shared synthetic workspace (counts, no roll-up, `since`, tie-break, zeros, limit, dangling). Not part of 0.2.0.
