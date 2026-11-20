import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isTaskLogError, logTaskLogError, TaskLogError, toTaskLogError } from '../errors.ts';
import type { ListQuery } from '../model/index.ts';
import type { Logger } from '../log.ts';
import type { WorkspaceRegistry } from '../workspaces.ts';
import type { ModelManager } from './models.ts';
import type { WriteService } from './writes.ts';
import { registerEditTools } from './edit-tools.ts';
import { registerWorkflowTools } from './workflow-tools.ts';
import { KINDS, STATUSES, TYPES } from '../model/parse.ts';
import { sectionText } from '../model/workflow.ts';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '../version.ts';

/** What the shim told the daemon about this request. */
export interface RequestContext {
  /** `X-TaskLog-Workspace`: absolute workspace root resolved by the shim (may be absent). */
  workspace?: string;
  /** `X-TaskLog-Cwd`: the shim's working directory, used as the default root of `init_workspace`. */
  cwd?: string;
  requestId: string;
  /** Set by `resolveWorkspace`: the canonical root this request acted on, so its errors log under that workspace. */
  resolved?: string;
}

export interface McpDeps {
  registry: WorkspaceRegistry;
  models: ModelManager;
  writes: WriteService;
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
  ctx.resolved = deps.registry.register(root);
  return ctx.resolved;
}

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(e: unknown, ctx: RequestContext, log: Logger) {
  const { error: te, cause } = toTaskLogError(e, ctx.requestId);
  logTaskLogError(log, te, { requestId: ctx.requestId, workspace: ctx.resolved, via: 'mcp', cause });
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
    <A>(fn: (args: A) => Record<string, unknown> | Promise<Record<string, unknown>>) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
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
    wrap(async ({ workspace }: { workspace?: string }) => {
      const root = resolveWorkspace(deps, ctx, workspace);
      // Waits like other tools, but on timeout reports `state: "indexing"` instead of failing: it is the diagnostic tool.
      const idx = await deps.models.ready(root).catch((e: unknown) => {
        if (isTaskLogError(e) && e.code === 'indexing') return deps.models.peek(root);
        throw e;
      });
      return {
        root,
        state: idx.state,
        counts: idx.counts(),
        architecture: idx.architectureCounts(),
        problems: idx.problems(),
        recent_events: deps.log.recentProblems(root),
      };
    }),
  );

  const workspaceArg = z.string().optional().describe("Absolute workspace root; defaults to the shim's working directory workspace.");

  server.registerTool(
    'list_items',
    {
      description:
        'List items (maps, specs, tickets) in the workspace, ordered by effort then ticket number. Filters AND together. Invalid and conflicted items are included with flags. Architecture elements are hidden unless `kind` is container or component. `components` keeps tickets linked to any of the given element slugs. A ticket naming an element that does not exist carries the flag `dangling`.',
      inputSchema: {
        effort: z.string().optional(),
        kind: z.enum(KINDS).optional().describe('map | spec | ticket | container | component. Elements (container, component) are hidden unless asked for here.'),
        components: z.array(z.string()).optional().describe('Tickets only: keep tickets whose `components` include any of these element slugs.'),
        status: z.enum(STATUSES).optional(),
        type: z.enum(TYPES).optional(),
        tags_all: z.array(z.string()).optional().describe('Items must carry every one of these tags.'),
        tags_any: z.array(z.string()).optional().describe('Items must carry at least one of these tags.'),
        tags_none: z.array(z.string()).optional().describe('Items must carry none of these tags.'),
        text: z.string().optional().describe('Search title, Item ID, tags and all body sections: words AND together (whole word or prefix, case- and diacritic-insensitive), "exact phrase", -excluded. Results rank title first.'),
        snippet: z.boolean().optional().describe('With text: include a ~160-character excerpt per result.'),
        limit: z.number().int().optional().describe('Page size; default 50, capped at 200.'),
        cursor: z.string().optional().describe('Cursor from the previous page; fails stale_cursor if the model changed.'),
        workspace: workspaceArg,
      },
    },
    wrap(async ({ workspace, ...query }: { workspace?: string } & ListQuery) => {
      const root = resolveWorkspace(deps, ctx, workspace);
      const idx = await deps.models.ready(root);
      return { ...idx.list(query) };
    }),
  );

  server.registerTool(
    'get_item',
    {
      description:
        'Fetch one item by Item ID (effort/NN, effort/map, effort/spec): frontmatter, body, ACs, hash, mtime and path. Bodies can be large: pass `meta_only: true` for just the hash and frontmatter (e.g. to refresh a hash), or `sections: ["Destination", ...]` for only those `##` sections.',
      inputSchema: {
        id: z.string().describe('Item ID such as "demo/03".'),
        meta_only: z.boolean().optional().describe('Return the hash, frontmatter, flags, mtime and path, without body or ACs.'),
        sections: z
          .array(z.string())
          .optional()
          .describe('Return `sections` (heading to text, null when missing; headings matched case-insensitively) instead of `body` and ACs.'),
        workspace: workspaceArg,
      },
    },
    wrap(async ({ id, workspace, meta_only, sections }: { id: string; workspace?: string; meta_only?: boolean; sections?: string[] }) => {
      const root = resolveWorkspace(deps, ctx, workspace);
      const idx = await deps.models.ready(root);
      const { parse, ...full } = idx.get(id);
      let view: Record<string, unknown> = full;
      if (meta_only) {
        const { body: _b, acs: _a, ...rest } = full;
        view = rest;
      } else if (sections !== undefined) {
        const { body: _b, acs: _a, ...rest } = full;
        view = { ...rest, sections: Object.fromEntries(sections.map((h) => [h, sectionText(parse, h) ?? null])) };
      }
      let mtime: string | null = null;
      try {
        mtime = fs.statSync(path.join(root, ...full.path.split('/'))).mtime.toISOString();
      } catch {
        /* file vanished since the last scan: the watcher or next rescan will catch up */
      }
      return { ...view, mtime };
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

  registerEditTools(server, deps, ctx, wrap);
  registerWorkflowTools(server, deps, ctx, wrap);

  // The SDK reports invalid arguments as a plain-text tool error. Route them through the error table
  // as `bad_request` so every failure has the same shape and log entry.
  const lowLevel = server.server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<any>> };
  const callTool = lowLevel._requestHandlers?.get('tools/call');
  if (callTool) {
    server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const r = await callTool(req, extra);
      if (r?.isError && !r.structuredContent) {
        const text = (r.content?.[0]?.text as string | undefined) ?? 'Invalid arguments';
        const te = new TaskLogError('bad_request', { message: `${text.replace(/\s+/g, ' ').replace(/[.\s]*$/, '')}; fix the arguments and retry.` });
        return toolError(te, ctx, deps.log);
      }
      return r;
    });
  }

  return server;
}
