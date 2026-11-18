import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isTaskLogError, TaskLogError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { WorkspaceRegistry } from '../workspaces.ts';
import { VERSION } from '../version.ts';

/** What the shim told the daemon about this request. */
export interface RequestContext {
  /** `X-TaskLog-Workspace`: absolute workspace root resolved by the shim (may be absent). */
  workspace?: string;
  /** `X-TaskLog-Cwd`: the shim's working directory, used as the default root of `init_workspace`. */
  cwd?: string;
  requestId: string;
}

export interface McpDeps {
  registry: WorkspaceRegistry;
  log: Logger;
  version?: string;
}

/**
 * Resolves the workspace for a workspace-scoped tool: the tool's `workspace` argument, else the shim's
 * header. Unregistered roots auto-register under the usual validation. No root: `no_workspace`.
 */
export function resolveWorkspace(deps: McpDeps, ctx: RequestContext, arg?: string): string {
  const root = arg ?? ctx.workspace;
  if (!root) throw new TaskLogError('no_workspace', { details: { hint: 'init' } });
  return deps.registry.register(root);
}

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(e: unknown, ctx: RequestContext, log: Logger) {
  let te: TaskLogError;
  if (isTaskLogError(e)) {
    te = e;
  } else {
    te = new TaskLogError('internal', { details: { request_id: ctx.requestId } });
    log.error('request.internal_error', { request_id: ctx.requestId, error: (e as Error)?.message, stack: (e as Error)?.stack });
  }
  const level = te.level;
  log[level]('request.error', { request_id: ctx.requestId, code: te.code, message: te.message });
  const body = te.toJSON();
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${te.code}: ${te.message}\n${JSON.stringify(body)}` }],
    structuredContent: { error: body },
  };
}

/** A fresh stateless MCP server per request, closed over that request's context. */
export function createMcpServer(deps: McpDeps, ctx: RequestContext): McpServer {
  const server = new McpServer({ name: 'tasklog', version: deps.version ?? VERSION });

  const wrap =
    <A>(fn: (args: A) => Record<string, unknown>) =>
    (args: A) => {
      try {
        return ok(fn(args));
      } catch (e) {
        return toolError(e, ctx, deps.log);
      }
    };

  server.registerTool(
    'workspace_status',
    {
      description: 'Report the indexing state, counts, problems and recent warnings of the current workspace.',
      inputSchema: { workspace: z.string().optional().describe('Absolute workspace root; defaults to the shim\'s working directory workspace.') },
    },
    wrap(({ workspace }: { workspace?: string }) => {
      const root = resolveWorkspace(deps, ctx, workspace);
      return {
        root,
        state: 'ready',
        counts: { items: 0 },
        problems: [],
        recent_events: deps.log.recentProblems(root),
      };
    }),
  );

  server.registerTool(
    'init_workspace',
    {
      description: 'Create .tasklog/ in a directory (default: the working directory) and register it as a workspace.',
      inputSchema: { root: z.string().optional().describe('Absolute directory to initialise.') },
    },
    wrap(({ root }: { root?: string }) => {
      const target = root ?? ctx.workspace ?? ctx.cwd;
      if (!target) throw new TaskLogError('bad_request', { message: 'No root given and no working directory known; pass root.' });
      return { root: deps.registry.register(target, { init: true }) };
    }),
  );

  return server;
}
