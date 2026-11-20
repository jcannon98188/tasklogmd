---
kind: ticket
title: Agent onboarding for the Architecture
status: resolved
type: grilling
created: 2026-11-20
updated: 2026-11-20T20:49:43Z
---

## Question

Groma's `groma init` writes a managed block into AGENTS.md/CLAUDE.md and ships agent guides so an agent knows the architecture exists and how to curate it. Decide the TaskLog equivalent: what an agent is told and where. Cover: the Architecture section added to the `docs/agents/issue-tracker.md` template and the setup-skill patch (so existing repos pick it up); whether anything is written to CLAUDE.md/AGENTS.md beyond that (a managed block, or nothing); the MCP tool descriptions for `architecture`, `scan_architecture`, `create_element` as the primary guidance; a short curate-after-scan workflow for agents (inspect proposed elements, write Description and Responsibilities, set `review: accepted`, link tickets via `components`, never edit element files by hand); and what `tasklog scan` prints to point at the next step. Keep it cheap: no new tools unless a gap is found. Name the files this touches so the build order (slice 7a) can absorb it.

## Files touched

For build slice 7a to absorb: `docs/setup-skill/issue-tracker-tasklog.md` (new section), `docs/setup-skill/README.md` and `docs/setup-skill/manual-checklist.md` (refresh step), `docs/agents/issue-tracker.md` (this repo's copy), tool descriptions in `src/daemon/architecture-tools.ts`, the `tasklog scan` printer in the CLI, the `tasklog doctor` check, and a description-terms test beside `test/unit/tracker-template.test.ts`.

## Answer

1. **Where**: a new `## Architecture` section (about 15 lines) in the tracker template `docs/setup-skill/issue-tracker-tasklog.md`, which the setup skill copies to `docs/agents/issue-tracker.md`. It covers what elements are, the three tools, the curate-after-scan workflow, and "never edit element files by hand". No separate architecture doc.
2. **CLAUDE.md/AGENTS.md**: nothing new, no managed block. The existing `### Issue tracker` pointer routes agents to the tracker doc. Revisit only if real use shows agents missing it.
3. **Existing repos**: the setup-skill patch (`docs/setup-skill/README.md`, plus a line in `manual-checklist.md`) gains a refresh step: re-copy the template if the repo's tracker doc is unmodified, otherwise print the new section for the human to merge. `tasklog doctor` warns, as one warning line, when elements exist but the tracker doc has no Architecture section.
4. **Tool descriptions are the primary guidance**: `architecture`, `scan_architecture` and `create_element` each get a self-contained 3 to 5 sentence description (what it returns, when to call it, what to do next). The curate-after-scan workflow is stated once in `scan_architecture`'s description and referenced from the other two. A unit test checks the key terms appear, in the style of `test/unit/tracker-template.test.ts`.
5. **Curate-after-scan workflow**: (1) `architecture`, list elements with `review: proposed`; (2) write Description and Responsibilities with `replace_section`; (3) `set_fields` `review: accepted`; (4) link tickets via `components` with `set_fields`; (5) never edit element files by hand and never delete elements. Unowned directories in `findings` are raised with the user, not silently ignored.
6. **`tasklog scan` output**: human-readable mode ends with a next-step line only when there is something to do, e.g. `N proposed elements need curation. Ask your agent to curate the Architecture, or see docs/agents/issue-tracker.md#architecture.`; on `--dry-run`, `Nothing written. Re-run without --dry-run to apply.` `--json` stays machine-pure.
7. **No new tools**: `architecture` already returns `review` per element, so the curate loop needs no extra query; edits use the existing `replace_section` and `set_fields`.
