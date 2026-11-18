# Issue tracker: TaskLog

Issues and specs for this repo live in TaskLog, accessed through the `tasklog` MCP server (tools appear as `mcp__tasklog__*`). If those tools are missing, tell the user to run `/setup-matt-pocock-skills`. Never fall back to editing files under `.tasklog/`.

## Conventions

- Items live in TaskLog. Never edit `.tasklog/` files by hand.
- Refer to items by Item ID (`effort/NN`), never by path.
- Start a new effort (map and spec) for each new body of work: `create_effort`.
- The daemon never runs git. Commit `.tasklog/` changes with the code and check git status yourself.
- Triage roles are tags: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Tool cheat-sheet: `list_items`, `get_item`, `create_effort`, `create_item`, `set_fields`, `replace_section`, `append_to_section`, `add_ac`, `edit_ac`, `toggle_ac`, `remove_ac`, `frontier`, `overview`, `claim`, `release`, `resolve`, `close`, `add_decision`, `add_out_of_scope`, `triage`, `workspace_status`.
- Content edits take the `hash` returned by the last read or write. On `stale_hash`, re-read and retry.

## When a skill says "publish to the issue tracker"

- A spec: `create_effort(effort, title, destination?)` if the effort is new, then `replace_section` on `<effort>/spec`; tag `ready-for-agent` through `set_fields`.
- Tickets: `create_item(effort, title, question, blocked_by, tags)` once per ticket in dependency order so blockers already have IDs; `add_ac` for each acceptance criterion; cross-reference by `effort/NN`.

## When a skill says "fetch the relevant ticket"

`get_item(id)`.

## Wayfinding operations

- Orient and pick: `overview(effort)`, then `frontier(effort)`; claim with `claim(id, claimant)` before any work.
- Resolve: `resolve(id, answer, gist)`; new tickets via `create_item` and `set_fields`; graduate fog with `replace_section` on the map's Not yet specified; ruled-out tickets via `close(id, reason, out_of_scope_gist)`.

## implement-spec

Read the graph with `list_items(effort, kind=ticket)` and `get_item`. Implementers only `toggle_ac` on their own ticket. The orchestrator calls `resolve` on the integration worktree.

## Triage

`list_items(tags_any=needs-triage)`, `get_item`, `append_to_section(id, "Comments", ...)` keeping the triage disclaimer as the first line, `triage(id, state, category, note)`, and `close` for `wontfix`.
