// MCP tools for the workflow operations (spec section 5): frontier, overview, claim, release, resolve,
// close, add_decision, add_out_of_scope, triage. Logic lives in `workflow.ts` (writes) and
// `model/workflow.ts` (reads); this file is only the tool surface.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TYPES } from '../model/parse.ts';
import { computeEffortLines, computeFrontier, computeOverview, effortLinesMarkdown, overviewMarkdown, parseStaleAfter } from '../model/workflow.ts';
import type { McpDeps, RequestContext } from './mcp.ts';
import { resolveWorkspace } from './mcp.ts';
import { TRIAGE_CATEGORIES, TRIAGE_STATES, WorkflowService } from './workflow.ts';

type Wrap = <A>(fn: (args: A) => Record<string, unknown> | Promise<Record<string, unknown>>) => (args: A) => Promise<any>;

const workspaceArg = z.string().optional().describe("Absolute workspace root; defaults to the shim's working directory workspace.");
const idArg = z.string().describe('Item ID such as "demo/03".');
const optHash = z.string().optional().describe('Optional item `hash`; when given and stale the call fails stale_hash. Omit it to let the daemon use the current one.');
const staleArg = z
  .union([z.number(), z.string()])
  .optional()
  .describe('A claim is stale when `updated` is older than this: hours as a number, or "90m", "24h", "2d". Default 24h.');

const services = new WeakMap<object, WorkflowService>();
function serviceFor(deps: McpDeps): WorkflowService {
  let s = services.get(deps.writes);
  if (!s) {
    s = new WorkflowService(deps.models, deps.writes, deps.log);
    services.set(deps.writes, s);
  }
  return s;
}

export function registerWorkflowTools(server: McpServer, deps: McpDeps, ctx: RequestContext, wrap: Wrap): void {
  const wf = serviceFor(deps);
  const root = (workspace?: string) => resolveWorkspace(deps, ctx, workspace);

  server.registerTool(
    'frontier',
    {
      description:
        'What can be worked on in an effort. `ready`: open tickets whose blockers are all resolved or closed, in ticket order. `claimed`: claimed tickets with age and a `stale` flag. `blocked`: open tickets with the reasons (a missing, conflicted or invalid blocker counts as not done). `type` matches only typed tickets; `tags` must all be present.',
      inputSchema: {
        effort: z.string(),
        type: z.enum(TYPES).optional(),
        tags: z.array(z.string()).optional().describe('Tickets must carry every one of these tags.'),
        stale_after: staleArg,
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { effort: string; type?: string; tags?: string[]; stale_after?: number | string; workspace?: string }) => {
      const idx = await deps.models.ready(root(a.workspace));
      return { ...computeFrontier(idx, a.effort, { type: a.type, tags: a.tags, staleMs: parseStaleAfter(a.stale_after), now: deps.writes.now() }) };
    }),
  );

  server.registerTool(
    'overview',
    {
      description:
        'Read-only summary of one effort: Destination, counts, Done (with Decisions-so-far gists), In progress (with age and stale flag), Ready, Blocked, Still to do, Ruled out, and drift (a resolved ticket with no Decisions line, or a Decisions line whose ticket is not resolved). With no `effort`, one line per effort. `format`: markdown, json or both (default).',
      inputSchema: {
        effort: z.string().optional(),
        format: z.enum(['markdown', 'json', 'both']).optional(),
        stale_after: staleArg,
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { effort?: string; format?: 'markdown' | 'json' | 'both'; stale_after?: number | string; workspace?: string }) => {
      const idx = await deps.models.ready(root(a.workspace));
      const format = a.format ?? 'both';
      const shape = (data: Record<string, unknown>, markdown: string): Record<string, unknown> =>
        format === 'markdown' ? { markdown } : format === 'json' ? data : { ...data, markdown };
      if (a.effort === undefined || a.effort === '') {
        const efforts = computeEffortLines(idx);
        return shape({ efforts }, effortLinesMarkdown(efforts));
      }
      const o = computeOverview(idx, a.effort, { staleMs: parseStaleAfter(a.stale_after), now: deps.writes.now() });
      return shape({ ...o }, overviewMarkdown(o));
    }),
  );

  server.registerTool(
    'claim',
    {
      description:
        'Claim an open ticket for `claimant` (sets status claimed and claimed_by). Claiming again as the same claimant is a no-op; a different claimant gets already_claimed with `claimed_by`. Claim before doing any work on a ticket.',
      inputSchema: { id: idArg, claimant: z.string().describe('Who is claiming, e.g. "agent-1".'), hash: optHash, workspace: workspaceArg },
    },
    wrap(async (a: { id: string; claimant: string; hash?: string; workspace?: string }) => ({ ...(await wf.claim(root(a.workspace), a)) })),
  );

  server.registerTool(
    'release',
    {
      description: 'Return a claimed ticket to open. Releasing someone else\'s claim needs `force: true`. Fails not_claimed on an open ticket.',
      inputSchema: { id: idArg, claimant: z.string().optional().describe('Who is releasing; must match claimed_by unless `force`.'), hash: optHash, force: z.boolean().optional(), workspace: workspaceArg },
    },
    wrap(async (a: { id: string; claimant?: string; hash?: string; force?: boolean; workspace?: string }) => ({ ...(await wf.release(root(a.workspace), a)) })),
  );

  server.registerTool(
    'resolve',
    {
      description:
        'Resolve a ticket: writes `answer` to `## Answer`, sets status resolved and clears claimed_by; with `gist`, then appends "- [title](tickets/NN-slug.md): gist" to the map\'s Decisions so far (once, even if retried). The ticket is written first, the map second; if the map step fails the result is the retryable `partial` error with per-step results, and repeating the same call finishes it.',
      inputSchema: { id: idArg, answer: z.string(), gist: z.string().optional().describe('One-line decision for the map; omit to skip the map step.'), hash: optHash, workspace: workspaceArg },
    },
    wrap(async (a: { id: string; answer: string; gist?: string; hash?: string; workspace?: string }) => ({ ...(await wf.resolve(root(a.workspace), a)) })),
  );

  server.registerTool(
    'close',
    {
      description:
        'Rule a ticket out without resolving it: writes `reason` to `## Answer`, sets status closed and clears claimed_by; with `out_of_scope_gist`, appends a line to the map\'s Out of scope. Same step results and `partial` retry behaviour as resolve.',
      inputSchema: { id: idArg, reason: z.string(), out_of_scope_gist: z.string().optional(), hash: optHash, workspace: workspaceArg },
    },
    wrap(async (a: { id: string; reason: string; out_of_scope_gist?: string; hash?: string; workspace?: string }) => ({ ...(await wf.close(root(a.workspace), a)) })),
  );

  const mapLineTool = (name: 'add_decision' | 'add_out_of_scope', what: string, run: (r: string, a: { effort: string; title_link: string; gist: string }) => Promise<{ hash: string; changed: boolean }>) =>
    server.registerTool(
      name,
      {
        description: `Append "- <title_link>: <gist>" to the map's ${what}. Skipped (changed: false) when a line with the same link target is already there.`,
        inputSchema: {
          effort: z.string(),
          title_link: z.string().describe('Markdown link such as "[Title](tickets/03-slug.md)".'),
          gist: z.string(),
          workspace: workspaceArg,
        },
      },
      wrap(async (a: { effort: string; title_link: string; gist: string; workspace?: string }) => ({ ...(await run(root(a.workspace), a)) })),
    );
  mapLineTool('add_decision', 'Decisions so far', (r, a) => wf.addDecision(r, a));
  mapLineTool('add_out_of_scope', 'Out of scope', (r, a) => wf.addOutOfScope(r, a));

  server.registerTool(
    'triage',
    {
      description: `Set a ticket's triage state tag (${TRIAGE_STATES.join(', ')}) and optionally its category tag (${TRIAGE_CATEGORIES.join(', ')}), replacing the old ones so exactly one of each remains. \`wontfix\` also closes the ticket with \`note\` as the Answer. For other states \`note\` is appended to \`## Comments\`.`,
      inputSchema: { id: idArg, state: z.enum(TRIAGE_STATES), category: z.enum(TRIAGE_CATEGORIES).optional(), note: z.string().optional(), hash: optHash, workspace: workspaceArg },
    },
    wrap(async (a: { id: string; state: string; category?: string; note?: string; hash?: string; workspace?: string }) => ({ ...(await wf.triage(root(a.workspace), a)) })),
  );
}
