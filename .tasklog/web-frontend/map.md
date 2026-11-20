---
kind: map
title: Web front end
status: open
created: 2026-11-20
updated: 2026-11-20
---

## Destination

A build spec for a read-only web front end for TaskLog (task board and architecture map, light and dark), written in enough detail to be turned into implementation tickets. The effort starts only after the architecture effort (architecture-build) has shipped 0.2.0.

## Notes

- Starts after architecture-build ships 0.2.0: every ticket is blocked on architecture-build/09 (Slice 7c: Release 0.2.0).
- Starting input, not to be re-opened: the design canvas https://claude.ai/artifact/MPjZNNUksKDW8srigCPEeB. Task board (columns, filters, ticket sheet), architecture map in the style of groma.md (hierarchy, map, detail pane), light and dark themes, Gable-UI components in a shadcn style.
- v1 is read-only. The daemon stays the only writer; claim, resolve and accept-element are a later effort. The edit buttons on the canvas are mock-ups.
- Gable is the owner's framework and Gable-UI its shadcn implementation. Do not assume what they provide; see the research ticket.
- Domain: GLOSSARY.md and docs/adr/. Terms to use as defined: Architecture, Element, Container, Component, Review, Drift, Hotspot, Frontier.
- Planning only: tickets resolve decisions; no implementation.

## Decisions so far

## Not yet specified

- How the front-end bundle is built and shipped inside the npm package, and how the daemon serves it.
- Localhost-only access, the port, and whether any authentication is needed.
- Switching between workspaces, since one daemon serves several.
- How the architecture map is laid out: automatic placement or stored positions, and what happens as elements change.
- Which of the canvas's behaviours survive with real data: filters, search, zoom, revision comparison, task pins.
- Test strategy for the UI and for the new HTTP and event-stream layer.

## Out of scope
