import { describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../../src/model/index.ts';
import { ParsedItemStore } from '../../src/model/store.ts';
import { computeFrontier } from '../../src/model/workflow.ts';
import { createLogger } from '../../src/log.ts';

const log = createLogger({ level: 'error' });
const file = (kind: string, title: string) => Buffer.from(`---\nkind: ${kind}\ntitle: ${title}\nstatus: open\n---\n\n## Question\n\nq\n`);

describe('path/kind agreement', () => {
  it('flags a file whose frontmatter kind disagrees with its location as invalid, and keeps it out of the frontier', () => {
    const idx = new WorkspaceIndex('/ws', new ParsedItemStore(), { log });
    idx.upsertFile('.tasklog/e/tickets/01-ok.md', file('ticket', 'Fine'));
    idx.upsertFile('.tasklog/e/tickets/02-spec.md', file('spec', 'Wrong kind'));
    idx.upsertFile('.tasklog/e/map.md', file('ticket', 'Map that says ticket'));

    const problems = idx.problems();
    expect(problems.map((p) => p.id).sort()).toEqual(['e/02', 'e/map']);
    expect(problems[0]!.error).toMatch(/kind/);
    expect(idx.counts().invalid).toBe(2);
    expect(() => idx.get('e/02')).toThrowError(/does not parse|kind/);

    const f = computeFrontier(idx, 'e', { now: Date.now() });
    expect(f.ready.map((t) => t.id)).toEqual(['e/01']);
  });

  it('a file that agrees with its location stays valid', () => {
    const idx = new WorkspaceIndex('/ws', new ParsedItemStore(), { log });
    idx.upsertFile('.tasklog/e/map.md', file('map', 'M'));
    idx.upsertFile('.tasklog/e/spec.md', file('spec', 'S'));
    expect(idx.problems()).toEqual([]);
  });
});
