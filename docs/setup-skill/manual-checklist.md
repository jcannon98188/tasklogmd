# Ticket 14: manual checklist (human only)

Do these after applying `README.md` to the setup skill. They cover the acceptance criteria automation cannot.

1. **Approve registration.** In a repo with `.tasklog/`, run `/setup-matt-pocock-skills`. Confirm TaskLog is offered first, you are asked before registering, and it runs `claude mcp add --scope user tasklog -- tasklog shim` (and skips if `claude mcp list` already shows `tasklog`). Confirm no `.mcp.json` appears in the repo.
2. **Setup output.** Confirm `docs/agents/issue-tracker.md` equals the template, the `## Agent skills` block is updated, `triage-labels.md` lists the five roles as tags, and `workspace_status` (or `tasklog doctor`) passes and is reported.
3. **Migration.** In a repo with `.scratch/` efforts: the dry-run report is shown, the import runs only after approval, the tracker doc is rewritten, and `.scratch/` is untouched (`git status` shows no changes under it).
4. **Skill passes in a real session** (new session after registration), one full pass each of `wayfinder`, `to-tickets`, `implement-spec` and `triage`. For each, confirm no `.tasklog/` file was edited by hand and all changes went through `mcp__tasklog__*` tools.
5. **Missing tools.** Disable or remove the `tasklog` server, start a session, run a skill: the agent must tell you to run `/setup-matt-pocock-skills` and must not fall back to editing files.
6. **Other clients.** Paste the printed JSON snippet into one non-Claude MCP client and confirm it connects.
7. **Refresh an existing tracker doc.** In a repo set up before the Architecture feature, run the setup skill: an unmodified `docs/agents/issue-tracker.md` is re-copied from the template, a locally edited one is left alone and the `## Architecture` section is printed for you to merge. Afterwards `tasklog doctor` no longer warns about the missing section.
