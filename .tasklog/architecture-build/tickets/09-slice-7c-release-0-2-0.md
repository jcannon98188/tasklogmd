---
kind: ticket
title: "Slice 7c: Release 0.2.0"
status: resolved
type: task
blocked_by: [7, 8, 11]
tags: [ready-for-human]
created: 2026-11-20
updated: 2026-11-21T01:50:31Z
---

## Question

Follow the spec's 0.2.0 release checklist: tests green on Windows, bump version and package.json to 0.2.0 (protocol stays 1), `npm pack`, install the tarball and run `tasklog doctor`, daemon-upgrade check (old 0.1.x daemon replaced, new tools listed), docs and glossary current, `npm publish`, tag.

## Answer

Release checklist: (1) full suite green on Windows, 574 tests; (2) real-repo check done (architecture-build/08); (3) bumped to 0.2.0, protocol stays 1; (4) `npm pack` tarball installed in a clean directory, `tasklog --version` reports 0.2.0, `tasklog doctor` ok; (5) daemon-upgrade check found a blocker, a 0.2.0 client did not replace a running 0.1.1 daemon because protocol is unchanged, so the new tools were missing. Fixed by restarting the daemon when its version is an older release (merged 4958332); re-checked in an isolated `TASKLOG_HOME`: 0.1.1 daemon replaced, `tasklog scan --dry-run` works, doctor shows version 0.2.0; (6) README, tracker template, setup patch and ADR 0002 done (architecture-build/07); (7) GLOSSARY.md terms are in the committed branch; the user's differently worded uncommitted Owner/Hotspot edit is left in the working tree; (8) `npm publish` and tag follow in the next step.
