# 13: Import

**What to build:** A repo on the backlog layout or scratch layout can move to the native format: `tasklog import <path>` converts it into `.tasklog/`, leaving the originals untouched. Spec reference: `.scratch/tasklogmd/spec.md`, section 9 (the full mapping), plus the fixture notes in section 12.

**Blocked by:** 05 Parser, scan and read tools

**Status:** ready-for-agent

- [x] Given the scratch fixture (a copy of the wayfinder effort in this repo), when imported, then the output equals the checked-in golden tree, `issues/` links are rewritten to `tickets/`, and `imported_from` is set on every item.
- [x] Given the backlog fixture, when imported, then milestones become efforts (unmilestoned tasks go to `backlog`), prefixes are dropped and numbers kept, and subtasks get fresh numbers with `parent-NNN` tags.
- [x] Given dependencies, when resolved, then they resolve by numeric ID across active and archived tasks and across efforts; unresolvable ones are dropped from `blocked_by` and listed in the report.
- [x] Given two backlog tasks sharing a numeric ID in one effort, when imported, then the second gets the next free number and the report flags it.
- [x] Given status mappings (triage roles, `wontfix`, middle statuses, drafts, archive, completed), when imported, then each maps as the spec states, with original status names kept as tags where specified.
- [x] Given a file that fails to parse, when imported, then it is skipped and reported, the rest completes in one staged move so no half-written efforts exist, and the exit code is 1.
- [x] Given a second run, when imported again, then already-imported items are skipped untouched and hand edits survive; new source files are added.
- [x] Given `--dry-run`, `--effort` and `--group-by none`, when run, then dry-run writes nothing and the other two behave as specified.
- [x] Given a prefix change in the backlog fixture, when task files are located, then none are missed.
- [x] Import runs in-process with no daemon and never modifies the source tree.

## Comments

Implemented on branch `t3/ticket-13-import-fixtures`.

**CLI.** `tasklog import <path> [--dry-run] [--json] [--effort <name>] [--group-by none|milestone]` is wired in `src/commands.ts` (spec entry, usage text, `case 'import'`). It runs in-process and never contacts or starts a daemon. Exit codes: 0 ok, 1 when any source file was skipped (or the move failed), 2 for usage errors (missing path, unknown flag, bad `--group-by` or `--effort` value, or no backlog/scratch layout found at the path). `--json` prints the full report object on stdout.

**Public module (`src/import/`).** `runImport({path, cwd, dryRun?, effort?, groupBy?}) -> ImportReport` and `formatReport(report)` in `import.ts`; `detectSources(path)`. Report: `{layout, workspace, dry_run, efforts, imported[{source,id,path}], already_imported[{source,id}], skipped[{source,reason}], not_imported[{path,reason}], warnings[{kind,source,message}]}`. Loaders: `scratch.ts`, `backlog.ts` (both return `LoadResult`), `yaml.ts` (small frontmatter reader used only for backlog sources), `types.ts`. Output files are validated with the real `parseItem` before staging; a file that does not parse is skipped.

**Path detection.** `<path>` may be a workspace root (imports `backlog/` if it has `config.yml`, and `.scratch/` if present, both when both exist), the `backlog/` dir, the `.scratch/` dir, or a single `.scratch/<effort>` dir. `.tasklog/` goes in the workspace root (the parent of `backlog/` or `.scratch/`). Staging is `.tasklog/.import-<pid>-<rand>/` (dot dirs are ignored by the model), moved in with renames; an effort dir that does not exist yet moves whole, otherwise only missing files move. A failed move rolls back and leaves no staging dir.

**Decisions and small deviations.**
- `not_imported[]` (backlog `docs/`, `decisions/`, `milestones/`) is separate from `skipped[]`; only `skipped[]` (unparseable files) makes the exit code 1.
- Scratch tickets have no title field, so the title is the `# H1` if present (a leading `NN:` is stripped), else the filename slug with the first letter capitalised. Scratch `created` and `updated` are both the file mtime (UTC date). Backlog `created` is the date part of `created_date`; `updated` is `updated_date` or else `created_date`.
- Scratch dialect tolerance: `**Status:**`-style bold header lines, a `# NN: Title` heading, and tickets without `## Question` (the preamble becomes the Question section). Unnumbered ACs in `## Acceptance criteria` get the next free `#N`. An unknown scratch `Type:` is dropped with a warning; a `claimed` scratch ticket gets `claimed_by: imported`.
- Backlog `type:` is carried as `backlog_type` (a verbatim `type: bug` would be an invalid native `type`); other native-reserved keys get the same `backlog_` prefix. `assignee` is carried verbatim when non-empty, and `priority`, `references`, `ordinal` and any other unknown key verbatim. `milestone`, `parent_task_id`, `dependencies`, `labels`, `id`, `status` and the dates are consumed. A backlog `FINAL_SUMMARY` section becomes `## Final summary` (not in the spec; it avoids dropping content).
- Milestones are named by slug; a milestone id (`m-1`) is mapped to its title through `backlog/milestones/*.md`. Subtasks use their own milestone, else the parent's, else `backlog`. Numbering: free requested numbers are claimed first (tasks, completed, archive, drafts in that order, then by number), then collisions and subtasks take max+1, collisions first.
- Dependency matching: exact source ID first, then numeric ID; a numeric match that hits more than one task and cannot be narrowed to the same effort is dropped with an `ambiguous_dependency` warning.
- Idempotency keys on `imported_from`; items imported earlier keep their number, so dependencies from new items to old ones resolve. An existing `map.md`/`spec.md` that is not from this source is never overwritten (warning).

**Fixtures** (`test/fixtures/import/`): `scratch/` is a byte copy of this repo's `.scratch/tasklogmd` (CRLF as checked out); `backlog/` is hand-built (prefix change `task-`/`back-`, milestones by name and by id, subtasks, draft, archive, legacy `completed/`, an unresolvable dependency, docs/decisions/milestones). Goldens are `scratch.golden/.tasklog` and `backlog.golden/.tasklog`. Regenerate after an intentional importer change with `node scripts/update-import-goldens.ts` and review the diff. Tests pin source mtimes (`test/import-helpers.ts`) so scratch dates are reproducible. `.gitattributes` already marks `test/fixtures/**` as `-text`.

**Tests.** `test/integration/import.test.ts` (19 tests, in-process, no daemon): goldens, link rewrite, status mappings, dependency resolution, collisions, prefix change, `--dry-run`, `--effort`, `--group-by none`, skipped file with exit 1, rollback on a failed move, idempotent re-run with hand edit, and CLI exit codes. Full suite (131 tests) and typecheck pass.
