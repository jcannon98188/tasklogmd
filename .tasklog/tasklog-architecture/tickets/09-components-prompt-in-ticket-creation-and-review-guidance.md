---
kind: ticket
title: Components prompt in ticket creation and review guidance
status: resolved
type: grilling
blocked_by: [8, 12]
created: 2026-11-20
updated: 2026-11-20T21:22:31Z
---

## Question

Ticket 07 added the `owners` lookup, and ticket 06 put agent guidance in the tracker template's `## Architecture` section and the tool descriptions. Decide what extra guidance makes `components` links and Architecture-aware review routine without new tools or auto-writing: where triage and ticket-creation skills should be told to call `owners` for files a ticket names and then set `components`; whether the tracker template says that a diff run through `owners` scopes a code review to the touched elements and checks each against its `## Responsibilities` (and whether that belongs in the template or only the `owners` tool description); exact wording, size limits, and how the setup patch (ticket 06) delivers it. Decide whether anything needs a doctor warning or is pure documentation.

## Answer

Settled by grilling with the user (all four recommendations accepted). Builds on tickets 06, 07, 08 and 12. No new tools, no auto-writing of `components`.

1. **Linking guidance**: lives in the tracker template `docs/setup-skill/issue-tracker-tasklog.md`, in the `## Architecture` section (ticket 06), as a short 'Linking tickets' paragraph: when creating or triaging a ticket that names files, call `owners` with those paths, then set `components` with `set_fields` to the returned element slugs; skip when the Architecture is empty or every path is `unowned`. The `owners` tool description carries the same single linking sentence (ticket 07). The triage and ticket-creation skills are external, so they are steered only through the tracker doc (reached via the existing CLAUDE.md Issue tracker pointer) and tool descriptions; no skill edits. `create_item` and `set_fields` descriptions are unchanged.
2. **Review guidance**: template only, 2 to 3 lines under 'Reviewing a change': pass the changed paths to `owners`, read each owner's `## Responsibilities` with `get_item` sections, and flag changes that fall outside them. Not repeated in the `owners` description, so the two cannot drift.
3. **Size and delivery**: the `## Architecture` section grows by at most 8 lines (about 23 total). Delivered by ticket 06's existing refresh step (re-copy the template if unmodified, else print the new section for the human to merge); no separate patch or subsection.
4. **Doctor**: pure documentation. Ticket 06's single warning (elements exist but the tracker doc has no Architecture section) stands; no probe for the new lines. The existing template unit test (style of `test/unit/tracker-template.test.ts`) gains assertions that `owners`, `components` and `Responsibilities` appear in the section and that it stays within the line cap.
5. **Slice**: folds into the slice that owns onboarding text from ticket 05 (template, descriptions, setup patch); build order unchanged.
