import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelManager } from '../../src/daemon/models.ts';
import { WorkspaceRegistry } from '../../src/workspaces.ts';
import { makeEnv, mkWorkspace, type TestEnv } from '../helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe('registry prune', () => {
  it('disposes the index and watcher of a vanished workspace, so a recreated one is indexed afresh', async () => {
    const ws = mkWorkspace(env.root);
    const tickets = path.join(ws, '.tasklog', 'e', 'tickets');
    fs.mkdirSync(tickets, { recursive: true });
    fs.writeFileSync(path.join(tickets, '01-a.md'), '---\nkind: ticket\ntitle: A\nstatus: open\n---\n\n## Question\n\nq\n');

    const registry = new WorkspaceRegistry(env.paths, env.log);
    const models = new ModelManager(registry, env.log, { watcher: { enabled: false } });
    registry.load();
    const root = registry.register(ws);
    const first = await models.ready(root);
    expect(first.size).toBe(1);

    fs.rmSync(ws, { recursive: true, force: true });
    registry.prune();
    expect(registry.list()).toEqual([]);

    // Recreated (empty) at the same path: must not be served the old index.
    mkWorkspace(env.root);
    const root2 = registry.register(ws);
    const second = await models.ready(root2);
    expect(second).not.toBe(first);
    expect(second.size).toBe(0);
    models.disposeAll();
  });
});
