import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeDaemon } from '../../src/client.ts';
import { EXIT, runCommand } from '../../src/commands.ts';
import { runImport, type ImportReport } from '../../src/import/import.ts';
import { parseItem } from '../../src/model/parse.ts';
import { dataPaths } from '../../src/paths.ts';
import { rmDir, tmpDir } from '../helpers.ts';
import { copyImportFixture, FIXED_MTIME, IMPORT_FIXTURES, readTree } from '../import-helpers.ts';

let tmp: string;
beforeEach(() => {
  tmp = tmpDir('tasklog-import-');
});
afterEach(() => rmDir(tmp));

const golden = (name: string) => readTree(path.join(IMPORT_FIXTURES, `${name}.golden`, '.tasklog'));
const sourceTree = (ws: string) => {
  const t = readTree(ws);
  return Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('.tasklog/')));
};
const read = (ws: string, rel: string) => fs.readFileSync(path.join(ws, '.tasklog', rel), 'utf8');
const imp = (ws: string, extra: Partial<Parameters<typeof runImport>[0]> = {}): ImportReport => runImport({ path: ws, cwd: tmp, ...extra });

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, FIXED_MTIME, FIXED_MTIME);
}

describe('scratch layout', () => {
  it('imports the wayfinder effort to exactly the golden tree and never touches the source', () => {
    const ws = copyImportFixture('scratch', tmp);
    const before = sourceTree(ws);
    const rep = imp(ws);
    expect(rep.skipped).toEqual([]);
    expect(rep.imported).toHaveLength(18);
    expect(readTree(path.join(ws, '.tasklog'))).toEqual(golden('scratch'));
    expect(sourceTree(ws)).toEqual(before);
  });

  it('rewrites issues/ links to tickets/ and sets imported_from on every item', () => {
    const ws = copyImportFixture('scratch', tmp);
    imp(ws);
    const map = read(ws, 'tasklogmd/map.md');
    expect(map).toContain('](tickets/01-backlog-md-schema.md)');
    expect(map).not.toContain('](issues/');
    for (const [file, text] of Object.entries(readTree(path.join(ws, '.tasklog')))) {
      const r = parseItem(text);
      expect(r.ok, file).toBe(true);
      if (r.ok) expect(r.extra.imported_from, file).toMatch(/^\.scratch\/tasklogmd\/(map|spec|issues\/\d+-.*)\.md$/);
    }
  });

  it('maps statuses, triage roles, types, blockers and titles', () => {
    const ws = path.join(tmp, 'syn');
    const e = path.join(ws, '.scratch', 'eff');
    writeFile(path.join(e, 'map.md'), 'Label: wayfinder:map\n\n# My map\n\n## Destination\n\nGo.\n');
    writeFile(path.join(e, 'issues', '01-open-one.md'), 'Type: research\nStatus: needs-triage\nBlocked by:\n\n## Question\n\nQ1\n');
    writeFile(path.join(e, 'issues', '02-claimed-one.md'), 'Type: prototype\nStatus: claimed\nBlocked by: 01\n\n## Question\n\nQ2\n');
    writeFile(path.join(e, 'issues', '03-no-fix.md'), 'Status: wontfix\nBlocked by: 01, 02, 99\n\n## Question\n\nQ3\n\n## Comments\n\nkept\n');
    writeFile(path.join(e, 'issues', '04-ready.md'), 'Type: weird\nStatus: ready-for-agent\n\n## Question\n\nQ4\n\n## Acceptance criteria\n\n- [ ] first\n- [x] #5 second\n- [ ] third\n');
    writeFile(path.join(e, 'issues', '05-res.md'), 'Status: resolved\n\n# 5: Resolved title\n\nBare question text.\n\n## Answer\n\nA\n');
    const rep = imp(ws);
    expect(rep.skipped).toEqual([]);
    const get = (n: string) => {
      const r = parseItem(read(ws, `eff/tickets/${n}`));
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    const t1 = get('01-open-one.md');
    expect([t1.fields.status, t1.fields.type, t1.fields.tags]).toEqual(['open', 'research', ['needs-triage']]);
    const t2 = get('02-claimed-one.md');
    expect([t2.fields.status, t2.fields.claimedBy, t2.fields.blockedBy]).toEqual(['claimed', 'imported', [1]]);
    const t3 = get('03-no-fix.md');
    expect([t3.fields.status, t3.fields.tags, t3.fields.blockedBy]).toEqual(['closed', ['wontfix'], [1, 2]]);
    expect(t3.body).toContain('## Comments');
    expect(rep.warnings.some((w) => w.kind === 'dropped_dependency' && w.message.includes('"99"'))).toBe(true);
    const t4 = get('04-ready.md');
    expect(t4.fields.type).toBeUndefined();
    expect(t4.fields.tags).toEqual(['ready-for-agent']);
    expect(t4.acs.map((a) => a.n)).toEqual([6, 5, 7]);
    const t5 = get('05-res.md');
    expect([t5.fields.title, t5.fields.status]).toEqual(['Resolved title', 'resolved']);
    expect(t5.sections.map((s) => s.heading)).toEqual(['Question', 'Answer']);
    const map = parseItem(read(ws, 'eff/map.md'));
    expect(map.ok && [map.fields.kind, map.fields.title]).toEqual(['map', 'My map']);
    expect(fs.existsSync(path.join(e, 'issues', '01-open-one.md'))).toBe(true);
  });
});

describe('backlog layout', () => {
  it('imports to exactly the golden tree and never touches the source', () => {
    const ws = copyImportFixture('backlog', tmp);
    const before = sourceTree(ws);
    const rep = imp(ws);
    expect(rep.skipped).toEqual([]);
    expect(readTree(path.join(ws, '.tasklog'))).toEqual(golden('backlog'));
    expect(sourceTree(ws)).toEqual(before);
  });

  it('turns milestones into efforts, drops prefixes, and gives subtasks fresh numbers with parent tags', () => {
    const ws = copyImportFixture('backlog', tmp);
    const rep = imp(ws);
    expect(rep.efforts).toEqual(['backlog', 'beta-program', 'v2-launch']);
    const ids = rep.imported.map((i) => i.id);
    expect(ids).toContain('v2-launch/02'); // BACK-2 in milestone "v2-launch"
    expect(ids).toContain('v2-launch/03'); // milestone "m-1", named through milestones/m-1 - v2-launch.md
    expect(ids).toContain('beta-program/06');
    expect(ids).toContain('backlog/01'); // unmilestoned
    const sub1 = parseItem(read(ws, 'backlog/tickets/11-first-subtask.md'));
    const sub2 = parseItem(read(ws, 'backlog/tickets/12-second-subtask.md'));
    if (!sub1.ok || !sub2.ok) throw new Error('subtask did not parse');
    expect(sub1.fields.tags).toContain('parent-7');
    expect(sub2.fields.tags).toContain('parent-7');
    expect(sub2.fields.blockedBy).toEqual([11]);
    expect(rep.imported.find((i) => i.source.endsWith('back-7.1 - First subtask.md'))!.id).toBe('backlog/11');
  });

  it('resolves dependencies by numeric ID across efforts and archive, and reports unresolvable ones', () => {
    const ws = copyImportFixture('backlog', tmp);
    const rep = imp(ws);
    const ship = parseItem(read(ws, 'v2-launch/tickets/03-ship-release.md'));
    if (!ship.ok) throw new Error(ship.error);
    // BACK-2 (same effort), TASK-5 (old prefix, renumbered to 6); BACK-99 does not exist.
    expect(ship.fields.blockedBy).toEqual([2, 6]);
    const beta = parseItem(read(ws, 'beta-program/tickets/06-collect-beta-feedback.md'));
    if (!beta.ok) throw new Error(beta.error);
    expect(beta.fields.blockedBy).toEqual(['v2-launch/03', 'backlog/01']);
    const parent = parseItem(read(ws, 'backlog/tickets/07-parent-task.md'));
    if (!parent.ok) throw new Error(parent.error);
    expect(parent.fields.blockedBy).toEqual([8]); // BACK-8 lives in archive/
    const drop = rep.warnings.filter((w) => w.kind === 'dropped_dependency');
    expect(drop).toHaveLength(1);
    expect(drop[0]!.message).toContain('BACK-99');
  });

  it('gives the second of two tasks sharing a numeric ID the next free number and flags it', () => {
    const ws = copyImportFixture('backlog', tmp);
    const rep = imp(ws);
    expect(rep.imported.find((i) => i.source.endsWith('back-5 - Write docs.md'))!.id).toBe('v2-launch/05');
    expect(rep.imported.find((i) => i.source.endsWith('task-5 - Old prefix cleanup.md'))!.id).toBe('v2-launch/06');
    const flags = rep.warnings.filter((w) => w.kind === 'id_collision');
    expect(flags.map((w) => w.source)).toContain('backlog/tasks/task-5 - Old prefix cleanup.md');
  });

  it('maps statuses: first/middle/last, drafts, archive, completed, labels, priority', () => {
    const ws = copyImportFixture('backlog', tmp);
    imp(ws);
    const f = (rel: string) => {
      const r = parseItem(read(ws, rel));
      if (!r.ok) throw new Error(r.error);
      return r.fields;
    };
    expect(f('backlog/tickets/01-set-up-project.md')).toMatchObject({ status: 'open', tags: ['infra'] });
    expect(f('v2-launch/tickets/02-design-landing-page-hero.md')).toMatchObject({
      status: 'claimed',
      claimedBy: '@alice',
      tags: ['design', 'ui-polish', 'in-progress', 'priority-high'],
    });
    expect(f('v2-launch/tickets/06-old-prefix-cleanup.md')).toMatchObject({ status: 'claimed', claimedBy: 'imported', tags: ['cleanup', 'review'] });
    expect(f('v2-launch/tickets/03-ship-release.md').status).toBe('resolved');
    expect(f('backlog/tickets/10-maybe-a-mobile-app.md')).toMatchObject({ status: 'open', tags: ['idea', 'draft'] });
    expect(f('backlog/tickets/08-abandoned-experiment.md')).toMatchObject({ status: 'closed', tags: ['spike', 'archived'] });
    expect(f('backlog/tickets/09-legacy-finished.md').status).toBe('resolved');
    const hero = parseItem(read(ws, 'v2-launch/tickets/02-design-landing-page-hero.md'));
    if (!hero.ok) throw new Error(hero.error);
    expect(hero.extra).toMatchObject({ priority: 'high', backlog_type: 'bug', ordinal: 1000 });
    expect(hero.sections.map((s) => s.heading)).toEqual(['Question', 'Acceptance criteria', 'Implementation plan', 'Implementation notes']);
    expect(hero.body).not.toContain('<!--');
    expect(hero.fields.created).toBe('2025-02-01');
  });

  it('does not miss task files after a prefix change, and lists docs, decisions and milestones as not imported', () => {
    const ws = copyImportFixture('backlog', tmp);
    const rep = imp(ws);
    const taskFiles = ['tasks', 'drafts', 'completed', 'archive/tasks'].flatMap((d) => fs.readdirSync(path.join(ws, 'backlog', d)).map((n) => `backlog/${d}/${n}`));
    expect(taskFiles.length).toBeGreaterThan(rep.efforts.length);
    expect(rep.imported.map((i) => i.source).sort()).toEqual(taskFiles.sort());
    expect(rep.imported.some((i) => i.source.includes('task-5'))).toBe(true);
    expect(rep.imported.some((i) => i.source.includes('back-5'))).toBe(true);
    expect(rep.not_imported.map((n) => n.path).sort()).toEqual([
      'backlog/decisions/decision-1 - Use markdown.md',
      'backlog/docs/doc-1 - Guide.md',
      'backlog/milestones/m-1 - v2-launch.md',
    ]);
  });

  it('--group-by none and --effort put everything in one effort, renumbering collisions', () => {
    const ws = copyImportFixture('backlog', tmp);
    const none = imp(ws, { groupBy: 'none', dryRun: true });
    expect(none.efforts).toEqual(['backlog']);
    expect(none.imported).toHaveLength(12);
    expect(new Set(none.imported.map((i) => i.id)).size).toBe(12);
    const forced = imp(ws, { effort: 'everything' });
    expect(forced.efforts).toEqual(['everything']);
    expect(fs.readdirSync(path.join(ws, '.tasklog'))).toEqual(['everything']);
    expect(forced.warnings.some((w) => w.kind === 'id_collision')).toBe(true);
  });
});

describe('staging, failures and re-runs', () => {
  it('skips a file that fails to parse, reports it, imports the rest, and exits 1 through the CLI', async () => {
    const ws = copyImportFixture('backlog', tmp);
    writeFile(path.join(ws, 'backlog', 'tasks', 'back-20 - Broken.md'), 'no frontmatter here\n');
    writeFile(path.join(ws, 'backlog', 'tasks', 'back-21 - Unclosed.md'), '---\nid: BACK-21\ntitle: x\n');
    const rep = imp(ws, { dryRun: true });
    expect(rep.skipped.map((s) => s.source).sort()).toEqual(['backlog/tasks/back-20 - Broken.md', 'backlog/tasks/back-21 - Unclosed.md']);
    expect(rep.skipped[0]!.reason).toMatch(/frontmatter/);
    expect(rep.imported).toHaveLength(12);

    let out = '';
    const code = await runCommand(['import', ws, '--json'], { stdout: (s) => (out += s), stderr: () => {}, cwd: tmp, paths: dataPaths(path.join(tmp, 'data')) });
    expect(code).toBe(EXIT.failed);
    expect(JSON.parse(out).skipped).toHaveLength(2);
    expect(fs.existsSync(path.join(ws, '.tasklog', 'v2-launch', 'tickets', '02-design-landing-page-hero.md'))).toBe(true);
  });

  it('leaves no half-written efforts when the move fails', () => {
    const ws = copyImportFixture('backlog', tmp);
    // `v2-launch` exists as a plain file, so moving that effort in fails after other efforts were moved.
    fs.mkdirSync(path.join(ws, '.tasklog'));
    fs.writeFileSync(path.join(ws, '.tasklog', 'v2-launch'), 'in the way');
    expect(() => imp(ws)).toThrow();
    expect(fs.readdirSync(path.join(ws, '.tasklog'))).toEqual(['v2-launch']);
  });

  it('is idempotent: re-runs skip imported items untouched, keep hand edits, and add new source files', () => {
    const ws = copyImportFixture('backlog', tmp);
    imp(ws);
    const edited = path.join(ws, '.tasklog', 'v2-launch', 'tickets', '05-write-docs.md');
    fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8') + '\nhand edit\n');
    const treeAfterFirst = readTree(path.join(ws, '.tasklog'));

    const again = imp(ws);
    expect(again.imported).toEqual([]);
    expect(again.already_imported).toHaveLength(12);
    expect(readTree(path.join(ws, '.tasklog'))).toEqual(treeAfterFirst);

    writeFile(
      path.join(ws, 'backlog', 'tasks', 'back-30 - Brand new.md'),
      "---\nid: BACK-30\ntitle: Brand new\nstatus: To Do\nmilestone: v2-launch\ndependencies: [BACK-2, task-5]\ncreated_date: '2025-04-01 09:00'\n---\n\n## Description\n\nNew.\n",
    );
    const third = imp(ws);
    expect(third.imported.map((i) => i.id)).toEqual(['v2-launch/30']);
    expect(third.already_imported).toHaveLength(12);
    const added = parseItem(read(ws, 'v2-launch/tickets/30-brand-new.md'));
    if (!added.ok) throw new Error(added.error);
    expect(added.fields.blockedBy).toEqual([2, 6]); // resolved against items imported on the first run
    expect(fs.readFileSync(edited, 'utf8')).toContain('hand edit');
  });

  it('adds only missing items to an effort that has non-imported items, with a warning', () => {
    const ws = copyImportFixture('scratch', tmp);
    writeFile(
      path.join(ws, '.tasklog', 'tasklogmd', 'tickets', '03-mine.md'),
      '---\nkind: ticket\ntitle: Mine\nstatus: open\n---\n\n## Question\n\nHand-made.\n',
    );
    const rep = imp(ws);
    expect(rep.warnings.some((w) => w.kind === 'existing_effort')).toBe(true);
    expect(rep.warnings.some((w) => w.kind === 'id_collision')).toBe(true);
    expect(read(ws, 'tasklogmd/tickets/03-mine.md')).toContain('Hand-made.');
    expect(rep.imported).toHaveLength(18);
    expect(rep.warnings.some((w) => w.kind === 'not_overwritten')).toBe(false);
  });

  it('--dry-run reports the same imports but writes nothing', () => {
    const ws = copyImportFixture('scratch', tmp);
    const dry = imp(ws, { dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.imported).toHaveLength(18);
    expect(fs.existsSync(path.join(ws, '.tasklog'))).toBe(false);
    const real = imp(ws);
    expect(real.imported).toEqual(dry.imported);
  });

  it('--effort forces a scratch effort name', () => {
    const ws = copyImportFixture('scratch', tmp);
    const rep = imp(ws, { effort: 'moved' });
    expect(rep.efforts).toEqual(['moved']);
    expect(fs.existsSync(path.join(ws, '.tasklog', 'moved', 'map.md'))).toBe(true);
  });
});

describe('CLI', () => {
  const run = async (args: string[], cwd = tmp) => {
    let stdout = '';
    let stderr = '';
    const paths = dataPaths(path.join(tmp, 'data'));
    const code = await runCommand(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), cwd, paths });
    return { code, stdout, stderr, paths };
  };

  it('runs offline: --json is valid JSON, exit 0, and no daemon is started', async () => {
    const ws = copyImportFixture('scratch', tmp);
    const r = await run(['import', ws, '--json']);
    expect(r.code).toBe(EXIT.ok);
    const body = JSON.parse(r.stdout);
    expect(body.imported).toHaveLength(18);
    expect(body.layout).toBe('scratch');
    expect(await probeDaemon(r.paths)).toBeNull();
    expect(fs.existsSync(r.paths.daemonJson)).toBe(false);
  });

  it('prints a human report by default and resolves a relative path against the cwd', async () => {
    copyImportFixture('backlog', tmp);
    const r = await run(['import', 'backlog', '--dry-run']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/would import 12 item/);
    expect(r.stdout).toMatch(/BACK-99/);
  });

  it('exits 2 for usage errors', async () => {
    expect((await run(['import'])).code).toBe(EXIT.usage);
    expect((await run(['import', tmp, '--bogus'])).code).toBe(EXIT.usage);
    expect((await run(['import', tmp, '--group-by', 'week'])).code).toBe(EXIT.usage);
    expect((await run(['import', tmp, '--effort', 'Bad Name'])).code).toBe(EXIT.usage);
    const none = await run(['import', tmp]);
    expect(none.code).toBe(EXIT.usage);
    expect(none.stderr).toMatch(/no backlog layout/);
  });
});
