---
kind: ticket
title: Windows packaging
status: resolved
type: research
created: 2026-01-01
updated: 2026-01-01
imported_from: .scratch/tasklogmd/issues/15-windows-packaging.md
---

## Question

Establish the facts needed to choose Windows packaging and distribution for a Node and TypeScript per-user daemon with a stdio shim. Compare an npm global install (`npx` and `npm i -g`), a Node single executable application, and a bundled installer, on: how an MCP client (Claude Code) launches the shim from a `claude mcp add` command, where per-user data and logs should live on Windows, the Node version to require, how upgrades replace a running daemon, and what each route needs for code signing or SmartScreen. Report findings with primary sources; the choice itself is made in the build spec.

## Answer

Resolved by a research subagent. Full findings, with a per-route comparison table and source links, are on the throwaway branch `research/windows-packaging` (pushed, no PR, never merged) in `.scratch/tasklogmd/research/15-windows-packaging.md`. The branch was written without ADR 0001 in view, so it works from the daemon architecture ticket alone. No choice is made here; the build spec makes it.

**Documented facts**
- Launch: `claude mcp add <name> -- <cmd>` behaves the same in PowerShell and Command Prompt. The default MCP startup timeout is 30 s, and a first `npx` run can exceed it. On Windows, Claude Code closes the shim's stdin and ends its process tree about 300 ms later, which matters for a shim-spawned daemon (reinforces the detach spike). The shim's environment includes `CLAUDE_PROJECT_DIR`.
- Data and logs: `%LOCALAPPDATA%` and `%APPDATA%` are the per-user known folders; no official log guidance, so Local versus Roaming is a design choice.
- Node: 26 is Active LTS; 24 and 22 are Maintenance LTS, with end of life 2027-04-30 (22), 2028-04-30 (24) and 2029-04-30 (26). Built-in `--build-sea` exists from 25.5.0, so among LTS lines only 26 has it. `engines` is advisory unless engine-strict is set.
- Upgrades: Windows deletes fail while other handles are open without delete sharing. Restart Manager closes holders of files in use (Inno Setup's `CloseApplications` uses it); deferring replacement to reboot needs admin rights.
- Signing: SmartScreen reputation builds per file version and EV certificates no longer bypass it. Azure Artifact Signing is about $9.99 a month, gives no instant trust, and is open to individuals only in the USA and Canada. Store distribution avoids SmartScreen warnings.
- Node SEA: "Stability 1.1 - Active development", embeds a single CJS or ESM script, native addons must ship as assets, needs a `.exe` extension on Windows, signing optional.

**Not documented in any official source (verify empirically or decide in the spec)**
- Whether `.cmd` shims, and so `npx` and `npm i -g` bins, launch correctly as an MCP server on Windows without a `cmd /c` wrapper.
- Whether a running exe can be overwritten or renamed on upgrade.
- Whether SmartScreen applies to files that npm installs.
- WiX or MSI behaviour, Inno Setup's default per-user path, and `npx`'s `_npx` cache rules.
