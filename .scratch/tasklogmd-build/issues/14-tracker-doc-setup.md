# 14: Tracker doc and setup skill (HITL)

**What to build:** The skills use TaskLog instead of editing files: the new `issue-tracker-tasklog.md` seed template, the setup skill's TaskLog option, user-scope MCP registration and the scratch-to-native migration prompt. Spec reference: `.scratch/tasklogmd/spec.md`, section 10 and Appendix B (the template text). Needs a human for the final real-session checks and for approving user-scope registration.

**Blocked by:** 02 Spike: launch from Claude Code; 09 Workflow tools; 11 Error table and observability; 12 Full CLI; 13 Import

**Status:** ready-for-agent

- [ ] Given a repo with `.tasklog/`, when `/setup-matt-pocock-skills` runs, then it offers TaskLog first, writes `docs/agents/issue-tracker.md` from the template, updates the `## Agent skills` block and writes `triage-labels.md` with the five roles as tags.
- [ ] Given `tasklog` not yet registered, when setup runs, then it asks, then runs `claude mcp add --scope user` using the command line the launch spike fixed, and skips if `claude mcp list` already shows it.
- [ ] Given setup finished, when it verifies, then `workspace_status` over MCP (or `tasklog doctor`) passes and the result is reported.
- [ ] Given a repo with `.scratch/` efforts, when setup runs, then it shows the `tasklog import .scratch --dry-run` report, imports on approval, rewrites the tracker doc, and leaves `.scratch/` untouched for the user to remove or gitignore.
- [ ] Given the TaskLog tracker doc, when wayfinder, to-tickets, implement-spec and triage each run a full pass in a real session, then none edits a file by hand, and the agent is told to run setup if the tools are missing instead of falling back to files.
- [ ] No repo-level `.mcp.json` is written; other MCP clients get a printed config snippet.
