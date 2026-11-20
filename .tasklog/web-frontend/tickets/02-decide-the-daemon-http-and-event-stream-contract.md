---
kind: ticket
title: Decide the daemon HTTP and event-stream contract
status: open
type: grilling
blocked_by: [1, "architecture-build/09"]
created: 2026-11-20
updated: 2026-11-20
---

## Question

The read-only web UI needs data from the daemon: efforts, tickets (with status, tags, blockers, acceptance criteria, claims), overview and frontier, and the architecture (elements, review state, drift, ticket counts). Decide the shape of the HTTP API and the live-update event stream: how closely it mirrors the existing MCP tools, how it is scoped per workspace, what an event carries (a change notice or the changed data), and how a client recovers after a dropped connection. Consider what Gable's data layer, as recorded in the research ticket, makes easy.
