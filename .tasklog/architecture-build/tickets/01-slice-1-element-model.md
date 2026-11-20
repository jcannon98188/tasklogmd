---
kind: ticket
title: "Slice 1: Element model"
status: resolved
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20T21:33:45Z
---

## Question

Implement the Element model per tasklog-architecture/spec (Model section): element files under reserved `.tasklog/architecture/`, parsing and schema, `components` ticket field with `dangling` flag and warnings, index/watcher/hash integration, `create_effort` refusing `architecture`, `set_fields` rules for elements, `list_items` `components` filter and kind hiding, rejection of triage/claim/resolve/close on elements, and `workspace_status` architecture counts. Tests per the spec's Testing Decisions (integration through the tool API).

## Answer

Implemented on `impl/01-element-model`, merged into `architecture-0.2.0` (9f7909b). Elements parsed, indexed and watched; `components` on tickets with `dangling` flag; `workspace_status.architecture` counts; `list_items` `components` filter and element hiding; `set_fields` for elements and ticket `components`; workflow tools reject elements; `architecture` reserved as an effort name. Helpers for later slices: `normalizeRepoPath` in `src/model/repo-path.ts`, `WorkspaceIndex.danglingComponents()` and `architectureCounts()`. Open choices taken: missing `review` reads as `proposed`; the `components` filter matches any given slug; non-kebab `.md` files under `architecture/` are ignored.
