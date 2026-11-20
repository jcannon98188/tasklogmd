---
kind: ticket
title: "Slice 3: Detection"
status: resolved
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20T21:31:37Z
---

## Question

Create the pure `architecture` package: `types.ts` (Element, Candidate, Plan, Finding; the single source of these types), manifest parsers (package.json, csproj, go.mod, Cargo, Nx/Angular descriptors), and `detect` (file list plus manifest contents in, candidates out) per the spec's Detection section. Add the synthetic fixtures (`single-package`, `dotnet-multi`, `npm-workspaces`, `angular-nx`, `no-git`, `unowned`) and their `scan.golden.json` with the `UPDATE_GOLDEN=1` mechanism. No daemon imports, no fs, no git.

## Answer

Implemented on `impl/03-detection`, merged into `architecture-0.2.0` (aa449cf). Pure `src/architecture/` package (types, paths, manifests, detect), six fixtures with golden scans. Deviation from tasklog-architecture/01: files at the workspace root are owned by the root container by prefix, so tasklogmd's `scripts/` shows as ignored/tooling and `spikes/` is not listed as unowned; check this in the real-repo check (architecture-build/08).
