---
kind: ticket
title: "Slice 1: Element model"
status: open
tags: [ready-for-agent, enhancement]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Implement the Element model per tasklog-architecture/spec (Model section): element files under reserved `.tasklog/architecture/`, parsing and schema, `components` ticket field with `dangling` flag and warnings, index/watcher/hash integration, `create_effort` refusing `architecture`, `set_fields` rules for elements, `list_items` `components` filter and kind hiding, rejection of triage/claim/resolve/close on elements, and `workspace_status` architecture counts. Tests per the spec's Testing Decisions (integration through the tool API).
