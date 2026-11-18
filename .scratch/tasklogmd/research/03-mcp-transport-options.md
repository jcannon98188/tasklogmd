# Research: MCP transport options for a long-running local daemon on Windows

Ticket: [03-mcp-transport-options](../issues/03-mcp-transport-options.md)
Researched: 2026-11-17

**Question.** How can a long-running local daemon expose MCP to Claude Code on Windows? Compare the transports Claude Code supports, the TypeScript SDK's server APIs, the stdio-shim-to-daemon pattern against serving HTTP directly, and how auth, local-only binding, configuration, scopes and reconnection work.

Convention: **[F]** is a fact from a primary source (cited). **[I]** is my inference, which the spec should treat as a hypothesis to verify with a spike.

## Answer in brief

1. Claude Code supports four transports: stdio, HTTP (streamable HTTP), SSE (deprecated) and WebSocket. A daemon should use **stdio or HTTP**. SSE is deprecated, and WebSocket has no OAuth or `claude mcp add --transport` support.
2. **Claude Code cannot start your daemon when it connects over HTTP.** It only spawns stdio servers. TaskLog's settled requirement, "auto-starts on the first MCP connection", therefore forces a **stdio shim** that launches the daemon on demand. A direct-HTTP design would need the user or an OS mechanism to start the daemon first.
3. The official SDK is now **v2** (`@modelcontextprotocol/server`, implementing spec 2026-07-28). `createMcpHandler(factory)` plus `toNodeHandler` serves HTTP, and `serveStdio(factory)` serves stdio. Both are stateless per request or connection. v1 (`@modelcontextprotocol/sdk`) still gets fixes for at least six months after 2026-07-27.
4. For a local daemon, auth is optional in the spec and the SDK handlers verify nothing. Bind `127.0.0.1`, validate `Host` and `Origin`, and optionally add a static bearer token via Claude Code's `headers` field.

## 1. Transports Claude Code supports

- **stdio.** Claude Code launches the server as a child process. The spec says clients SHOULD support stdio whenever possible. Messages are newline-delimited JSON-RPC. The server must write only MCP messages to stdout and may log to stderr. [F: MCP spec 2025-11-25 transports; Claude Code docs, Installing MCP servers → Option 3]
- **Streamable HTTP.** The server is an independent process with a single MCP endpoint that supports POST and GET, with optional SSE streaming. Claude Code's docs call it "the recommended option for connecting to remote MCP servers". Config `type` is `http`, with `streamable-http` accepted as an alias. [F: MCP spec transports; Claude Code docs, Option 1]
- **SSE.** The old HTTP+SSE transport (spec 2024-11-05) was replaced by Streamable HTTP. Claude Code docs: "deprecated. Use HTTP servers instead". From Claude Code v2.1.265, `--transport http` falls back to SSE automatically. Ignore SSE for a new daemon. [F: spec transports → Backwards Compatibility; Claude Code docs, Option 2]
- **WebSocket** (`type: "ws"`). Header-only auth, with no OAuth and no `claude mcp add --transport` support. It suits servers that push events. [F: Claude Code docs, Option 4] Not recommended here.
- **Custom transports** (for example a named pipe or Unix socket) are allowed by the spec, but Claude Code's config only accepts `stdio`, `http`, `sse` and `ws`. A JSON entry with a `url` and no `type` is read as stdio and rejected. [F: spec "Custom Transports"; Claude Code docs, Option 1] **[I]** A named-pipe MCP transport is therefore not directly reachable from Claude Code. Pipes are still usable *behind* a stdio shim (see §3).

## 2. Official TypeScript SDK server APIs

The SDK's `main` branch is **v2** (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`). It implements spec 2026-07-28 and runs on Node, Bun and Deno. v1 (`@modelcontextprotocol/sdk`) lives on the `v1.x` branch. [F: SDK repo README]

Claude Code itself runs on MCP TypeScript SDK 1.x or 2.x, depending on a runtime picked at startup. The v2 runtime asks HTTP and stdio servers whether they support the newer revision and uses it where they do. It connects to every other server as v1 does. `MCP_SDK_GENERATION` and `MCP_PROTOCOL_NEGOTIATION` override this. [F: Claude Code docs, MCP client runtimes] **[I]** Pin the spec's server to an SDK generation that serves both eras, which is the v2 default.

Server-side API surface (v2):

| API | Purpose | Source |
| - | - | - |
| `new McpServer({name, version})`, `registerTool(name, {description, inputSchema}, handler)` | Define tools. Schemas use Standard Schema (Zod v4, Valibot, ArkType). | SDK README |
| `serveStdio(factory)` from `@modelcontextprotocol/server/stdio` | Stdio entry. Owns the transport and returns a handle whose `close()` shuts it down. A stdin EOF tears the connection down. Log to stderr only. | SDK docs `serving/stdio.md` |
| `createMcpHandler(factory, opts?)` | Streamable HTTP entry. Returns `{ fetch, close, notify, bus }`, where `fetch` is a web-standard `(Request) => Response`. The factory runs once per request and receives `era`, `authInfo` and `requestInfo`. | `serving/http.md` |
| `toNodeHandler(handler)` and `localhostHostValidation()` / `localhostOriginValidation()` from `@modelcontextprotocol/node` | Mount on `node:http`. Bind loopback explicitly. | `serving/http.md`, `packages/middleware/node/README.md` |
| `createMcpExpressApp`, `createMcpHonoApp`, `createMcpFastifyApp` | Framework factories that arm Host and Origin validation by default on localhost binds. | `serving/http.md` |
| `NodeStreamableHTTPServerTransport({ sessionIdGenerator })` | Hand-wired 2025-era transport. A generator gives sessions via `Mcp-Session-Id`, and `undefined` is stateless. `eventStore` adds SSE resumability via `Last-Event-ID`. | `serving/sessions-state-scaling.md` |
| `requireBearerAuth({ verifier, requiredScopes, ... })` | Resource-server gate. Returns 401 or 403 with a `WWW-Authenticate` challenge, and passes `authInfo` into the handler. | `serving/authorization.md` |
| `legacy: 'stateless' \| 'reject'` (HTTP) and `legacy: 'serve' \| 'reject'` (stdio) | Whether 2025-era clients are served. | `serving/legacy-clients.md` |

Facts that shape the daemon design:

- **Per-request factory.** The HTTP handler builds a fresh `McpServer` per request and holds nothing between requests. Connection pools and caches must live at module scope and be closed over by the factory ("Keep the factory cheap and side-effect-free"). [F: `serving/http.md`] The in-memory task model is exactly this kind of module-scope state, so the stateless handler fits.
- **No sessions in the 2026-07-28 revision.** Sessions (`Mcp-Session-Id`) exist only for the 2025-era hand-wired transport. [F: `serving/sessions-state-scaling.md`] The spec's session rules, for the 2025 transport: the server MAY assign an ID, a 404 means the client re-initializes, and DELETE ends a session. [F: MCP spec transports → Session Management]
- **Change notifications.** The handler's `notify` and `bus` publish `list_changed`, `resourceUpdated` and similar events to `subscriptions/listen` streams. The default bus is in-process. [F: `serving/sessions-state-scaling.md`] This is relevant if the daemon later pushes "task file changed" events.
- **The handler does not authenticate.** "It validates no Host header, no Origin header, and no token. Mount those checks in front of it." [F: `serving/http.md`]

## 3. Stdio shim to daemon versus daemon serving HTTP directly

### Option A: daemon serves Streamable HTTP directly (`type: http`)

```json
{ "mcpServers": { "tasklog": { "type": "http", "url": "http://127.0.0.1:PORT/mcp" } } }
```

- **Pros.** One process, one MCP stack, no shim to ship. The daemon's HTTP handler is stateless and shared by every Claude Code session. Reconnects cost nothing special.
- **Cons.**
  - **Nobody starts the daemon.** Claude Code only spawns stdio servers. For HTTP it connects, and on a transient failure such as connection refused it retries the first connection up to three times, then marks the server failed [F: Claude Code docs, Failed first connections]. This breaks the settled "auto-start on first MCP connection" requirement unless something else starts the daemon (a Windows Task Scheduler logon task, a Startup entry, or the user running a CLI). The OS service install is explicitly deferred.
  - A fixed port must be agreed in committed `.mcp.json`, or injected with `${VAR:-default}` expansion [F: Claude Code docs, Environment variable expansion]. Port collisions are a user-visible failure.
  - Mid-session daemon restarts reconnect with the policy in §5, which is fine.
  - **[I]** One possible workaround is `headersHelper`, a command Claude Code runs at connect time to produce headers [F: Claude Code docs, dynamic headers]. A helper could start the daemon and return its auth header. Its docs describe it as a header generator, not a launcher, so this is a hack to prove or reject in a spike, not a design basis.

### Option B: stdio shim that forwards to the daemon (`type: stdio` or no `type`)

```json
{ "mcpServers": { "tasklog": { "command": "node", "args": ["C:/…/tasklog-shim.js"] } } }
```

- **Pros.**
  - Claude Code spawns the shim per session, so the shim can detect a missing daemon, start it, wait for readiness, then proxy. This is the only transport on which Claude Code itself triggers the launch.
  - Claude Code sets `CLAUDE_PROJECT_DIR` in the spawned server's environment, so the shim can tell the daemon which workspace to register. It also answers `roots/list` with the launch directory plus added directories [F: Claude Code docs, Option 3].
  - Shim to daemon can use any private IPC, such as a Windows named pipe or loopback TCP with a token. That is not constrained by Claude Code's config types. **[I]**
  - Auth to the client is unnecessary. The spec says implementations using stdio "SHOULD NOT" follow the OAuth authorization spec and should take credentials from the environment instead [F: MCP spec authorization §Introduction].
- **Cons.**
  - Two components: the shim (thin, with no business logic) and the daemon.
  - Each Claude Code session has its own shim process, though all share one daemon.
  - **Windows lifecycle risk.** When Claude Code disconnects a stdio server it closes the server's stdin, then ends the server's **process tree** if the process is still running 300 ms later (Windows). Before v2.1.296 it ended the tree immediately [F: Claude Code docs, How Claude Code stops a stdio server]. **[I]** A daemon spawned as a plain child of the shim could be killed with it. The daemon must be spawned detached and outside that tree, which Node's `child_process.spawn` supports via `{detached: true, stdio: 'ignore'}` plus `unref()`. Whether that escapes the tree-kill on Windows is unverified. **Spike it.**
  - The shim must write nothing but MCP frames to stdout [F: spec; SDK stdio docs], so all its logging goes to stderr. Spawning on Windows with `npx` and similar wrappers needs care, but a direct `node` command avoids that.
  - Stdio reconnection is weaker than remote reconnection (see §5).

### Hybrid

The shim can *be* an MCP server (via `serveStdio`) that proxies each tool call to the daemon over HTTP or a pipe. Alternatively it can act as a dumb byte pipe between stdio and the daemon's Streamable HTTP endpoint, which keeps one authoritative MCP implementation in the daemon. **[I]** The byte-pipe form is smallest, but has two risks: it must handle protocol-era negotiation transparently, and it adds a hop to every message. Pick it in the spec only after a spike.

### Comparison

| Concern | A: direct HTTP | B: stdio shim |
| - | - | - |
| Auto-start on first MCP use | No (needs external starter) | Yes (shim starts the daemon) |
| Claude Code config | `type: http` and a URL | `command` and `args` |
| Moving parts | 1 | 2 |
| Auth surface | Loopback port (needs Host/Origin checks and optionally a token) | None to the client; the shim-to-daemon link needs its own protection |
| Windows process-tree kill | Not applicable | Must detach the daemon |
| Reconnect after daemon restart | Automatic, with backoff | Only for `claude -p` and the Agent SDK; interactive needs manual `/mcp` Reconnect (see §5) |
| Shared across sessions | Native | Via the shim's IPC |

**Recommendation for the spec** (my judgment): **Option B**, with a thin shim whose first job is ensure-daemon-running, because it satisfies the already-settled auto-start requirement. Have the daemon also expose Streamable HTTP on `127.0.0.1` for debugging and for clients that prefer it. The shim-to-daemon link should be an authenticated local channel. Write a spike that proves the Windows detach behaviour before committing.

## 4. Auth and local-only binding

- **Spec.** Authorization is OPTIONAL. For HTTP-based transports implementations SHOULD follow the OAuth-based authorization spec (a resource server that verifies tokens), and stdio implementations SHOULD NOT [F: MCP spec authorization].
- **Streamable HTTP security requirements.** Servers MUST validate the `Origin` header (respond 403 when it is present and invalid), SHOULD bind only to `127.0.0.1` rather than `0.0.0.0` when local, and SHOULD authenticate all connections. This mitigates DNS rebinding from websites [F: spec transports → Security Warning].
- **SDK.** The HTTP handler validates nothing. Use `localhostHostValidation()` and `localhostOriginValidation()` and call `.listen(port, '127.0.0.1')`. `requireBearerAuth` takes a `verifier` you supply (JWT, introspection, or any custom function; a static-token comparison fits) [F: `serving/http.md`, `serving/authorization.md`].
- **Claude Code client auth for an HTTP server.**
  - Static headers via `--header` or a `headers` block in `.mcp.json`. `${VAR}` and `${VAR:-default}` expansion works in `command`, `args`, `env`, `url` and `headers`.
  - Credential-like variables such as `ANTHROPIC_API_KEY` and `NPM_TOKEN` read as empty in a remote server's `url` and `headers`, so use your own variable name, such as `TASKLOG_TOKEN`.
  - `headersHelper` generates headers at connect time.
  - OAuth 2.0 flows work for HTTP servers. Claude Code flags a server as needing auth on 401 or 403, except when you configured an `Authorization` header yourself, in which case a 401 or 403 is just a failed connection [F: Claude Code docs, Authenticate with remote MCP servers; Environment variable expansion].
  - The v2 runtime sends OAuth credentials only to HTTPS token endpoints or `localhost`, `127.0.0.1` and `::1` [F: Claude Code docs, MCP client runtimes]. OAuth is overkill for a loopback daemon, and a static bearer token is the pragmatic choice.
- **Practical rule for TaskLog.** Do not bind a non-loopback interface. Validate Host and Origin. Require a per-user random token (stored in a file readable only by the user) on every request, whether to the HTTP endpoint or the shim-to-daemon channel. **[I]** On Windows a named pipe with a user-only ACL avoids a TCP port entirely, but I found no primary source on pipe ACL behaviour in Node, so verify it.

## 5. Claude Code configuration and reconnection

**Config forms.** `claude mcp add --transport http <name> <url>`, `claude mcp add <name> -- <command> [args]` for stdio, `claude mcp add-json <name> '<json>'`, or hand-edit `.mcp.json`. Entries need an explicit `type` when they use a `url` [F: Claude Code docs].

**Scopes.** [F: Claude Code docs, MCP installation scopes]

| Scope | Loads in | Shared | Stored in |
| - | - | - | - |
| Local (default) | This project only | No | `~/.claude.json` under the project path |
| Project | This project only | Yes, via VCS | `.mcp.json` at the project root |
| User | All projects | No | `~/.claude.json` |

Precedence is local, then project, then user, then plugin-provided, then claude.ai connectors. The whole entry from the winning source is used, with no field merging. Project-scoped servers need user approval in interactive sessions (`claude mcp reset-project-choices` resets it). In `claude -p` and Agent SDK runs, project servers load without asking. A cloned repo cannot approve its own servers in an untrusted folder. **[I]** Because TaskLog is one per-user daemon for many workspaces, **user scope** is the natural fit: it is private and applies to every project. A committed `.mcp.json` per repo would also work but repeats the config per workspace.

**Plugins.** Plugins can bundle MCP servers, and `${CLAUDE_PROJECT_DIR}` is substituted directly in plugin configs [F: Claude Code docs, Plugin-provided MCP servers]. A plugin is a possible distribution route and belongs to the Windows packaging ticket.

**Reconnection** [F: Claude Code docs, Automatic reconnection]:

- *Remote (HTTP/SSE) mid-session drop:* up to five reconnect attempts with exponential backoff (1 s, doubling). Interactive sessions show the server as pending, then failed, with a manual retry in `/mcp` (`/mcp reconnect all` from v2.1.284). In `claude -p` and Agent SDK runs, transient failures keep retrying in the background for about 30 minutes.
- *Remote first connection:* up to three retries on 5xx, connection refused or timeout. Auth and not-found errors are not retried.
- *Stdio process exits mid-session:* in an interactive session the server is marked failed until the user selects Reconnect in `/mcp`. In `claude -p` and Agent SDK runs it restarts on the next tool call.
- *Discovery requests* (`tools/list` and others) retry three times on transient errors.
- *Timeouts:* `MCP_TIMEOUT` is the startup timeout. A per-server `timeout` field and `MCP_TOOL_TIMEOUT` cap tool calls. HTTP/SSE servers also get a per-request first-byte timer of at least 60 s.
- *Dynamic updates:* a `list_changed` notification makes Claude Code refresh the lists in interactive sessions (only tools in `-p` and the SDK).

Consequence for design: **if the daemon dies, an interactive Claude session on a stdio shim does not heal itself.** On the shim path, the shim should therefore hide daemon restarts (reconnect to the daemon and re-spawn it) instead of exiting. An exiting shim leaves the user with a failed server and a manual Reconnect. A direct-HTTP server heals automatically within five attempts (about 31 s of backoff) if the daemon returns quickly.

## 6. Open questions to resolve with a spike (not answerable from docs)

1. Does a daemon spawned `detached` from a stdio shim survive Claude Code's Windows process-tree kill? Test on the current Claude Code release.
2. Can a shim that is a pure stdio-to-HTTP byte pipe handle both protocol eras, or does it need to be a real MCP server (`serveStdio`) proxying calls?
3. Does Claude Code's `headersHelper` tolerate being used to ensure the daemon is up (Option A fallback)? Probably leave it out of the spec.
4. Named-pipe ACLs in Node for the shim-to-daemon channel, against loopback TCP with a token.

## Sources

- MCP specification, Transports (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP specification, Authorization (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP TypeScript SDK repo (README, `docs/serving/{stdio,http,sessions-state-scaling,authorization,legacy-clients}.md`, `docs/protocol-versions.md`, `packages/middleware/node/README.md`): https://github.com/modelcontextprotocol/typescript-sdk
- MCP TypeScript SDK v2 docs: https://ts.sdk.modelcontextprotocol.io/v2/
- Claude Code docs, "Connect Claude Code to tools via MCP": https://code.claude.com/docs/en/mcp

Limits of this research: I read the published docs and the SDK docs on `main`. I did not install the SDK or run any transport, and the Windows behaviours marked [I] are untested.
