---
kind: ticket
title: "Slice 7a: Docs and onboarding"
status: resolved
blocked_by: [5]
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20T21:49:55Z
---

## Question

Per the spec's Agent onboarding section: README Architecture and `tasklog scan` section; the `## Architecture` section (about 23 lines, linking and review paragraphs, body-section conventions, GLOSSARY-MAP line) in the tracker template; self-contained descriptions on the four new tools; the setup-skill patch refresh step and manual-checklist line; the `tasklog doctor` one-line warning; ADR "scan matches by owned paths only, never by name, and never overwrites curated content"; GLOSSARY.md check. Tests: template-content test with line cap, doctor warning test, Interface/Seams preservation tests.

## Answer

Implemented on `impl/07a-docs`, merged into `architecture-0.2.0` (1c6c48e). README Architecture and `tasklog scan` section; 13-line `## Architecture` section in the tracker template and this repo's `docs/agents/issue-tracker.md`; setup-skill refresh step and checklist item; ADR 0002 (scan matches by owned paths only); tool descriptions for the four tools; `architecture-guidance` doctor warning (informational, exit code unchanged); tests in `test/integration/architecture-onboarding.test.ts`; 559 tests green. The implementer added Owner and Hotspot to GLOSSARY.md; the main checkout already had uncommitted, differently worded Owner and Hotspot entries, so the merged text is the branch's and the user's wording is back as an uncommitted edit on top.
