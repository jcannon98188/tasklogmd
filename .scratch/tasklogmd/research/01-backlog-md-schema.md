# Research: backlog.md on-disk format

Ticket: `.scratch/tasklogmd/issues/01-backlog-md-schema.md`

**Scope**: what a one-shot TaskLog import must read from a Backlog.md (MrLesk) project.

**Method**: shallow clone of https://github.com/MrLesk/Backlog.md at commit `53f8ffe7150e521a3002326f213f3611b11192b3` (package version 1.55.3), reading source and the project's own `backlog/` directory (it dogfoods the format). Paths below are relative to that repo. Claims marked *(inferred)* come from sample files, not from a normative spec. Backlog.md has no formal schema document; **the source is the spec**.

## 1. Directory layout

Source: `src/constants/index.ts` (`DEFAULT_DIRECTORIES`, `ARCHIVED_TASK_DIRECTORIES`, `DEFAULT_FILES`).

Root is `backlog/` by default (also `.backlog/`, or a custom folder named by `backlog.config.yml` at the project root).

| Path under root | Content |
|---|---|
| `config.yml` (or `config.yaml`) | Project config (see §8). Root-level `backlog.config.yml` is an alternate location. |
| `tasks/` | Active tasks, flat. |
| `drafts/` | Draft tasks, `draft-N` IDs. |
| `archive/tasks/`, `archive/drafts/`, `archive/milestones/`, `archive/docs/`, `archive/decisions/` | Archived items. |
| `completed/` | **Legacy** archive location for tasks. The reader still reads it as archived tasks until `backlog doctor --fix` moves them. The repo's own `backlog/completed/` holds tasks. |
| `milestones/` | `m-N - <title>.md` |
| `docs/` | `doc-NNN - <Title>.md`. Docs keep their relative subpath, which is also preserved under `archive/docs/`. Subfolders are scanned (`operations.ts` ~1770). |
| `decisions/` | `decision-N - <Title>.md`, flat. |
| `readme.md` | Ignored by the loaders in each directory. |
| `.locks/` | Runtime locks. Ignore. |

Other runtime directories (`assets/`, locks) are not part of the data model.

## 2. Task filename and ID conventions

Sources: `src/file-system/operations.ts` (`resolveTaskWriteTarget` ~895, `sanitizeFilename` ~2298), `src/utils/prefix-config.ts`.

- Filename: `<id lowercased> - <sanitized title>.md`, for example `back-200 - Add-Claude-Code-integration-with-workflow-commands-during-init.md`.
- Sanitization:
  - `<>:"/\|?*` become `-`.
  - `'(),!@#$%^&+=[]{};` are removed.
  - Whitespace becomes `-`, repeated `-` are collapsed, and leading and trailing `-` are trimmed.
  - An empty result becomes `untitled`.
- The filename is lossy. **The filename ID and the frontmatter `id` must agree** (loosely: leading zeros are ignored). Drafts throw `DraftIdentityError` if they disagree.
- ID in frontmatter is **uppercase**: `BACK-200`. `normalizeId` uppercases both prefix and body. The filename is lowercase.
- Prefix:
  - It is configurable via `task_prefix` in `config.yml` (`prefixes.task` in the typed config). The default is `task`.
  - It must be letters only (`/^[a-zA-Z]+$/`).
  - `draft`, `doc` and `decision` are reserved.
  - The draft prefix is always `draft`.
  - Doc prefix is `doc` and decision prefix is `decision`.
- Numbering:
  - The next ID is max+1 across local files and, by default, other branches/remote.
  - `zero_padded_ids` / `zeroPaddedIds` pads the number: `doc-001`.
  - Old IDs may keep an older prefix. The repo's `BACK-200` depends on `task-24.1` and `task-208`, so **dependency targets can use a different prefix from the current one**. An importer must resolve IDs by numeric body, not just exact string.
- Subtasks: dotted IDs (`BACK-743.1`, `back-100.1`). The ID number is `extractIdNumbers` → `[743, 1]`. There is no separate directory; subtasks sit flat in `tasks/`. Their frontmatter carries `parent_task_id: BACK-743`. The parent may carry a `subtasks:` list.
- Milestone IDs: `m-N`, starting at **0**, and they are max+1 over active and archived files. Filename is `m-N - <title>.md` (`buildMilestoneFilename`). A task's `milestone:` value may be an ID, a bare number, or a title; resolution is alias-based (`src/utils/milestone-storage.ts`: `5`, `m-5` and the title all match).

## 3. Task frontmatter

Source: `serializeTask` in `src/markdown/serializer.ts` (write order) and `parseTask` in `src/markdown/parser.ts` (read semantics). Parsing is by `gray-matter` (YAML) after a preprocessing pass (`src/markdown/frontmatter.ts`).

The write order, with omit rules, is as follows. "Always" means always written.

| Key | Type | Written | Notes |
|---|---|---|---|
| `id` | string | always | `BACK-200`, `BACK-743.1`. |
| `title` | string | always | |
| `status` | string | always | Free string drawn from config `statuses`. Default `To Do` / `In Progress` / `Done`. Terminal status is the **last entry in `statuses`**, compared case-insensitively (`src/utils/terminal-status.ts`). |
| `assignee` | string[] | always | Scalar is accepted and wrapped. Values often start with `@`. The preprocessor quotes bare `@x` scalars (YAML-reserved char). |
| `reporter` | string | optional | |
| `created_date` | string | always | `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, or ISO `…T…Z`. Legacy `dd-mm-yy`, `dd/mm/yy` and `dd.mm.yy` forms are normalized on read. |
| `updated_date` | string | optional | Same forms. |
| `due_date` | string | optional | Forced to a string by the preprocessor. |
| `labels` | string[] | always | See §6. Non-array → `[]`. |
| `milestone` | string | optional | See §2. |
| `dependencies` | string[] | always | See §6. Nested lists or mappings **throw** `TaskDependenciesParseError`. |
| `references` | string[] | optional | URLs or paths. |
| `documentation` | string[] | optional | |
| `modified_files` | string[] | optional | |
| `parent_task_id` | string | optional | |
| `subtasks` | string[] | optional | |
| `priority` | string | optional | Normalized via config `priorities` (default High/Medium/Low, written lowercase in samples). |
| `type` | string | optional | Allowed values from config `types`. Default: bug, feature, enhancement, task, chore, docs, spike. |
| `project` | string | optional | Monorepo component, from config `projects`. |
| `ordinal` | number | optional | Board sort (sample: `400000`). |
| `onStatusChange` | string | optional | Note the camelCase. Per-task shell callback. |

- **Unknown frontmatter keys are preserved verbatim** on rewrite (`preserveUnknownFrontmatter`), including comments and YAML anchors. An importer should not assume the key set is closed.
- Unrecognized or missing fields degrade to empty values. Only `title`, `status`, etc. are coerced with `String()`.
- Sample file (from `backlog/tasks/back-200 …md`):

```yaml
---
id: BACK-200
title: Add Claude Code integration with workflow commands during init
status: To Do
assignee: []
created_date: '2025-07-23'
updated_date: '2025-09-06 21:22'
labels:
  - enhancement
  - developer-experience
dependencies:
  - task-24.1
  - task-208
priority: medium
---
```

## 4. Task body structure

Sources: `src/markdown/structured-sections.ts`, `src/markdown/section-titles.ts`.

Body is markdown with fixed `## ` section headers. Current writers wrap section bodies in HTML-comment sentinels; older files have **headers only** and are still accepted. An importer must handle both.

| Section | Header | Sentinels | Notes |
|---|---|---|---|
| Description | `## Description` | `<!-- SECTION:DESCRIPTION:BEGIN -->` … `<!-- SECTION:DESCRIPTION:END -->` | |
| Acceptance Criteria | `## Acceptance Criteria` | `<!-- AC:BEGIN -->` … `<!-- AC:END -->` | Checklist, see below. |
| Definition of Done | `## Definition of Done` | `<!-- DOD:BEGIN -->` … `<!-- DOD:END -->` | Same checklist shape. Defaults come from config `definition_of_done`. |
| Implementation Plan | `## Implementation Plan` | `<!-- SECTION:PLAN:BEGIN -->` … `:END -->` | |
| Implementation Notes | `## Implementation Notes` | `<!-- SECTION:NOTES:BEGIN -->` … `:END -->` | |
| Final Summary | `## Final Summary` | `<!-- SECTION:FINAL_SUMMARY:BEGIN -->` … `:END -->` | |
| Comments | `## Comments` | `<!-- COMMENTS:BEGIN -->` … `<!-- COMMENTS:END -->`, with per-comment `<!-- COMMENT:BEGIN/END -->` in the legacy form | New form is `---`-delimited entries with `author:` and date metadata lines (`formatCommentBlock`). |

Notes:
- Accepted title variants (`SECTION_TITLE_VARIANTS`):
  - `Acceptance Criteria (Optional)`
  - `Implementation Plan (Optional)`
  - `Implementation Notes (Optional)`, `Notes`, `Notes & Comments (Optional)`.
- Section sentinel lines match `^<!-- SECTION:[A-Z][A-Z0-9_]*:(BEGIN|END) -->$`.
- The parser is markdown-aware (mdast): fences and HTML blocks are respected, so marker-like lines inside code fences are content.
- Writers insert sections in the order Description → Plan → Notes → Final Summary. Checklists are placed separately.
- **Acceptance criteria item syntax**: `- [ ] #1 text` / `- [x] #1 text`. The `#N` is a 1-based index that is **renumbered** on every write (`parseAllCriteria` assigns `i + 1`). Legacy files may omit `#N` or the markers.
  - `[ ]` means unchecked and `[x]` means checked.
  - Invalid marks cause `assertValidChecklistMarks` to throw.
- Sample (`BACK-743.1`, real file):

```markdown
## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Viewing a missing document exits 1, …
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a real CLI regression …
<!-- SECTION:PLAN:END -->
```

- The parser returns a `rawContent` too (the body minus frontmatter, trimmed). Content outside known sections is preserved but not modelled.

## 5. Other entity types

Sources: `parseDecision`, `parseDocument`, `parseMilestone` in `src/markdown/parser.ts`, plus repo samples.

- **Milestone** (`m-N - <title>.md`): frontmatter `id` (`m-7`), `title`, optional `due_date`. Body is `## Description` (plain header, no sentinel in the sample). No status field; completion is derived from the milestone's tasks.
- **Decision** (`decision-N - <Title>.md`): frontmatter `id`, `title`, `date`, `status` (default `proposed`; the type is a string union), optional `updated_date`, `superseded_by`. Body sections: `## Context`, `## Decision`, `## Consequences`, `## Alternatives` (the latter optional). Sentinel markers `SECTION:CONTEXT|DECISION|CONSEQUENCES|ALTERNATIVES` also exist.
- **Document** (`doc-NNN - <Title>.md`): frontmatter `id`, `title`, `type` (free string, default `other`, sample `guide`), `created_date`, optional `updated_date`, `tags` (string[]). Body is free markdown.
- **Draft**: exactly a task whose ID prefix is `draft` and lives in `drafts/`. Promotion renames it to a task ID and moves it into `tasks/`.

## 6. Dependencies and labels

- **Dependencies**: `dependencies:` is a block (or flow) list of task-ID strings in frontmatter. There is no typed relation, only "this task depends on these". Readiness (`src/utils/readiness.ts`):
  - A task is *ready* when it has no dependencies, or every dependency resolves to a finished task, where finished means terminal status or an archived record.
  - A dependency ID that cannot be resolved is a **missing dependency** and blocks (fails closed).
  - Terminal and archived tasks are neither ready nor blocked.
  - Maps to TaskLog `blocked-by`. The importer must resolve dependency IDs across active, archived and `completed/` tasks and across prefix changes.
- **Labels**: `labels:` list of free strings, always written even if empty. Config `labels` is an optional list of known labels. Filtering supports `any`/`all` (`LabelMatchMode`). Maps to TaskLog `tags`.
- Parent/child is separate from dependencies: `parent_task_id` plus dotted IDs, not `dependencies`.

## 7. Where things live per state

- Active: `tasks/`. Draft: `drafts/`. Archived: `archive/tasks/` or legacy `completed/`.
- "Done" is a **status** in `tasks/` (the terminal `statuses` entry), not a move. Archiving is a separate explicit move, and archived tasks carry the same frontmatter and body.
- Tasks can also appear from other git branches and remotes (`source: "remote" | "local-branch"`, `check_active_branches`, `active_branch_days`). That is runtime state, not on-disk format. A migration should read the working copy only.

## 8. config.yml (for the importer)

Source: sample `backlog/config.yml`; typed shape `BacklogConfig` in `src/types/index.ts` (snake_case on disk).

Fields observed on disk: `project_name`, `default_status`, `statuses` (ordered; **last is terminal**), `labels`, `definition_of_done`, `date_format`, `max_column_width`, `default_editor`, `auto_open_browser`, `default_port`, `remote_operations`, `auto_commit`, `filesystem_only`, `bypass_git_hooks`, `check_active_branches`, `active_branch_days`, `task_prefix`.

Also in the typed config: `types`, `priorities`, `projects`, `zero_padded_ids`, `default_assignee`, `default_reporter`, `include_date_time_in_dates`, `on_status_change`, `mcp.http.*`, and a deprecated `milestones` list (milestones now live only in files).

The import needs `statuses` (to map the terminal status), `task_prefix` and the zero padding.

## 9. What an import must read: checklist

1. Locate root: `backlog/`, `.backlog/`, or `backlog.config.yml` → `backlogDirectory`.
2. Parse `config.yml` for `statuses`, `task_prefix`, and the `types`/`priorities` allow-lists.
3. Scan `tasks/`, `drafts/`, `archive/tasks/`, `archive/drafts/`, `completed/`; skip `readme.md`.
4. Parse YAML frontmatter; tolerate unquoted `@assignee` and a scalar `assignee`; coerce dates from the string, `Date`, and legacy forms. Do not require a closed key set.
5. Take identity from frontmatter `id`, cross-check with the filename ID loosely, and uppercase-normalize.
6. Extract the body by `## ` headers, honoring both sentinel and header-only forms and the title variants. Parse AC/DoD as `- [ ]`/`- [x]` items with optional `#N`.
7. Map `labels` → tags, `dependencies` → blocked-by (resolve across prefixes and archives), `parent_task_id`/dotted ID → parent.
8. Milestones, decisions and docs by their own frontmatter. Milestone references on tasks resolve by ID, number or title.
9. Never write back to the source, per the map's import-only constraint.

## Open points

- Task loading globs (which patterns find legacy `task-*.md` files after a prefix change) were not traced to the line; verify with a prefix-change fixture before the importer relies on them.
- The legacy comment format and some older checklist forms are known only from reader code paths; no sample was inspected.
- No normative schema or versioned spec exists upstream; behavior is as of the commit above and may drift.

## Sources

- Repo: https://github.com/MrLesk/Backlog.md @ `53f8ffe7150e521a3002326f213f3611b11192b3`
- `src/constants/index.ts`: directories, config file names, default statuses and types.
- `src/markdown/parser.ts`, `serializer.ts`, `frontmatter.ts`, `structured-sections.ts`, `section-titles.ts`: field names, markers and parse rules.
- `src/types/index.ts`: `Task`, `BacklogConfig`, entity types.
- `src/file-system/operations.ts`: paths, filename construction, sanitization, milestone ID and filename.
- `src/utils/prefix-config.ts`, `id-generators.ts`, `milestone-storage.ts`, `readiness.ts`, `terminal-status.ts`: ID rules, alias resolution, dependency semantics.
- `backlog/` in the same repo: real tasks, milestones, decision, doc and `config.yml` used as samples.
