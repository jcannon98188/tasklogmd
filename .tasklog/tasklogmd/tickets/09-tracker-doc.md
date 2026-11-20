---
kind: ticket
title: Tracker doc
status: resolved
type: grilling
blocked_by: [6]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/09-tracker-doc.md
---

## Question

Decide the content of the TaskLog tracker doc and the `/setup-matt-pocock-skills` change. For wayfinder, implement-spec, triage and to-tickets, decide the exact tool-call wording that replaces file editing (the "Wayfinding operations" section and the other tracker-doc sections), how the skills discover the daemon, what the setup skill writes (for example MCP server config and the tracker doc), and how a repo moves from the scratch layout to the native format.

## Answer

Settled by grilling with the user (all eight recommendations accepted). No new glossary terms.

**Tracker doc (new seed template `issue-tracker-tasklog.md` in the setup skill)**
- One template with the same headings the skills already read: Conventions, "publish to the issue tracker", "fetch the relevant ticket", Wayfinding operations. Every instruction is an MCP tool call; no file paths to edit. The skills need no code change, because they defer to the tracker doc.
- Conventions section: items live in TaskLog; never edit `.tasklog/` files by hand; reference items by Item ID (`effort/NN`), never by path; start a new effort (map and spec) for each new body of work; the daemon never runs git, so agents commit `.tasklog/` changes with the code.
- It carries a short tool cheat-sheet taken from the workflow mapping table, and the triage rule that keeps the disclaimer as the first line of any `## Comments` entry.

**Wording per skill**

| Skill step | Tool-call wording |
|---|---|
| Fetch the relevant ticket | `get_item(id)` |
| Publish a spec (to-spec) | `create_effort(effort, title, destination?)` if the effort is new, then `replace_section` on `<effort>/spec`; tag `ready-for-agent` through the tag fields |
| Publish tickets (to-tickets) | `create_item(effort, title, question, blocked_by, tags)` once per ticket in dependency order so blockers already have IDs; `add_ac` for each AC; cross-reference by `effort/NN` |
| Wayfinder: orient and pick | `overview`, then `frontier`; claim with `claim(id, claimant)` before any work |
| Wayfinder: resolve | `resolve(id, answer, gist)`; new tickets via `create_item` and `set_fields`; graduate fog with `replace_section` on the map's Not yet specified; ruled-out tickets via `close(id, reason, out_of_scope_gist)` |
| implement-spec | read the graph with `list_items(effort, kind=ticket)` and `get_item`; implementers `toggle_ac` only; the orchestrator calls `resolve` on the integration worktree |
| Triage | `list_items(tags_any=needs-triage)`, `get_item`, `append_to_section(## Comments)`, `triage`, and `close` for wontfix |

**Discovery**
- The tracker doc names the MCP server `tasklog`, so its tools appear as `mcp__tasklog__*`. If the tools are missing, the doc tells the agent to tell the user to run `/setup-matt-pocock-skills` and never to fall back to editing files.

**MCP config**
- The daemon is per-user and the shim picks the workspace from its working directory, so setup registers the server at **user scope** after asking: `claude mcp add --scope user tasklog -- <shim command>`. It checks `claude mcp list` first and skips if `tasklog` is already registered.
- No repo-level `.mcp.json` is written, because it would break for collaborators who have not installed TaskLog. Other MCP clients get a printed config snippet.

**Setup skill change (Section A gains a "TaskLog" option)**
1. Detect the option (a `.tasklog/` directory, or `tasklog` on PATH) and offer it first.
2. Write `docs/agents/issue-tracker.md` from the new template.
3. Update the `## Agent skills` block in CLAUDE.md or AGENTS.md.
4. Write `triage-labels.md` with the five roles as tags (per the workflow mapping).
5. Run a verification call (`workspace_status` over MCP, or the CLI's debug output) and report the result.

**Migration from scratch layout**
- If setup finds `.scratch/` with efforts, it offers a migration: `tasklog import .scratch --dry-run`, show the report, then on approval the real import, then rewrite `docs/agents/issue-tracker.md`.
- It never deletes or edits `.scratch/`; it tells the user to remove or gitignore it later. The user commits `.tasklog/` themselves.

**Amendment to the workflow mapping (ticket 06)**
- `type` becomes optional on `create_item` and `set_fields`. Implementation tickets made by to-tickets for implement-spec are not wayfinder tickets and omit it. `frontier`'s `type` filter then matches only typed tickets. The native format already limits `type` to tickets.
