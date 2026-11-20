---
kind: ticket
title: Backlog md schema
status: resolved
type: research
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/01-backlog-md-schema.md
---

## Question

What exactly is the on-disk format of backlog.md (by MrLesk)? Cover the directory layout (tasks, drafts, completed, archive, decisions, docs, milestones), the YAML frontmatter fields and their types, the acceptance-criteria and implementation-plan/notes markers, task ID and filename conventions, and how dependencies and labels are represented. The goal is to know what an import must read. Use primary sources: the repo, its docs, and its source.

## Answer

Full notes: `.scratch/tasklogmd/research/01-backlog-md-schema.md` on branch `research/backlog-md-schema` (never merged). Source of truth is the backlog.md source at commit `53f8ffe` (v1.55.3), since no formal schema exists.

- Layout: `backlog/` with `tasks/`, `drafts/`, `archive/{tasks,drafts,milestones,docs,decisions}/`, legacy `completed/`, plus `milestones/`, `docs/`, `decisions/` and `config.yml`. Filenames: `<lowercase-id> - <Sanitized-Title>.md`.
- Frontmatter: `id` (uppercase, configurable prefix, subtasks like `BACK-743.1`), `title`, `status`, `assignee[]`, `created_date`, `labels[]`, `dependencies[]`, plus milestone, priority, type, `parent_task_id`, `ordinal`, `references`. Unknown keys are preserved.
- Body: `<!-- SECTION:X:BEGIN/END -->` sentinels; ACs in `<!-- AC:BEGIN/END -->` as `- [ ] #N text`; PLAN and NOTES sentinels; older header-only files are still accepted.
- Import gotchas: dependencies are ID lists that may use an old prefix, so resolve by numeric ID across active and archived tasks; a task is blocked if any dependency is unfinished or missing; "done" is the last entry in `statuses`, not a file move; labels map to tags.
- Open: the globs that find task files after a prefix change were not traced. The importer needs a fixture test for it.
