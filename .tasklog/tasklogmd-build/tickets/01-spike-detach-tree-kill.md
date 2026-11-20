---
kind: ticket
title: "Spike: detach and tree kill"
status: resolved
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd-build/issues/01-spike-detach-tree-kill.md
---

## Question

**What to build:** A throwaway, fully scripted spike that proves whether a shim-spawned daemon survives Claude Code's Windows process-tree kill. One command runs it and prints pass or fail per point. Spec reference: `.scratch/tasklogmd/spec.md`, section 13 (Spike 1) and section 2 (Lifecycle). Headless `claude -p` is assumed to behave like an interactive session; if evidence later shows it does not, reopen this ticket.



- [x] A script launches a stub shim through `claude mcp add` and a headless Claude Code session; the stub shim spawns a stub daemon using `spawn` with `detached`, `stdio: 'ignore'`, `windowsHide`, then `unref`, and writes a state file.
- [x] Given a normal Claude Code exit, when the session ends, then the stub daemon is still running.
- [x] Given Claude Code killed as a process tree (`taskkill /T /F`), when the tree dies, then the stub daemon is still running.
- [x] Given the launching terminal is closed programmatically, when it closes, then the stub daemon is still running.
- [x] Given a second Claude Code session, when its shim starts, then it finds the daemon through the state file and connects without spawning another.
- [x] Given the spawn, when it happens, then window enumeration shows no console window created.
- [x] If any of the survival checks fails, the script retries with `cmd /c start`, then with a one-shot scheduled task, in that order, and reports which approach passed.
- [x] The result (per-point pass or fail and the winning approach) is written into section 13 of the spec, and section 2's lifecycle wording is updated to name the winner. If every approach fails, the ticket reports that the architecture must be reopened and stops.

## Comments

- Winner: `cmd.exe /d /c start "" /b node daemon` via Node `spawn` (`stdio: ignore`, `windowsHide: true`, NOT `detached`). Plain detached `spawn` FAILED point 2: taskkill /T walks parent PIDs and the live shim is the daemon parent. Spec sections 2 and 13 updated.
- Run: `node spikes/01-detach/run.mjs [--only spawn|cmdstart|schtask]`; evidence in `spikes/01-detach/results.json`. The scheduled-task fallback is implemented but was not exercised in the final run (not needed); an earlier trial of it showed new terminal windows.
- Unverified: interactive (non-headless) Claude Code, manual Task Manager End Task, manual click on the terminal X (WM_CLOSE posted programmatically instead).
- Daemon launch recipe for ticket(s) building the real shim: do not combine `detached: true` with `cmd start` (flashes a Windows Terminal window).
