<img src="assets/icon.svg" width="64" height="64" alt="">

# TaskLogMD

Created in [T3 Code](https://t3.codes).

TaskLog keeps your tasks as markdown files under `.tasklog/` and exposes them to AI agents over MCP. A small per-user daemon owns the files; each agent session talks to it through a stdio shim (`tasklog shim`).

## Install

Requires Node 24 or newer (Node 22 and older are not supported).

```
npm i -g tasklog
tasklog --version
tasklog doctor
```

`tasklog doctor` verifies the install: Node version, data and log directories, daemon health, `workspaces.json`, the current workspace, and whether `claude` has `tasklog` registered. Every failing check prints a `fix:`. `engines` is advisory in npm, so `doctor` is what reports an old Node.

TaskLog stores its state in `%LOCALAPPDATA%\tasklog\` (`daemon.json`, `workspaces.json`, `logs\`).

## Register with Claude Code

Register once, at user scope (all projects):

```
claude mcp add --scope user tasklog -- tasklog shim
```

No `cmd /c` wrapper is needed on Windows. Start a new Claude Code session afterwards, then check with `claude mcp list`. Do not add a repo-level `.mcp.json`. For other MCP clients, configure a stdio server whose command is `tasklog` with the single argument `shim`.

Create a workspace in a repository with `tasklog init` (or the `init_workspace` tool); it creates `.tasklog/`.

## Importing existing tasks

```
tasklog import <path> --dry-run
tasklog import <path>
```

`import` auto-detects a Backlog.md layout (`backlog/` with `config.yml`) or a `.scratch/<effort>/` layout and writes into `.tasklog/` in the same workspace. It never modifies the source, runs without the daemon, and is idempotent: re-running skips items already imported and never overwrites hand edits. Use `--effort <name>` to force one effort, `--group-by none` to skip milestone splitting, and `--json` for machine output. It exits non-zero if any file was skipped.

## Upgrading

Stop the daemon first, then upgrade:

```
tasklog stop
npm i -g tasklog
```

`tasklog stop` is recommended, not strictly required: if a daemon is still running, the new shim detects the version mismatch and restarts it. The package is bundled into one file per entry point, so a running daemon never lazy-loads a file the upgrade replaced.

### Why the daemon's working directory is outside the package

On Windows, a process whose working directory is inside the package directory blocks `npm i -g` (the directory rename fails with `EBUSY`). The shim therefore spawns the daemon with its working directory set to the data directory (`%LOCALAPPDATA%\tasklog\`), never the package directory. The daemon also contains no native addons, so nothing in the package is locked by a loaded `.node` file.

## Commands

`shim`, `serve`, `start`, `stop`, `status`, `init`, `add <path>`, `remove <path>`, `list`, `import <path>`, `doctor`, `--version`. `status`, `list`, `doctor` and `import` accept `--json`. Exit codes: `0` ok, `1` failed, `2` usage error, `3` no daemon (`status`), `4` protocol mismatch.

## Development

```
npm ci
npm test
npm run typecheck
npm pack --dry-run   # inspect the tarball: README, package.json and dist/cli.js, dist/daemon.js
```
