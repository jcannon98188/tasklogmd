---
kind: ticket
title: Mcp transport options
status: resolved
type: research
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/03-mcp-transport-options.md
---

## Question

How can a long-running local daemon expose MCP to Claude Code on Windows? Compare the transports Claude Code supports (stdio, streamable HTTP, SSE), the official TypeScript MCP SDK's server APIs, the stdio-shim-to-daemon pattern versus the daemon serving HTTP directly, and how auth and local-only binding work in each. Include how Claude Code configures a server (`.mcp.json`, scopes) and how it handles reconnection. Use primary sources: the MCP spec, the SDK repo and Claude Code's docs.

## Answer

Full notes: `.scratch/tasklogmd/research/03-mcp-transport-options.md` on branch `research/mcp-transport-options` (never merged). Docs-only research; Windows claims are untested inferences.

- Claude Code supports stdio, HTTP, SSE (deprecated) and WebSocket. The official TypeScript SDK is v2, with `serveStdio` for stdio and `createMcpHandler` plus `toNodeHandler` for HTTP, both stateless.
- Claude Code only spawns stdio servers, so only a stdio shim can start the daemon on first connection. Direct HTTP needs something else to launch it, and a failed first connection is retried only three times.
- Recommendation: stdio shim to the daemon, plus loopback HTTP on the daemon for debugging, with `127.0.0.1` binding, Host/Origin checks and a per-user token. User scope fits one per-user daemon.
- Reconnection: remote servers retry up to five times with backoff, but an interactive stdio server that exits stays failed until reconnected in `/mcp`, so the shim must hide daemon restarts.
- Risk: on Windows, Claude Code ends a stdio server's process tree about 300 ms after closing stdin. A daemon spawned by the shim must be detached from that tree. This needs a spike, to be carried into the daemon architecture ticket.
