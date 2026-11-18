import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runImport } from '../../src/import/import.ts';
import { parseItem } from '../../src/model/parse.ts';
import { rmDir, tmpDir } from '../helpers.ts';

let tmp: string;
beforeEach(() => {
  tmp = tmpDir('tasklog-import-wf-');
});
afterEach(() => rmDir(tmp));

function put(rel: string, text: string): void {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const read = (rel: string) => fs.readFileSync(path.join(tmp, '.tasklog', rel), 'utf8');

function layout(): void {
  put('backlog/config.yml', 'project_name: "X"\nstatuses: ["To Do", "In Progress", "Done"]\ntask_prefix: "task"\n');
  put('backlog/milestones/m-0 - engine-build-plan.md', '---\nid: m-0\ntitle: "Engine build plan"\n---\n\n## Description\n\nx\n');
  put(
    'backlog/docs/doc-1 - Engine-build-plan-map.md',
    [
      '---',
      'id: doc-1',
      'title: Engine build plan map',
      'type: other',
      "created_date: '2026-05-01 10:00'",
      'tags:',
      '  - wayfinder:map',
      '---',
      '',
      '## Destination',
      '',
      'Ship the engine.',
      '',
      '## Decisions so far',
      '',
      '- [Pick a language](task-1): TypeScript',
      '- [Spike](TASK-2): later',
      '',
    ].join('\n'),
  );
  put('backlog/docs/doc-2 - Other notes.md', '---\nid: doc-2\ntitle: Other notes\n---\n\nrandom\n');
  put(
    'backlog/tasks/task-1 - Pick a language.md',
    [
      '---',
      'id: TASK-1',
      'title: Pick a language',
      'status: Done',
      'milestone: m-0',
      'labels:',
      '  - wayfinder-grilling',
      '  - infra',
      '---',
      '',
      '## Description',
      '',
      'Which language?',
      '',
      '## Implementation Notes',
      '',
      'TypeScript, because.',
      '',
    ].join('\n'),
  );
  put(
    'backlog/tasks/task-2 - Spike.md',
    ['---', 'id: TASK-2', 'title: Spike', 'status: To Do', 'milestone: m-0', 'labels: [wayfinder-research]', '---', '', '## Question', '', 'Does X work?', '', '## Resolution', '', 'n/a', ''].join('\n'),
  );
  put('backlog/tasks/task-3 - No body.md', ['---', 'id: TASK-3', 'title: No body', 'status: To Do', 'milestone: m-0', '---', ''].join('\n'));
}

describe('backlog wayfinder documents', () => {
  it('imports the doc tagged wayfinder:map as <effort>/map with task links rewritten to ticket paths', () => {
    layout();
    const rep = runImport({ path: tmp, cwd: tmp });
    expect(rep.skipped).toEqual([]);
    expect(rep.efforts).toEqual(['engine-build-plan']);
    const map = rep.imported.find((i) => i.id === 'engine-build-plan/map');
    expect(map).toMatchObject({ source: 'backlog/docs/doc-1 - Engine-build-plan-map.md', path: '.tasklog/engine-build-plan/map.md' });
    const text = read('engine-build-plan/map.md');
    const p = parseItem(text);
    expect(p.ok && p.fields.kind).toBe('map');
    expect(text).toContain('](tickets/01-pick-a-language.md)');
    expect(text).toContain('](tickets/02-spike.md)');
    expect(text).not.toMatch(/\]\(task-/i);
    expect(text).toMatch(/^imported_from: .*doc-1 - Engine-build-plan-map.md/m);
  });

  it('reports untagged docs as not imported and no longer lists the map doc there', () => {
    layout();
    const rep = runImport({ path: tmp, cwd: tmp });
    const paths = rep.not_imported.map((n) => n.path);
    expect(paths).toContain('backlog/docs/doc-2 - Other notes.md');
    expect(paths).not.toContain('backlog/docs/doc-1 - Engine-build-plan-map.md');
  });

  it('moves wayfinder-<type> labels to the type field and drops them from tags', () => {
    layout();
    runImport({ path: tmp, cwd: tmp });
    const t1 = parseItem(read('engine-build-plan/tickets/01-pick-a-language.md'));
    const t2 = parseItem(read('engine-build-plan/tickets/02-spike.md'));
    if (!t1.ok || !t2.ok) throw new Error('did not parse');
    expect(t1.fields.type).toBe('grilling');
    expect(t1.fields.tags).toEqual(['infra']);
    expect(t2.fields.type).toBe('research');
    expect(t2.fields.tags).toEqual([]);
  });

  it('has no duplicate Question section, and no placeholder when a literal ## Question exists', () => {
    layout();
    runImport({ path: tmp, cwd: tmp });
    const t2 = read('engine-build-plan/tickets/02-spike.md');
    expect(t2.match(/^## Question$/gm)).toHaveLength(1);
    expect(t2).toContain('Does X work?');
    expect(t2).not.toContain('Imported from backlog.md without a description');
  });

  it('writes implementation notes of a done task, and a ## Resolution section, to ## Answer', () => {
    layout();
    runImport({ path: tmp, cwd: tmp });
    const t1 = read('engine-build-plan/tickets/01-pick-a-language.md');
    expect(t1).toMatch(/^## Answer\n\nTypeScript, because\.$/m);
    expect(t1).not.toContain('## Implementation notes');
    const t2 = read('engine-build-plan/tickets/02-spike.md');
    expect(t2).toMatch(/^## Answer\n\nn\/a$/m);
  });

  it('is idempotent on a second run', () => {
    layout();
    runImport({ path: tmp, cwd: tmp });
    const before = read('engine-build-plan/map.md');
    const again = runImport({ path: tmp, cwd: tmp });
    expect(again.imported).toEqual([]);
    expect(again.already_imported.some((a) => a.id === 'engine-build-plan/map')).toBe(true);
    expect(read('engine-build-plan/map.md')).toBe(before);
  });

  it('warns instead of staying silent when a map doc cannot be matched to an effort', () => {
    layout();
    put('backlog/tasks/task-4 - Elsewhere.md', ['---', 'id: TASK-4', 'title: Elsewhere', 'status: To Do', '---', ''].join('\n'));
    put('backlog/milestones/m-1 - second.md', '---\nid: m-1\ntitle: "Second"\n---\n');
    put('backlog/tasks/task-5 - Other.md', ['---', 'id: TASK-5', 'title: Other', 'status: To Do', 'milestone: m-1', '---', ''].join('\n'));
    fs.rmSync(path.join(tmp, 'backlog/docs/doc-1 - Engine-build-plan-map.md'));
    put('backlog/docs/doc-1 - Unrelated.md', '---\nid: doc-1\ntitle: Unrelated\ntags: [wayfinder:map]\n---\n\n## Destination\n\nx\n');
    const rep = runImport({ path: tmp, cwd: tmp });
    expect(rep.imported.some((i) => i.id.endsWith('/map'))).toBe(false);
    expect(rep.warnings.some((w) => w.source === 'backlog/docs/doc-1 - Unrelated.md')).toBe(true);
  });
});
