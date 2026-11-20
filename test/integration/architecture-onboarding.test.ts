// Slice 7a: onboarding text and the doctor warning. The tracker template's `## Architecture` section, the four
// tool descriptions, `tasklog doctor`'s one-line warning, and preservation of the Interface/Seams body-section conventions.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, runCommand } from '../../src/commands.ts';
import type { RunningDaemon } from '../../src/daemon/core.ts';
import { makeEnv, mkWorkspace, type TestEnv } from '../helpers.ts';

let env: TestEnv;
let d: RunningDaemon;
let emptyPathDir: string;
beforeEach(async () => {
  env = makeEnv();
  d = await env.start();
  emptyPathDir = path.join(env.root, 'emptybin');
  fs.mkdirSync(emptyPathDir);
});
afterEach(async () => {
  await env.cleanup();
});

async function rpc(root: string | null, method: string, params: object): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${d.token}`,
      'x-tasklog-protocol': '1',
      ...(root ? { 'x-tasklog-workspace': root } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return ((await res.json()) as { result: any }).result;
}
async function tool(root: string, name: string, args: object = {}): Promise<any> {
  const r = await rpc(root, 'tools/call', { name, arguments: args });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
  return r.structuredContent;
}

async function cli(args: string[], cwd: string) {
  let stdout = '';
  const code = await runCommand(args, {
    stdout: (s) => (stdout += s),
    stderr: () => {},
    cwd,
    paths: env.paths,
    env: { ...process.env, PATH: emptyPathDir },
    spawn: () => void env.start(),
  });
  return { code, stdout };
}

const docs = path.resolve(import.meta.dirname, '..', '..', 'docs', 'setup-skill');
const template = fs.readFileSync(path.join(docs, 'issue-tracker-tasklog.md'), 'utf8');

function architectureSection(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Architecture\s*$/.test(l));
  expect(start, 'template has no ## Architecture section').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start, end === -1 ? undefined : end);
}

describe('tracker template ## Architecture section', () => {
  it('covers the tools, linking, review, body sections and the GLOSSARY-MAP line, within the line cap', () => {
    const section = architectureSection(template);
    const text = section.join('\n');
    // About 23 lines (cap 24), trailing blanks aside.
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(24);
    for (const term of ['owners', 'components', 'Responsibilities', 'Interface', 'Seams', 'Decisions', 'GLOSSARY-MAP.md', 'scan_architecture', 'create_element', 'architecture', 'review: accepted', 'proposed']) {
      expect(text, `section lacks ${term}`).toContain(term);
    }
    expect(text).toMatch(/never edit element files by hand/i);
    expect(text).toMatch(/never delete/i);
  });
});

describe('architecture tool descriptions', () => {
  it('each of the four tools has a self-contained 3 to 5 sentence description', async () => {
    const tools: { name: string; description: string }[] = (await rpc(null, 'tools/list', {})).tools;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    for (const name of ['architecture', 'scan_architecture', 'create_element', 'owners']) {
      const desc = byName.get(name);
      expect(desc, name).toBeTruthy();
      // Sentence = text ending in . ! or ? followed by a space or the end; `code` spans such as "get_item." are not split.
      const sentences = desc!.replace(/`[^`]*`/g, 'X').split(/[.!?](?:\s+|$)/).filter((s) => s.trim() !== '');
      expect(sentences.length, `${name}: ${sentences.length} sentences`).toBeGreaterThanOrEqual(3);
      expect(sentences.length, `${name}: ${sentences.length} sentences`).toBeLessThanOrEqual(5);
    }
    expect(byName.get('owners')).toMatch(/components/);
    expect(byName.get('scan_architecture')).toMatch(/replace_section/);
    expect(byName.get('scan_architecture')).toMatch(/review: accepted/);
  });
});

describe('doctor: architecture guidance warning', () => {
  const check = (out: string) => JSON.parse(out).checks.find((c: any) => c.name === 'architecture-guidance');

  it('warns on one line when elements exist but the tracker doc has no Architecture section, and stays exit 0', async () => {
    const ws = mkWorkspace(env.root);
    await tool(ws, 'create_element', { kind: 'container', title: 'App', code: ['src'] });
    const r = await cli(['doctor', '--json', '--workspace', ws], env.root);
    const c = check(r.stdout);
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/^warning: /);
    expect(c.detail).not.toContain('\n');
    expect(c.detail).toContain('docs/agents/issue-tracker.md');
    expect(r.code).toBe(EXIT.ok);
  });

  it('is quiet once the tracker doc has the section', async () => {
    const ws = mkWorkspace(env.root);
    await tool(ws, 'create_element', { kind: 'container', title: 'App', code: ['src'] });
    fs.mkdirSync(path.join(ws, 'docs', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs', 'agents', 'issue-tracker.md'), '# Tracker\n\n## Architecture\n\nstuff\n');
    const c = check((await cli(['doctor', '--json', '--workspace', ws], env.root)).stdout);
    expect(c.ok).toBe(true);
    expect(c.detail).not.toMatch(/^warning/);
  });

  it('is quiet when there are no elements', async () => {
    const ws = mkWorkspace(env.root);
    const c = check((await cli(['doctor', '--json', '--workspace', ws], env.root)).stdout);
    expect(c.detail).not.toMatch(/^warning/);
  });
});

describe('Interface and Seams preservation', () => {
  const read = (root: string, slug: string) => fs.readFileSync(path.join(root, '.tasklog', 'architecture', `${slug}.md`), 'utf8');

  it('create_element writes only Description and Responsibilities', async () => {
    const ws = mkWorkspace(env.root);
    const r = await tool(ws, 'create_element', { kind: 'container', title: 'Core', code: ['src'] });
    const headings = [...read(ws, r.slug).matchAll(/^## .*$/gm)].map((m) => m[0]);
    expect(headings).toEqual(['## Description', '## Responsibilities']);
  });

  it('replace_section and a rescan keep hand-written Interface and Seams', async () => {
    const ws = mkWorkspace(env.root);
    fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"app"}\n');
    fs.mkdirSync(path.join(ws, 'src', 'a'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'a', 'x.ts'), 'export const x = 1;\n');
    await tool(ws, 'scan_architecture');
    const slug = fs.readdirSync(path.join(ws, '.tasklog', 'architecture')).find((n) => n.endsWith('.md'))!.replace(/\.md$/, '');
    const id = `architecture/${slug}`;
    const hash = async () => (await tool(ws, 'get_item', { id, meta_only: true })).hash;

    await tool(ws, 'replace_section', { id, heading: 'Interface', content: 'Call run() first.', hash: await hash() });
    await tool(ws, 'replace_section', { id, heading: 'Seams', content: 'The clock is injected.', hash: await hash() });
    await tool(ws, 'replace_section', { id, heading: 'Responsibilities', content: 'Owns x.', hash: await hash() });
    await tool(ws, 'scan_architecture');
    const after = read(ws, slug);
    expect(after).toMatch(/## Interface\s+Call run\(\) first\./);
    expect(after).toMatch(/## Seams\s+The clock is injected\./);
    expect(after).toMatch(/## Responsibilities\s+Owns x\./);
  });
});

