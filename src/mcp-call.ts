import type { DaemonState } from './state.ts';
import { PROTOCOL } from './version.ts';

export interface ToolResult {
  isError?: boolean;
  structuredContent?: any;
}

/** Calls one MCP tool on the daemon over `POST /mcp` (stateless JSON-RPC; no stdio shim involved). */
export async function callTool(
  state: DaemonState,
  name: string,
  args: Record<string, unknown>,
  opts: { workspace?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<ToolResult> {
  const res = await fetch(`http://127.0.0.1:${state.port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${state.token}`,
      'x-tasklog-protocol': String(PROTOCOL),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts.workspace ? { 'x-tasklog-workspace': opts.workspace } : {}),
      ...(opts.cwd ? { 'x-tasklog-cwd': opts.cwd } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const body = (await res.json()) as { result?: ToolResult; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result ?? {};
}
