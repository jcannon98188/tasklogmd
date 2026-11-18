# 01: Spike: detach and tree kill

**What to build:** A throwaway, fully scripted spike that proves whether a shim-spawned daemon survives Claude Code's Windows process-tree kill. One command runs it and prints pass or fail per point. Spec reference: `.scratch/tasklogmd/spec.md`, section 13 (Spike 1) and section 2 (Lifecycle). Headless `claude -p` is assumed to behave like an interactive session; if evidence later shows it does not, reopen this ticket.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A script launches a stub shim through `claude mcp add` and a headless Claude Code session; the stub shim spawns a stub daemon using `spawn` with `detached`, `stdio: 'ignore'`, `windowsHide`, then `unref`, and writes a state file.
- [ ] Given a normal Claude Code exit, when the session ends, then the stub daemon is still running.
- [ ] Given Claude Code killed as a process tree (`taskkill /T /F`), when the tree dies, then the stub daemon is still running.
- [ ] Given the launching terminal is closed programmatically, when it closes, then the stub daemon is still running.
- [ ] Given a second Claude Code session, when its shim starts, then it finds the daemon through the state file and connects without spawning another.
- [ ] Given the spawn, when it happens, then window enumeration shows no console window created.
- [ ] If any of the survival checks fails, the script retries with `cmd /c start`, then with a one-shot scheduled task, in that order, and reports which approach passed.
- [ ] The result (per-point pass or fail and the winning approach) is written into section 13 of the spec, and section 2's lifecycle wording is updated to name the winner. If every approach fails, the ticket reports that the architecture must be reopened and stops.
