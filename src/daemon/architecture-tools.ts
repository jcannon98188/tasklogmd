// MCP tool registration for the Architecture. Slice 5 registers `scan_architecture` only; slice 2's
// `architecture`, `create_element` and `owners` register alongside it. The scan itself lives in
// `architecture-scan.ts`.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpDeps, RequestContext } from './mcp.ts';
import { resolveWorkspace } from './mcp.ts';
import { scanArchitecture } from './architecture-scan.ts';

type Wrap = <A>(fn: (args: A) => Record<string, unknown> | Promise<Record<string, unknown>>) => (args: A) => Promise<any>;

export function registerArchitectureTools(server: McpServer, deps: McpDeps, ctx: RequestContext, wrap: Wrap): void {
  server.registerTool(
    'scan_architecture',
    {
      description:
        'Propose and refresh architecture elements from the repo: one container per buildable manifest and one component per source directory, matched to existing elements by the files they own. New elements are written `proposed` with empty Description and Responsibilities; a rescan changes only owned `code` roots and never touches curated content, review state or other elements. Drift (missing paths, unowned code, renames) is reported in `findings`, never fixed. With `dry_run: true` it reports the same result and writes nothing.',
      inputSchema: {
        dry_run: z.boolean().optional().describe('true: compute and report the result without writing any file.'),
        workspace: z.string().optional().describe("Absolute workspace root; defaults to the shim's working directory workspace."),
      },
    },
    wrap(async ({ dry_run, workspace }: { dry_run?: boolean; workspace?: string }) => {
      const root = resolveWorkspace(deps, ctx, workspace);
      return { ...(await scanArchitecture(deps, root, dry_run === true)) };
    }),
  );
}
