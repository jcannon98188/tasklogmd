# Research: UTCP viability for TaskLog.md (ticket 02)

Researched 2026-11-17. Question: can Claude Code (and Claude generally) use UTCP natively today, and what would it buy over MCP for a local daemon?

## Answer

**No. No Claude client consumes UTCP natively today.** Claude Code's documented tool-extension surface is MCP (plus plugins, skills, hooks), and the Claude Code docs never mention UTCP. The only documented way for Claude Code to reach UTCP tools is the UTCP project's own **bridge**, `utcp-mcp`, which is itself an MCP server. For TaskLog the daemon must ship MCP; UTCP would be an optional extra with little benefit.

## Findings

### 1. Claude Code does not support UTCP

- The Claude Code docs index ([llms.txt](https://code.claude.com/docs/llms.txt)) contains neither "UTCP" nor "Universal Tool Calling". Absent from the Claude API tool-use overview too ([platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)).
- The [MCP page](https://code.claude.com/docs/en/mcp.md) was checked for UTCP, with no match found. The middle of that long page was read only via summary, so absence there is not verified verbatim.
- MCP is the only tool protocol named. Claude Code MCP transports: `stdio` (local process), `http` (recommended for remote), `ws`, and `sse` (deprecated). Other extension points: plugins, skills, hooks, Agent SDK in-process MCP custom tools ([custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools.md)). No OpenAPI or UTCP loader.
- MCP spec transports: stdio and Streamable HTTP ([architecture](https://modelcontextprotocol.io/docs/learn/architecture)).

### 2. How a UTCP manual is served

- A **UTCP manual** is JSON with required `utcp_version`, `manual_version`, `tools[]`. Each tool has `name`, `description`, `inputs`, `outputs`, and a transport/call-template describing how to call it directly (http, sse, cli, text, mcp, ...). Source: [RFC UTCP 1.0.0](https://utcp.io/about/RFC) (status **Draft**, last updated 2025-08-01).
- Convention: provider exposes `GET /utcp` returning the manual. The RFC says how a client finds a manual is "a client-side configuration concern and is not part of the manual specification". Consumers register it via `manual_call_templates` with `call_template_type: "http"` ([utcp.io](https://www.utcp.io/)). Clients can also load a manual from a local file (text template) or convert an OpenAPI document.
- The caller then talks to the tool's native endpoint directly: no wrapper server in the call path.
- Spec repo: [utcp-specification](https://github.com/universal-tool-calling-protocol/utcp-specification); docs site shows version 1.1 (default), with 1.0 and 0.1 listed.
- Caveat: the primary sources disagree with each other (RFC uses `tool_transport`/`transport_type`; utcp.io sample uses `tool_call_template`/`call_template_type` and `utcp_version` "1.0.1"; npm scope `@utcp/core` on utcp.io vs `@utcp/sdk` in the TypeScript repo; licence Apache-2.0 vs MPL-2.0 by directory/repo). The format is still moving.

### 3. Client support: native vs bridge

- Native UTCP clients are the project's SDKs: Python, TypeScript ([typescript-utcp](https://github.com/universal-tool-calling-protocol/typescript-utcp), packages `@utcp/sdk`, `@utcp/http`, `@utcp/cli`, `@utcp/text`, `@utcp/mcp`, ...), Rust, and others. Their README does not mention Claude or Anthropic.
- [utcp-mcp](https://github.com/universal-tool-calling-protocol/utcp-mcp) ("UTCP-MCP Bridge") is an MCP server that exposes UTCP tools to MCP clients. Its README documents adding it to Claude Desktop and to Claude Code via `claude mcp add-json --scope user utcp '…'` (command `npx @utcp/mcp-bridge`, config `UTCP_CONFIG_FILE`). It exposes generic tools: `register_manual`, `deregister_manual`, `call_tool`, `search_tools`, `list_tools`, `tool_info`, `get_required_keys_for_tool`. So Claude sees a handful of generic MCP tools, not the manual's tools as first-class tools.
- The `@utcp/mcp` plugin goes the other way: a UTCP client calling MCP servers.

### 4. What UTCP would buy over MCP for a local daemon

UTCP's pitch ([utcp.io](https://www.utcp.io/)): no wrapper server, direct calls (no "double hop"), manual served at `/utcp`. For TaskLog:

- **No benefit from skipping the wrapper**: the daemon already is the server. MCP over stdio/HTTP to a local daemon has no extra hop worth removing.
- **No Claude client can use it without a bridge**, and the bridge is an MCP server, so MCP is required anyway; UTCP would add a second interface to specify, test and keep in sync.
- Tool-definition context cost is handled on the Claude side by MCP tool search (deferred tool definitions by default, per [MCP docs](https://code.claude.com/docs/en/mcp.md)), which weakens UTCP's context-cost argument for Claude Code.
- Spec maturity risk: RFC marked Draft, inconsistent field names across official pages.
- Possible future value: non-Claude agents using UTCP SDKs could hit a daemon HTTP endpoint directly. Cheap to add later if the daemon already serves HTTP (`GET /utcp`), but out of v1 scope.

## Recommendation for the map

Per the map's rule ("UTCP is adopted only if research shows Claude can use it natively"): **do not adopt UTCP in v1.** MCP only. Revisit if Anthropic documents native UTCP support.

## Limits of this research

- Absence claims rest on the docs index and fetched pages as of 2026-11-17; the middle of the Claude Code MCP page was not read verbatim.
- Pages were read via a fetch sub-agent; version numbers for npm packages were not retrievable.
