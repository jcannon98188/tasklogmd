---
kind: ticket
title: "Slice 3: Detection"
status: open
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Create the pure `architecture` package: `types.ts` (Element, Candidate, Plan, Finding; the single source of these types), manifest parsers (package.json, csproj, go.mod, Cargo, Nx/Angular descriptors), and `detect` (file list plus manifest contents in, candidates out) per the spec's Detection section. Add the synthetic fixtures (`single-package`, `dotnet-multi`, `npm-workspaces`, `angular-nx`, `no-git`, `unowned`) and their `scan.golden.json` with the `UPDATE_GOLDEN=1` mechanism. No daemon imports, no fs, no git.
