# Issue tracker: tasklog

Issues and specs live in tasklog (`.tasklog/`), accessed via the `tasklog` MCP server (`mcp__tasklog__*`) or the `tasklog` CLI. The workspace is registered with the tasklog daemon (`tasklog list` shows it, `tasklog doctor` verifies the install, `tasklog start` starts the daemon if it is down).

Everything is an **item** with an Item ID. Work is grouped into **efforts**, each a directory `.tasklog/<effort>/` holding:

- `map.md` (Item ID `<effort>/map`): Destination, Notes, Decisions so far, Not yet specified, Out of scope.
- `spec.md` (Item ID `<effort>/spec`): the effort's spec or PRD.
- `tickets/NN-slug.md` (Item ID `<effort>/NN`): one ticket each.

## Conventions

- One ticket = one tasklog ticket (`create_item`). Never one combined tickets file.
- Specs/PRDs are the effort's `spec` item. Tickets reference it by Item ID.
- Use the MCP tools to change items, never edit the files by hand: they keep hashes, timestamps and the map consistent. Writes take the item's `hash` from the last `get_item` or write; on `stale_hash`, retry with `details.current_hash` from the error (no re-read needed). `append_to_section` needs no hash.
- Triage state is a tag set with the `triage` tool (see `triage-labels.md`).
- Comments / conversation go in the ticket's `## Comments` section, appended with `append_to_section`, never overwritten.
- Blocking: the ticket's `blocked_by` field (same-effort numbers or `effort/NN`); change it with `set_fields`.
- Acceptance criteria: `add_ac`, `edit_ac`, `toggle_ac`, `remove_ac`.

## Gotchas

- `triage`, `claim`, `resolve` and `close` take tickets only; a `spec` or `map` item is rejected.
- `resolve`'s `answer` cannot contain a `## ` line. For a multi-section answer pass `answer_sections: {Answer: "...", Evidence: "..."}`: the `Answer` key is the answer, every other key becomes its own `##` section.
- `resolve` and `close` rewrite the effort's map, so its `hash` changes. Take a fresh one with `get_item(id, meta_only: true)`, or use the `current_hash` in the `stale_hash` error.

## Keeping reads small

- `overview` lists Done tickets by id and title only; add `verbose: true` for the Decisions gists.
- `get_item(id, meta_only: true)` for just the hash and frontmatter; `get_item(id, sections: ["Destination", ...])` for part of a body.
- `frontier(effort, fields: ["title"])` trims each entry to the keys you name (`id` is always kept).

## Committing

`commit: true` on `resolve`, `close` and `create_item` stages `.tasklog/` and commits it (message `Resolve <id>: <title>`, never pushes). Use a manual commit when the message needs the gist or other files.

## When a skill says "publish to the issue tracker"

Create a ticket with `create_item` (in an existing effort; `create_effort` first for a new body of work). A spec goes in the effort's `spec` item.

## When a skill says "fetch the relevant ticket"

`get_item` with the Item ID (e.g. `tasklogmd-build/13`); use `list_items` (filters: `effort`, `kind`, `status`, `type`, `tags_*`, `text`) to find it.

## Wayfinding operations

Used by `/wayfinder`.

- **Map**: the effort's `map` item, created by `create_effort`. Edit its sections with `replace_section` and `append_to_section` on `<effort>/map`.
- **Child ticket**: a ticket in the effort created with `create_item`, with `type` set to `research`, `prototype`, `grilling` or `task`. The question goes in the `## Question` section.
- **Blocking**: `blocked_by`. Unblocked = every blocker resolved or closed.
- **Frontier**: the `frontier` tool for the effort (its `ready` list: open, unblocked tickets in ticket order). A claimed ticket is not ready.
- **Claim**: `claim` with a claimant name, before any work.
- **Resolve**: `resolve` with the `answer` and a one-line `gist`; it writes `## Answer`, sets the ticket resolved and appends the gist and link to the map's Decisions so far.
- **Out of scope**: `close` with a `reason` and an `out_of_scope_gist`; it closes the ticket and adds a line to the map's Out of scope.
- **Fog**: the map's Not yet specified section. Graduate a patch into tickets with `create_item` and clear it from the section.
- **Overview**: `overview` for the effort summarises Destination, Decisions so far, in-progress, ready, blocked and drift.
