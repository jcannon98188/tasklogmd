---
kind: ticket
title: Import migration
status: resolved
type: grilling
blocked_by: [1, 5]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/08-import-migration.md
---

## Question

Design the one-shot import. Decide how backlog layout and scratch layout fields map onto the native format, how IDs and links are preserved or rewritten, what happens to content with no native equivalent, how the command reports and handles partial failures, and whether it is idempotent when re-run.

## Answer

Settled by grilling with the user. No new glossary terms needed (Import, Backlog layout and Scratch layout already cover it).

**Invocation**
- CLI command `tasklog import <path>`. It auto-detects a backlog layout (`backlog/` with `config.yml`) or a scratch layout (`.scratch/<effort>/`).
- It writes into `.tasklog/` in the same workspace and never modifies the source.
- It runs in-process and writes new files directly, with no daemon needed. The daemon's watcher or rescan picks them up. Import only creates files, so it never races the hash checks.
- `--dry-run` reports without writing. `--effort <name>` forces everything into one effort; `--group-by none` is the equivalent opt-out of milestone splitting.

**Effort mapping**
- Scratch: each effort directory becomes an effort of the same name (`map.md`, `spec.md`, `issues/NN-*.md` become `map.md`, `spec.md`, `tickets/NN-*.md`).
- Backlog: each milestone becomes its own effort, named by the milestone slug. Tasks with no milestone go to a single leftover effort `backlog`. No milestone tag is added, because the effort carries it.
- Effort is a required argument on ticket creation, with no default, and the tracker doc tells agents to start a new effort (map and spec) for each new body of work. This stops new work drifting into `backlog`, which only shrinks.

**IDs and links**
- Scratch ticket numbers are kept: `NN` becomes `effort/NN`.
- Backlog `BACK-743` in milestone `v2-launch` becomes `v2-launch/743`. The prefix is dropped and the number kept.
- Dependencies resolve by numeric ID across active and archived tasks (per the backlog.md schema research) and may cross efforts via `effort/NN`. A dependency that resolves to nothing is dropped from `blocked_by` and listed in the report.
- Two backlog tasks sharing a numeric ID (prefix change) in the same effort: the second gets the next free number and the report flags it.
- Backlog subtasks (`BACK-743.1`) have no native parent, so each gets a fresh number after the max and a tag `parent-743`.
- Scratch body links `issues/NN-x.md` (e.g. in the map's Decisions-so-far) are rewritten to `tickets/NN-x.md`. Other relative links are left alone.
- Every imported item gets an `imported_from: <source-relative path>` frontmatter key (an unknown key, so preserved). It records provenance and drives idempotency.

**Status mapping**
- Scratch: `open`, `claimed`, `resolved` map directly. A triage role in `Status:` (`needs-triage`, `ready-for-agent`, etc.) becomes status `open` plus the role as a tag; `wontfix` becomes `closed` plus the tag. The `Label: wayfinder:map` line and `Type:` fold into `kind` and `type`.
- Backlog: the last configured status becomes `resolved` and the first becomes `open`. A middle status (e.g. "In Progress") becomes `claimed`, with `claimed_by` set to the first assignee or `imported`, and the original status name kept as a tag. `drafts/` becomes `open` plus tag `draft`. `archive/` becomes `closed` plus tag `archived`. Legacy `completed/` becomes `resolved`.

**Content with no native equivalent**
- Unknown frontmatter keys (`priority`, `type`, `references`, `ordinal`, ...) are carried over verbatim. Priority is also mirrored as a tag (`priority-high`) so it is searchable.
- Backlog PLAN and NOTES sentinel sections become plain `## Implementation plan` and `## Implementation notes`. All sentinel comments are stripped, and ACs are written `- [ ] #N text`, keeping their numbers.
- Scratch `## Comments` and any other sections are kept as-is.
- Backlog `docs/`, `decisions/` and `milestones/` files are not imported; the report lists them as skipped.

**Failure handling and report**
- The importer parses everything first and builds the result in a temp staging directory. A file that fails to parse is skipped and recorded, and import continues. Staging is then moved into `.tasklog/` in one step, so there are never half-written efforts.
- The command prints a summary: imported, skipped with reasons, and warnings for dropped dependencies, ID collisions and dropped sections. It exits non-zero if anything was skipped. No report file is written into `.tasklog/`.
- The globs that find backlog task files after a prefix change were never traced in the schema research, so the importer needs a fixture test for it.

**Idempotency**
- Re-running is safe. Items whose `imported_from` is already present in the target are skipped and never overwritten, so hand edits survive. New source files are added.
- If the target effort exists with items not created by import, only missing items are added, with a warning.
- No update-from-source mode in v1. The native copy is authoritative after import.

**Timestamps**
- `created` and `updated` come from the source: `created_date` for backlog, file mtime for scratch. Import time is never stamped.
