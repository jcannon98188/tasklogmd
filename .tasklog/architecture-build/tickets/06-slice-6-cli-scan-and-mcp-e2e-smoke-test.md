---
kind: ticket
title: "Slice 6: CLI scan and MCP e2e smoke test"
status: resolved
blocked_by: [2, 5]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20T21:48:41Z
---

## Question

Add `tasklog scan [--dry-run] [--json]` as a thin caller of `scan_architecture`: human summary and findings by category, `--json` equal to the tool result, exit 0 when the scan completes, next-step line only when something needs curation, `Nothing written.` on dry runs. CLI test and one MCP e2e smoke test that the new tools are listed and callable through the real shim.

## Answer

Implemented on `impl/06-cli-scan`, merged into `architecture-0.2.0` (32d8047). `tasklog scan [--dry-run] [--json] [--workspace <p>]` in `src/commands.ts` and `src/scan-format.ts`; `--json` equals the tool result; exit 0 when the scan completes, 1 outside a workspace, 2 for bad arguments. Next-step line only when curation is needed. CLI integration tests and an MCP e2e smoke test (the four architecture tools listed and callable) added; 552 tests green.
