# 04: Walking skeleton

**What to build:** The thinnest end-to-end path: a TypeScript package whose stdio shim starts the per-user daemon on demand, connects to it over authenticated loopback HTTP, and answers `workspace_status` for the workspace found from the shim's working directory. Spec reference: `.scratch/tasklogmd/spec.md`, sections 2, 7 (logging setup), 8 (`status`, `stop`, `serve`, minimal `doctor`) and 12. Uses the spawn approach the detach spike selected. Includes package and bundling setup, the Vitest layers, `daemon.json` and the lock file, the token, Host and Origin checks, workspace resolution and `workspaces.json`, `init_workspace`, and logging setup.

**Blocked by:** 01 Spike: detach and tree kill

**Status:** ready-for-agent

- [ ] Given no daemon, when a shim connects from a directory under a `.tasklog/` root, then it spawns the daemon, registers the workspace, and `workspace_status` returns `ready`.
- [ ] Given a request without the bearer token, or with an `Origin` header, or with a wrong `Host`, when sent to any endpoint, then it is rejected `unauthorized`.
- [ ] Given a stale `daemon.json` (dead pid), when a shim starts, then it replaces it and connects.
- [ ] Given a directory with no `.tasklog/`, when a workspace-scoped tool is called, then it fails `no_workspace` with an `init` hint, and `init_workspace` creates and registers it.
- [ ] Given a newer shim and an older daemon, when they connect, then the daemon drains, exits and is respawned; an older shim facing a newer daemon errors without restarting it.
- [ ] Given idle clients, when 30 minutes pass (injected clock), then the daemon exits.
- [ ] Given a corrupt `workspaces.json`, when the daemon starts, then it is set aside as `.bak` and rebuilt empty.
- [ ] `tasklog status` exits 3 with no daemon and never starts one; `tasklog stop` on a stopped daemon exits 0; `tasklog serve` runs the daemon in the foreground.
- [ ] A minimal `tasklog doctor` runs the daemon health and protocol checks and exits 0 or 1.
