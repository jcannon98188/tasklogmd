Type: grilling
Status: resolved
Blocked by: 07

## Question

Decide the shim-to-daemon HTTP API beyond the MCP endpoint. Cover health and version endpoints, how a shim or CLI discovers the daemon's port and detects a stale or incompatible daemon, the shutdown endpoint, workspace registration and unregistration (including how the workspace root is resolved from a client's working directory), loopback-only binding and any local auth token, and the versioning and compatibility rule between shim, CLI and daemon.

## Answer

Settled by grilling with the user (all recommendations accepted). Builds on [Daemon architecture](07-daemon-architecture.md) and ADR 0001. No new glossary terms.

**Endpoints** (loopback, all JSON, all behind the bearer token; there is no unauthenticated surface)
- `POST /mcp`: MCP streamable HTTP.
- `GET /health`: `{ok, version, protocol, pid, uptime, workspaces: [{root, state: indexing|ready}]}`. There is no separate `/version`. If another process holds the recorded port it answers 401 or garbage, and clients treat `daemon.json` as stale.
- `POST /shutdown`: drain in-flight writes, then exit.
- `GET /workspaces`, `POST /workspaces` (register, idempotent, optional `init: true`), `DELETE /workspaces` (unregister).

**Workspace root resolution**
- The shim resolves the root: it walks up from its working directory to the nearest ancestor containing `.tasklog/` and sends that absolute path in `X-TaskLog-Workspace`. A nested repo is its own workspace.
- The daemon validates it (absolute, exists, contains `.tasklog/`) and canonicalizes with realpath and Windows case-folding, so one repo never registers twice.
- No `.tasklog/` found: the shim still connects; workspace-scoped tools fail with `no_workspace` and a hint to run `init`. A workspace is bootstrapped by `tasklog init` (CLI) or `POST /workspaces` with `{root, init: true}`, which an MCP `init_workspace` tool wraps, so the setup skill can do it inside an agent session.

**Auth and hardening**
- 256-bit random token, regenerated on each daemon start, sent as `Authorization: Bearer`, compared in constant time.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; any request carrying an `Origin` header is rejected (DNS rebinding and web pages).
- `daemon.json` relies on the per-user ACL on `%LOCALAPPDATA%`; no extra `icacls` in v1.

**Error contract** (management endpoints): `{error: {code, message, retryable}}` with codes `unauthorized` (401), `protocol_mismatch` (409), `indexing` (503, retryable), `shutting_down` (503, retryable), `no_workspace` (404), `bad_request` (400). Inside `/mcp` the same codes surface as MCP tool errors. During drain, new requests get `shutting_down`, which is the shim's restart-and-retry-once trigger.

**Versioning**
- One integer `protocol`, sent by every client in `X-TaskLog-Protocol` and reported by `/health`; semver `version` is informational.
- Within a protocol number, changes are additive only.
- A newer shim restarts an older daemon (ADR 0001); an older shim facing a newer daemon errors and does not restart it. The CLI follows the same rule, except `tasklog stop` and `tasklog status`, which work against any protocol and never restart anything.
