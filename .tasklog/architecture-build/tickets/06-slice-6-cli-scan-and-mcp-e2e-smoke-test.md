---
kind: ticket
title: "Slice 6: CLI scan and MCP e2e smoke test"
status: open
blocked_by: [2, 5]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Add `tasklog scan [--dry-run] [--json]` as a thin caller of `scan_architecture`: human summary and findings by category, `--json` equal to the tool result, exit 0 when the scan completes, next-step line only when something needs curation, `Nothing written.` on dry runs. CLI test and one MCP e2e smoke test that the new tools are listed and callable through the real shim.
