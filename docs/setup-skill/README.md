# Setup skill: TaskLog option (patch instructions)

Ready-to-apply changes for `/setup-matt-pocock-skills` (spec section 10). Nothing here has been applied to the installed plugin under `~/.claude/plugins`; a human applies it (see `manual-checklist.md`).

Files in this folder:

- `issue-tracker-tasklog.md`: the seed template (spec Appendix B). Add it to the setup skill next to the other `issue-tracker-*.md` seeds. A test (`test/unit/tracker-template.test.ts`) keeps its tool names and arguments in sync with the server.
- `triage-labels-tasklog.md`: the `triage-labels.md` text for TaskLog, with the five roles as tags.
- `manual-checklist.md`: the human-only checks.

## Section A: add a "TaskLog" option

1. **Detect.** TaskLog is available if the repo has a `.tasklog/` directory, or `tasklog` is on PATH (`tasklog --version` exits 0). If detected, offer TaskLog **first** in the issue-tracker question, labelled "TaskLog (MCP-backed local markdown, recommended for agents)". Otherwise list it last and mention it needs `npm i -g tasklog`.
2. **Register the MCP server (once, user scope).**
   - Run `claude mcp list`. If a `tasklog` entry exists, skip this step.
   - Otherwise ask: "Register the `tasklog` MCP server for your user (all projects)?" Only on a yes run exactly:

     ```
     claude mcp add --scope user tasklog -- tasklog shim
     ```

     This is the form Spike 02 fixed: no `cmd /c` wrapper on Windows (the npm `.cmd` shim launches directly).
   - **Never** write a repo-level `.mcp.json`.
   - Tell the user a new Claude Code session is needed to pick up the server.
3. **Write the tracker doc.** Copy `issue-tracker-tasklog.md` to `docs/agents/issue-tracker.md` unchanged.
4. **Update the `## Agent skills` block** in `CLAUDE.md`/`AGENTS.md`:

   ```
   ### Issue tracker

   Issues and specs live in TaskLog (MCP server `tasklog`). See `docs/agents/issue-tracker.md`.

   ### Triage labels

   Default five-role vocabulary as TaskLog tags (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.
   ```

   Leave the `### Domain docs` subsection as it is.
5. **Write `docs/agents/triage-labels.md`** from `triage-labels-tasklog.md`.
6. **Initialise** if `.tasklog/` is missing: the `init_workspace` tool, or `tasklog init`.
7. **Verify.** Call `workspace_status` over MCP (needs a restarted session if just registered), or else run `tasklog doctor`. Report the result (state, counts, problems). A failure is reported, not hidden.
8. **Refresh an existing tracker doc** (repos set up before the Architecture feature). If `docs/agents/issue-tracker.md` has no `## Architecture` section, compare it with the previous template. If it is unmodified, re-copy `issue-tracker-tasklog.md` over it. If it has local edits, print the template's `## Architecture` section for the human to merge by hand and do not overwrite the file. `tasklog doctor` warns, in one line, when elements exist but the section is missing.

## Migration prompt (repo has `.scratch/` efforts)

If `.scratch/` contains efforts, ask:

> This repo has `.scratch/` issues. Import them into TaskLog? I'll first show a dry-run report; nothing is changed until you approve.

1. Run `tasklog import .scratch --dry-run` and show the report (efforts, items, skipped files, warnings).
2. On approval run `tasklog import .scratch`; then rewrite `docs/agents/issue-tracker.md` (and the triage labels doc) from the TaskLog templates.
3. **Never edit or delete `.scratch/`.** Tell the user to remove it or add it to `.gitignore` themselves, and to commit `.tasklog/`.

## Printed snippet for other MCP clients

For clients that are not Claude Code, print (do not write to any file):

```json
{
  "mcpServers": {
    "tasklog": {
      "command": "tasklog",
      "args": ["shim"]
    }
  }
}
```

On Windows, if a client cannot launch `.cmd` shims directly, use `"command": "cmd", "args": ["/c", "tasklog", "shim"]`.

## Missing tools in a later session

The tracker doc already tells agents: if `mcp__tasklog__*` tools are missing, tell the user to run `/setup-matt-pocock-skills`, and never edit `.tasklog/` files as a fallback. No skill code changes are needed.
