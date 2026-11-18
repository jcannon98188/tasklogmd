// MCP tools for the generic edit operations (spec section 5): set_fields, replace_section,
// append_to_section, add_ac, edit_ac, toggle_ac, remove_ac. Each is one change per call, requires the
// caller's `hash`, and returns the new `hash`. All of them go through `WriteService.edit`.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TaskLogError } from '../errors.ts';
import type { Edit } from '../model/edit.ts';
import { TYPES } from '../model/parse.ts';
import type { RequestContext, McpDeps } from './mcp.ts';
import { resolveWorkspace } from './mcp.ts';

type Wrap = <A>(fn: (args: A) => Record<string, unknown> | Promise<Record<string, unknown>>) => (args: A) => Promise<any>;

const workspaceArg = z.string().optional().describe("Absolute workspace root; defaults to the shim's working directory workspace.");
const idArg = z.string().describe('Item ID such as "demo/03".');
const hashArg = z.string().describe('The item `hash` from the last get_item or write. A stale hash fails stale_hash: re-read and retry.');

export function registerEditTools(server: McpServer, deps: McpDeps, ctx: RequestContext, wrap: Wrap): void {
  const write = async (args: { id: string; hash: string; workspace?: string }, edit: Edit): Promise<Record<string, unknown>> => {
    const root = resolveWorkspace(deps, ctx, args.workspace);
    return { ...(await deps.writes.edit(root, args.id, args.hash, edit)) };
  };

  server.registerTool(
    'set_fields',
    {
      description:
        'Edit frontmatter fields of an item in place (title, type, tags, blocked_by). `status` cannot be set here except `reopen: true`, which returns a claimed, resolved or closed item to open. Tags are normalised to lowercase [a-z0-9-]. Pass `type: null` to remove the type.',
      inputSchema: {
        id: idArg,
        hash: hashArg,
        title: z.string().optional(),
        type: z.enum(TYPES).nullable().optional().describe('research | prototype | grilling | task; null removes it. Tickets only.'),
        tags: z.array(z.string()).optional().describe('Replaces the whole tag list.'),
        blocked_by: z.array(z.union([z.number().int(), z.string()])).optional().describe('Replaces the blockers: same-effort numbers or "effort/NN".'),
        reopen: z.boolean().optional().describe('true: set status back to open (clears claimed_by).'),
        status: z.unknown().optional().describe('Not settable here; use reopen, claim, resolve or close.'),
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { id: string; hash: string; workspace?: string; status?: unknown; title?: string; type?: (typeof TYPES)[number] | null; tags?: string[]; blocked_by?: Array<number | string>; reopen?: boolean }) => {
      if (a.status !== undefined) {
        throw new TaskLogError('bad_request', {
          message: 'status cannot be set with set_fields; use reopen: true to reopen, or claim, resolve and close.',
        });
      }
      const edit: Edit = { op: 'set_fields' };
      if (a.title !== undefined) edit.title = a.title;
      if (a.type !== undefined) edit.type = a.type;
      if (a.tags !== undefined) edit.tags = a.tags;
      if (a.blocked_by !== undefined) edit.blocked_by = a.blocked_by;
      if (a.reopen !== undefined) edit.reopen = a.reopen;
      return write(a, edit);
    }),
  );

  const sectionTool = (name: 'replace_section' | 'append_to_section', description: string) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          id: idArg,
          hash: hashArg,
          heading: z.string().describe('Section heading without "##", matched case-insensitively, e.g. "Answer" or "Comments".'),
          content: z.string().describe('Markdown for the section body. It must not contain a "## " heading line.'),
          workspace: workspaceArg,
        },
      },
      wrap((a: { id: string; hash: string; heading: string; content: string; workspace?: string }) =>
        write(a, { op: name, heading: a.heading, content: a.content }),
      ),
    );
  sectionTool(
    'replace_section',
    'Replace the body of one `##` section (created at the end of the file if it does not exist). Other sections are untouched and never reordered.',
  );
  sectionTool(
    'append_to_section',
    'Append content on new lines after the last non-blank line of a `##` section (created if missing). Start the content with a blank line to begin a new paragraph.',
  );

  server.registerTool(
    'add_ac',
    {
      description: 'Add an acceptance criterion to the item, numbered max+1. Returns the new AC number in `n`.',
      inputSchema: { id: idArg, hash: hashArg, text: z.string(), checked: z.boolean().optional(), workspace: workspaceArg },
    },
    wrap((a: { id: string; hash: string; text: string; checked?: boolean; workspace?: string }) =>
      write(a, { op: 'add_ac', text: a.text, ...(a.checked !== undefined ? { checked: a.checked } : {}) }),
    ),
  );

  server.registerTool(
    'edit_ac',
    {
      description: 'Change the text of acceptance criterion #n, keeping its number and checked state.',
      inputSchema: { id: idArg, hash: hashArg, n: z.number().int(), text: z.string(), workspace: workspaceArg },
    },
    wrap((a: { id: string; hash: string; n: number; text: string; workspace?: string }) => write(a, { op: 'edit_ac', n: a.n, text: a.text })),
  );

  server.registerTool(
    'toggle_ac',
    {
      description: 'Check or uncheck acceptance criterion #n. Without `checked` it flips the current state.',
      inputSchema: { id: idArg, hash: hashArg, n: z.number().int(), checked: z.boolean().optional(), workspace: workspaceArg },
    },
    wrap((a: { id: string; hash: string; n: number; checked?: boolean; workspace?: string }) =>
      write(a, { op: 'toggle_ac', n: a.n, ...(a.checked !== undefined ? { checked: a.checked } : {}) }),
    ),
  );

  server.registerTool(
    'remove_ac',
    {
      description: 'Remove acceptance criterion #n. Other ACs keep their numbers.',
      inputSchema: { id: idArg, hash: hashArg, n: z.number().int(), workspace: workspaceArg },
    },
    wrap((a: { id: string; hash: string; n: number; workspace?: string }) => write(a, { op: 'remove_ac', n: a.n })),
  );

  server.registerTool(
    'create_effort',
    {
      description:
        'Start a new body of work: creates `<effort>/map.md` (fixed headings Destination, Notes, Decisions so far, Not yet specified, Out of scope) and `<effort>/spec.md`. `effort` is a lowercase kebab-case name; it fails bad_request if the effort already exists. Returns the map and spec IDs.',
      inputSchema: {
        effort: z.string().describe('Effort name, lowercase kebab-case, e.g. "billing-v2". Becomes the directory and the Item ID prefix.'),
        title: z.string().describe('Title of the map and spec.'),
        destination: z.string().optional().describe('Text for the map\'s Destination section.'),
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { effort: string; title: string; destination?: string; workspace?: string }) => {
      const root = resolveWorkspace(deps, ctx, a.workspace);
      return { ...(await deps.writes.createEffort(root, { effort: a.effort, title: a.title, ...(a.destination !== undefined ? { destination: a.destination } : {}) })) };
    }),
  );

  server.registerTool(
    'create_item',
    {
      description:
        'Create a new ticket in an existing effort. The number is max+1 over the effort\'s tickets; the file is named NN-slug.md from the title. `effort` is required (use create_effort first for a new body of work). The ticket starts `open` with a `## Question` section. Returns `id` and `hash`.',
      inputSchema: {
        // Optional in the schema only so that a missing effort fails with our `bad_request`, not a protocol error.
        effort: z.string().optional().describe('Existing effort name. Required, with no default: a missing effort fails bad_request.'),
        title: z.string(),
        question: z.string().describe('Body of the ticket\'s `## Question` section (markdown, no "## " headings).'),
        type: z.enum(TYPES).optional().describe('research | prototype | grilling | task; omit for an implementation ticket (no `type` key is written).'),
        blocked_by: z.array(z.union([z.number().int(), z.string()])).optional().describe('Same-effort numbers or "effort/NN".'),
        tags: z.array(z.string()).optional().describe('Normalised to lowercase [a-z0-9-].'),
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { effort?: string; title: string; question: string; type?: (typeof TYPES)[number]; blocked_by?: Array<number | string>; tags?: string[]; workspace?: string }) => {
      const root = resolveWorkspace(deps, ctx, a.workspace);
      return { ...(await deps.writes.createItem(root, { effort: a.effort as string, title: a.title, question: a.question, type: a.type, blocked_by: a.blocked_by, tags: a.tags })) };
    }),
  );
}
