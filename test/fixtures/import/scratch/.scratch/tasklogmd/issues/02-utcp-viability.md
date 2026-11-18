Type: research
Status: resolved
Blocked by:

## Question

Can Claude Code (and Claude generally) use UTCP (Universal Tool Calling Protocol) natively today, and what would it buy over MCP for a local daemon? Establish current client support, how a UTCP manual is served, and whether any Claude client consumes it without a bridge. Use primary sources: the UTCP spec and repos, and Anthropic's Claude Code docs.

## Answer

Full notes: `.scratch/tasklogmd/research/02-utcp-viability.md` on branch `research/utcp-viability` (never merged).

- No Claude client consumes UTCP natively. The Claude Code docs only document MCP.
- The only route is the UTCP project's `utcp-mcp` bridge, which is itself an MCP server. A manual is JSON (`utcp_version`, `manual_version`, `tools[]`), usually at `GET /utcp`. The RFC is still a draft and the official pages disagree on field names.
- For a local daemon UTCP buys nothing over MCP. Decision: MCP only in v1; revisit if Anthropic adds native support.
- Caveat: absence from the MCP docs page rests partly on a summary, since the agent could not read the middle of that page verbatim.
