# Per-user daemon behind a stdio shim over authenticated loopback HTTP

TaskLog runs one per-user daemon that serves every workspace. MCP clients never talk to it directly: Claude Code only spawns stdio servers, so a stdio shim starts the daemon on demand and proxies to its single loopback HTTP server (`127.0.0.1`, bearer token, Host/Origin checks). The model is never persisted; the files are the only state, and recovery is always a rescan.

## Considered Options

- **Daemon serves MCP over HTTP directly:** nothing in Claude Code can start it on first connection, and a failed first connection is retried only a few times.
- **Named pipe for the shim plus HTTP for debugging:** two server surfaces to secure and test, for no gain over one HTTP endpoint.
- **Persisted model or journal:** temp-and-rename writes keep every file whole, so a journal would only add a second source of truth to drift from the files.

## Consequences

- The shim owns spawn, reconnect and version-skew handling, because Claude Code leaves a stdio server that exits in a failed state.
- Surviving Claude Code's Windows process-tree kill depends on detached spawn, which is unverified and is the first implementation spike.
