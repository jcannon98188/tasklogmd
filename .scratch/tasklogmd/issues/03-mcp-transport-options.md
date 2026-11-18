Type: research
Status: open
Blocked by:

## Question

How can a long-running local daemon expose MCP to Claude Code on Windows? Compare the transports Claude Code supports (stdio, streamable HTTP, SSE), the official TypeScript MCP SDK's server APIs, the stdio-shim-to-daemon pattern versus the daemon serving HTTP directly, and how auth and local-only binding work in each. Include how Claude Code configures a server (`.mcp.json`, scopes) and how it handles reconnection. Use primary sources: the MCP spec, the SDK repo and Claude Code's docs.
