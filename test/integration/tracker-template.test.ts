import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const docs = path.resolve(import.meta.dirname, '..', '..', 'docs', 'setup-skill');
const template = fs.readFileSync(path.join(docs, 'issue-tracker-tasklog.md'), 'utf8');

interface ToolDef {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
}

async function listTools(d: { port: number; token: string }): Promise<ToolDef[]> {
  const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${d.token}`,
      'x-tasklog-protocol': '1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return ((await res.json()) as { result: { tools: ToolDef[] } }).result.tools;
}

describe('issue-tracker-tasklog.md template vs the registered MCP tools', () => {
  it('every tool name it mentions exists, the cheat-sheet lists exactly the registered tools minus init_workspace, and call arguments exist', async () => {
    const d = await env.start();
    const tools = await listTools(d);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const known = new Set(byName.keys());

    // Names in `code` spans: a bare snake_case identifier, or the head of `tool(args)`.
    const spans = [...template.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const calls = spans
      .map((s) => /^([a-z]+(?:_[a-z]+)*)\((.*)\)$/.exec(s))
      .filter((m): m is RegExpExecArray => m !== null);
    const bare = spans.filter((s) => /^[a-z]+(?:_[a-z]+)+$/.test(s));
    // Single-word tool names (claim, resolve, ...) are only recognised as calls or in the cheat-sheet.
    const mentioned = new Set([...calls.map((m) => m[1]!), ...bare]);
    expect(mentioned.size).toBeGreaterThan(10);
    // Identifier-like spans that are not tools (frontmatter fields, error codes, args) are allowed explicitly.
    const nonTools = new Set(['stale_hash', 'blocked_by', 'tags_any', 'out_of_scope_gist']);
    for (const name of mentioned) {
      if (nonTools.has(name)) continue;
      expect(known.has(name), `template mentions unknown tool ${name}`).toBe(true);
    }

    // Cheat-sheet is complete: every registered tool except init_workspace (setup's job) appears.
    const cheat = template.split('\n').find((l) => l.startsWith('- Tool cheat-sheet:'))!;
    const listed = [...cheat.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(listed.sort()).toEqual([...known].filter((n) => n !== 'init_workspace').sort());

    // Named arguments in `tool(args)` calls exist in that tool's input schema.
    for (const [, name, argList] of calls) {
      const props = Object.keys(byName.get(name!)?.inputSchema.properties ?? {});
      for (const raw of argList!.split(',')) {
        const m = /^\s*([a-z_]+)\??(?:\s*=.*)?\s*$/.exec(raw);
        if (!m) continue; // quoted heading, `...` and similar
        expect(props, `${name}(${m[1]}) is not an argument of ${name}`).toContain(m[1]);
      }
    }
  });

  it('keeps the section headings the skills read and the five triage roles', () => {
    for (const h of ['## Conventions', '## When a skill says "publish to the issue tracker"', '## When a skill says "fetch the relevant ticket"', '## Wayfinding operations']) {
      expect(template).toContain(h);
    }
    for (const role of ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']) {
      expect(template).toContain(`\`${role}\``);
      expect(fs.readFileSync(path.join(docs, 'triage-labels-tasklog.md'), 'utf8')).toContain(`\`${role}\``);
    }
    expect(template).not.toMatch(/\.tasklog\/[A-Za-z0-9_-]+\//); // no file paths to items
  });
});
