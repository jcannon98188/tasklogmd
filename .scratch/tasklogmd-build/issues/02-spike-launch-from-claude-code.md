# 02: Spike: launch from Claude Code

**What to build:** A throwaway, scripted spike that answers open verification item V1: can Claude Code launch an npm-global-install `.cmd` shim as an MCP server on Windows without a `cmd /c` wrapper, and does a cold start reach healthy inside the 30 s startup timeout. Spec reference: `.scratch/tasklogmd/spec.md`, sections 10, 11 and 13 (Spike 2).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A stub package with a `tasklog` bin is globally installed with `npm i -g` from a local path, producing the real `.cmd` shim.
- [ ] Given `claude mcp add --scope user tasklog -- tasklog shim`, when a headless Claude Code session starts, then the server connects and a trivial tool call succeeds.
- [ ] If that fails, the script retries with `cmd /c tasklog shim` and reports which form works.
- [ ] Given no daemon running, when the server is started cold (including the stub daemon spawn), then it reports healthy within the 30 s MCP startup timeout, and the measured time is recorded.
- [ ] The result is recorded as the answer to V1 in section 13 of the spec, and the exact `claude mcp add` command line is fixed in sections 10 and 11.
- [ ] The script cleans up after itself: it removes the user-scope registration and uninstalls the stub package.
