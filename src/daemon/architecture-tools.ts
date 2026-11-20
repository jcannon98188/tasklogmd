// MCP tools for the architecture: create_element, architecture, owners (slice 2). Logic lives in
// `model/architecture.ts` (pure reads) and `writes.ts` (element creation); this file is the tool surface.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TaskLogError } from '../errors.ts';
import { applyDepth, buildTree, danglingWarnings, filterFindings, filterWarnings, lookupOwners, scopeTree, type TicketLink } from '../model/architecture.ts';
import { planFindingToDrift, type DriftFinding } from '../model/drift.ts';
import { computeScan, scanArchitecture } from './architecture-scan.ts';
import type { McpDeps, RequestContext } from './mcp.ts';
import { resolveWorkspace } from './mcp.ts';

type Wrap = <A>(fn: (args: A) => Record<string, unknown> | Promise<Record<string, unknown>>) => (args: A) => Promise<any>;

const workspaceArg = z.string().optional().describe("Absolute workspace root; defaults to the shim's working directory workspace.");

export function registerArchitectureTools(server: McpServer, deps: McpDeps, ctx: RequestContext, wrap: Wrap): void {
  const root = (workspace?: string) => resolveWorkspace(deps, ctx, workspace);

  server.registerTool(
    'architecture',
    {
      description:
        'The architecture as a compact tree: `{containers: [{id, title, review, uses, tickets: {open, claimed}, children}], findings, warnings}`. Counts are direct (a ticket linking a component counts for it, not its container) and cover open and claimed tickets only; there are no bodies or `code` lists, so read an element with get_item. `root` (a bare slug) returns one container\'s subtree, or a component under its parent; `depth: 0` leaves out children. `findings` is drift (missing owned paths, unowned code), computed on each call and never fixed; `drift: false` skips it. `warnings` list dangling references.',
      inputSchema: {
        root: z.string().optional().describe('Bare element slug, not the Item ID. A container gives its subtree; a component gives its parent as a stub with only that child.'),
        depth: z.number().optional().describe('0 for containers only; 1 (default) includes components.'),
        drift: z.boolean().optional().describe('Include drift findings (default true).'),
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { root?: unknown; depth?: unknown; drift?: boolean; workspace?: string }) => {
      const ws = root(a.workspace);
      const bad = (message: string) => new TaskLogError('bad_request', { message });
      if (a.root !== undefined && (typeof a.root !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(a.root))) {
        throw bad('root must be a bare element slug such as "daemon" (lowercase letters, digits and "-"), not an Item ID like "architecture/daemon".');
      }
      if (a.depth !== undefined && (typeof a.depth !== 'number' || !Number.isInteger(a.depth) || a.depth < 0)) throw bad('depth must be a non-negative integer: 0 for containers only, 1 (default) for components too.');
      const depth: 0 | 1 = a.depth === 0 ? 0 : 1;
      const idx = await deps.models.ready(ws);
      // Drift is the scan plan run read-only (slice 5); it also catches the model up with the files on disk.
      let findings: DriftFinding[] = a.drift === false ? [] : (await computeScan(deps.models, ws)).plan.findings.map(planFindingToDrift);
      const elements = idx.elements();
      const tickets: TicketLink[] = idx
        .entries()
        .filter((e) => e.layoutKind === 'ticket' && e.parse.ok)
        .map((e) => ({ id: e.id, status: e.parse.ok ? e.parse.fields.status : undefined, components: e.parse.ok ? (e.parse.fields.components ?? []) : [] }));
      let tree = buildTree(elements, tickets);
      let warnings = danglingWarnings(elements, tickets);
      if (a.root !== undefined) {
        const scoped = scopeTree(tree, elements, a.root);
        tree = scoped.stub ? scoped.tree : applyDepth(scoped.tree, depth);
        findings = filterFindings(findings, elements, scoped.slugs);
        warnings = filterWarnings(warnings, scoped.slugs);
      } else tree = applyDepth(tree, depth);
      return { containers: tree, findings, warnings };
    }),
  );

  server.registerTool(
    'create_element',
    {
      description:
        'Create an architecture element by hand: a `container` (a buildable unit such as a package or project) or a `component` (a feature or layer inside a container, with `parent` set to that container\'s slug). It starts `review: accepted` with empty `## Description` and `## Responsibilities` to fill with replace_section. `code` lists the repo-relative directories or files it owns (roots, never globs; "." is the workspace root). The slug is made from the title and is permanent. Returns `{id, hash, path, slug}`.',
      inputSchema: {
        kind: z.enum(['container', 'component']),
        title: z.string().describe('Human title; the slug (kebab-case) is derived from it and never changes.'),
        parent: z.string().optional().describe('Components only: slug of an existing container.'),
        code: z.array(z.string()).optional().describe('Owned roots, repo-relative, e.g. ["src/daemon"].'),
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { kind: string; title: string; parent?: string; code?: string[]; workspace?: string }) => ({ ...(await deps.writes.createElement(root(a.workspace), a)) })),
  );

  server.registerTool(
    'scan_architecture',
    {
      description:
        'Propose and refresh architecture elements from the repo: one container per buildable manifest and one component per source directory, matched to existing elements by the files they own. New elements are written `proposed` with empty Description and Responsibilities; a rescan changes only owned `code` roots and never touches curated content, review state or other elements. Drift (missing paths, unowned code, renames) is reported in `findings`, never fixed. With `dry_run: true` it reports the same result and writes nothing.',
      inputSchema: {
        dry_run: z.boolean().optional().describe('true: compute and report the result without writing any file.'),
        workspace: workspaceArg,
      },
    },
    wrap(async (a: { dry_run?: boolean; workspace?: string }) => ({ ...(await scanArchitecture(deps, root(a.workspace), a.dry_run === true)) })),
  );

  server.registerTool(
    'owners',
    {
      description:
        'Read-only. Given file paths, say which architecture elements own them: the element with the longest matching `code` root wins, so a component beats its container. Returns `{owners: [{id, kind, title, paths}], unowned}`. Paths may use backslashes, `./` or absolute paths under the workspace; they need not exist, so files from a diff work. Before setting a ticket\'s `components`, ask `owners` which elements own the files you will touch; it never writes `components` itself.',
      inputSchema: { paths: z.array(z.string()).describe('1 to 500 file or directory paths.'), workspace: workspaceArg },
    },
    wrap(async (a: { paths: string[]; workspace?: string }) => {
      const ws = root(a.workspace);
      const idx = await deps.models.ready(ws);
      return { ...lookupOwners(idx.elements(), a.paths, ws) };
    }),
  );
}
