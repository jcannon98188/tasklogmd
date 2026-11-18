import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFixture, makeEnv, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

async function listItems(d: { port: number; token: string }, root: string, args: object) {
  const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${d.token}`,
      'x-tasklog-protocol': '1',
      'x-tasklog-workspace': root,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_items', arguments: args } }),
  });
  return ((await res.json()) as { result: { isError?: boolean; structuredContent: any } }).result;
}

describe('list_items text search over MCP', () => {
  it('finds diacritic titles, honours tags_none and snippets, and covers the Comments section', async () => {
    const root = copyFixture('normal', env.root);
    const d = await env.start();
    const cafe = await listItems(d, root, { text: 'cafe menu', snippet: true });
    expect(cafe.isError).toBeUndefined();
    expect(cafe.structuredContent.items.map((i: any) => i.id)).toEqual(['beta/01']);
    expect(cafe.structuredContent.items[0].matched_in).toContain('title');
    expect(typeof cafe.structuredContent.items[0].snippet).toBe('string');

    const none = await listItems(d, root, { text: 'cafe', tags_none: ['i18n'] });
    expect(none.structuredContent.items).toEqual([]);

    const plain = await listItems(d, root, { text: 'cafe' });
    expect(plain.structuredContent.items[0].snippet).toBeUndefined();
  });
});
