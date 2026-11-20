---
kind: ticket
title: Structural detection heuristics
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

How does the v1 scan decide what is a container and what is a component from manifests (package.json, .csproj, go.mod, ...) and top-level directories? Cover monorepos, nested packages, non-code directories, and what is ignored. Run it against this repo and one other (rpgengine) as worked examples.
