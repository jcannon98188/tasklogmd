---
kind: ticket
title: Agent onboarding for the Architecture
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

Groma's `groma init` writes a managed block into AGENTS.md/CLAUDE.md and ships agent guides so an agent knows the architecture exists and how to curate it. Decide the TaskLog equivalent: what an agent is told and where. Cover: the Architecture section added to the `docs/agents/issue-tracker.md` template and the setup-skill patch (so existing repos pick it up); whether anything is written to CLAUDE.md/AGENTS.md beyond that (a managed block, or nothing); the MCP tool descriptions for `architecture`, `scan_architecture`, `create_element` as the primary guidance; a short curate-after-scan workflow for agents (inspect proposed elements, write Description and Responsibilities, set `review: accepted`, link tickets via `components`, never edit element files by hand); and what `tasklog scan` prints to point at the next step. Keep it cheap: no new tools unless a gap is found. Name the files this touches so the build order (slice 7a) can absorb it.
