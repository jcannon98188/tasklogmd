---
kind: spec
title: TaskLog Architecture feature
status: open
created: 2026-11-20
updated: 2026-11-20
---

## Problem Statement

Agents and humans working in a repo tracked by TaskLog have no cheap, accurate picture of the codebase. To plan or review a change they re-read the tree each session, and tickets cannot say which part of the code they touch. Hand-written architecture docs drift, and tools that derive structure from source need per-language analysis that is expensive to build.

The goal is a picture of a workspace as containers and components that stays close to the real repo without costing a human curation pass every time the code moves, and that tickets can link to.

## Solution

TaskLog 0.2.0 gains an **Architecture**: one markdown **Element** per **Container** or **Component** under the reserved `.tasklog/architecture/` directory, living in the same daemon, index, Item IDs and hash scheme as tickets. A deterministic structural **Scan** (manifests plus top-level directories, language-agnostic) proposes elements; agents and humans curate them; the scan never overwrites curated content. Tickets link to elements through a `components` field. Agents read a compact tree (`architecture`), find who owns a file (`owners`), and see **Drift** (missing owned paths, unowned code) without it ever being auto-fixed. `tasklog scan [--dry-run] [--json]` runs the scan from the CLI. Guidance for agents ships in the tracker template and tool descriptions.

Vocabulary (Architecture, Element, Container, Component, Owned code, Owner, Review, Scan, Drift, Touched component, Hotspot) is defined in `GLOSSARY.md`. "Map" means only a wayfinder map. Decisions came from the `tasklog-architecture` effort; each tracked ticket is cited by name below.

## User Stories

1. As an agent starting work in an unfamiliar repo, I want a compact tree of containers and components with titles, review state and ticket counts, so that I understand the layout without reading the filesystem.
2. As an agent, I want to scope that tree to one element, so that I spend tokens only on the area I am changing.
3. As an agent, I want to pass a list of file paths and learn which elements own them, so that I know which parts of the system a change touches.
4. As an agent creating or triaging a ticket that names files, I want guidance to call `owners` and set `components`, so that tickets are linked to the code they touch.
5. As a reviewer (human or agent), I want to run a diff's paths through `owners` and read each owner's Responsibilities and Interface, so that I can flag changes outside an element's remit.
6. As a maintainer, I want `tasklog scan` to propose containers and components from manifests and directories, so that I get a first picture without writing it by hand.
7. As a maintainer, I want `tasklog scan --dry-run` to show exactly what would change, so that I can trust it before writing.
8. As a maintainer, I want `--json` output equal to the tool result, so that I can script around the scan.
9. As a maintainer, I want a rescan to change only owned `code` paths, so that my curated descriptions, `uses`, review state and extra sections are never lost.
10. As a maintainer, I want an unchanged repo to produce zero diffs on rescan, so that scans are safe to run routinely.
11. As a maintainer, I want elements the scan proposes marked `proposed` until someone accepts them, so that I can tell curated from guessed content.
12. As a curator, I want to write Description and Responsibilities with `replace_section` and flip `review` with `set_fields`, so that curation uses the tools I already know.
13. As a curator, I want hand-created elements to start `accepted`, so that deliberate additions need no extra step.
14. As a curator, I want `create_element` with kind, title, optional parent and code, so that I can add what the scan cannot see (for example a `scripts/` directory).
15. As a maintainer, I want elements the scan keeps proposing to stop via a user-owned ignore file, so that hand-deleted noise does not return.
16. As a maintainer of a monorepo, I want only declared workspace members to become containers, so that fixture and template manifests do not pollute the picture.
17. As a maintainer of an Angular or Nx repo, I want project descriptors to define containers, so that the root `package.json` does not hide them.
18. As a .NET maintainer, I want test projects ignored and `ProjectReference` seeded into `uses`, so that the picture shows production structure and dependencies.
19. As a maintainer, I want grouping directories (`app`, `features`, `pages` and similar) descended once, so that components are the real features, not folder names.
20. As a maintainer, I want tooling and test directories excluded from proposals but reported, so that I can see why something was left out.
21. As a maintainer, I want code in manifest-less directories reported as unowned, so that I can decide whether it deserves an element.
22. As a maintainer, I want drift reported for missing owned paths, parent mismatches, ambiguous matches and possible renames, so that I know where the picture has gone stale.
23. As a maintainer, I want drift never auto-fixed and elements never auto-deleted, so that the scan cannot destroy curated work.
24. As a maintainer, I want a renamed directory shown as a new proposed element plus drift on the old one with a rename hint, so that nothing is guessed wrongly.
25. As an agent, I want a ticket's `components` to accept unknown slugs with a warning rather than failing, so that ticket writes never break because of the Architecture.
26. As a maintainer, I want `workspace_status` to show architecture counts and dangling warnings, so that I can see health at a glance.
27. As a maintainer, I want an empty Architecture to work everywhere (empty tree, everything unowned), so that the feature is usable before any scan.
28. As a maintainer with an older repo, I want `tasklog doctor` to warn when elements exist but my tracker doc lacks the Architecture section, so that agents get the guidance.
29. As a maintainer, I want `tasklog scan` to end with a next-step line when elements need curation, so that I know what to do next.
30. As a planner, I want to list which elements are most linked by tickets (post-0.2.0 `hotspots`), so that I find candidates for deepening without treating counts as verdicts.
31. As a maintainer, I want ADRs linked from an optional `## Decisions` section and domain context derived from `GLOSSARY-MAP.md`, so that no new fields are needed.
32. As a developer of TaskLog, I want the pure detection and planning code separate from the daemon, so that I can add a language by adding a manifest parser.

## Implementation Decisions

### Model
- Two element kinds, **container** and **component**; the workspace is the implicit system; no code level. One markdown file per element, flat, under reserved `.tasklog/architecture/<slug>.md`; Item ID `architecture/<slug>`. The slug is permanent; the title is editable; there is no rename tool. `create_effort` refuses the name `architecture`.
- Front matter: `kind`, `title`, `review` (`proposed` | `accepted`, not `status`), `parent` (container slug, components only), `uses: [{to, label?}]` (reverse derived, shown on the declaring element only), `code` (owned roots), `created`, `updated`. `code` entries are repo-relative, forward slashes, no leading `./`, no trailing slash, `.` for the workspace root; roots only, never globs. `parent`, `uses[].to` and a ticket's `components` hold bare slugs.
- Body: `## Description` and `## Responsibilities`, written empty by the scan and `create_element`. Other sections are preserved. Documented conventions, never generated or validated: `## Interface` (what a caller must know), `## Seams` (where behaviour can be swapped), soft cap about 10 lines each, and `## Decisions` (plain markdown links to ADRs). Domain context is derived from owned code plus `GLOSSARY-MAP.md`; there are no `context` or `adrs` fields.
- Ownership: a file belongs to the element with the longest matching root on whole path segments, so container carve-outs are implicit.
- Tickets own the link: `components: [slugs]` on tickets only, set with `set_fields` (lowercased, kebab-case, de-duplicated, existence not checked). Setting it on a map, spec or element is `bad_request`. Dangling names are warnings, plus a `dangling` item flag, never invalid tickets.
- `set_fields` on elements edits `title`, `parent`, `uses`, `code`, `review`, validating that `parent` is an existing container and that no `uses` entry points at itself; invalid edits are `bad_request` and change nothing. `kind`, `created` and the slug are immutable. `list_items` hides elements unless `kind` is passed and gains a `components` filter; `triage`, `claim`, `resolve` and `close` reject elements.

### Detection (structural, v1)
- Purely structural: manifests and directory layout; no symbols, tsconfig, path aliases or dependency-name sniffing. File list is git-tracked plus untracked-not-ignored in a git repo, otherwise a built-in ignore list (`.git`, `node_modules`, `dist`, `bin`, `obj`, `target`, `vendor`, `.tasklog`). Code files are a fixed, extensible extension list; a directory with no code never becomes an element.
- Containers: one per named buildable manifest (`package.json` with a name, `.csproj`, `go.mod`, Cargo `[package]`). Grouping-only manifests (Cargo `[workspace]`, workspace roots, `.sln`) contribute nothing. When JS workspaces are declared, only matched manifests are containers. Angular `projects` entries and Nx `project.json` files define containers and beat the root `package.json`. Containers are flat; a container's `code` is its manifest directory minus nested manifest directories. Test projects and fixture/template directories are never containers. Title = manifest name; slug = kebab-case, numeric suffix on collision.
- Components: source root is `src/` if present, else the manifest directory (or Angular `sourceRoot`). Each direct subdirectory holding code is a component (depth 1). Grouping directories (`app`, `features`, `modules`, `pages`, `routes`, `views`, `screens`, `domains`) are descended once; technical layers stay components. Tooling directories (`scripts`, `tools`, `config`, `e2e`, `cypress`, `.storybook`, `public`, `static`, `bin`) are never components. Slug collision prefixes the container slug.
- Manifest-less code directories are never proposed; they are reported as unowned code. New proposed containers get `uses` seeded from manifest references (`ProjectReference`, workspace and Cargo path dependencies); this happens at creation only.

### Match and merge
- Candidates are matched to existing elements by owned files, never by name: same kind only, pairs taken from largest shared-file count down, one-to-one, matching only when shared files are at least 50% of both sides; ties match neither and are reported as ambiguous. Unmatched candidates become new `proposed` elements.
- A matched element gets only its overlapping roots replaced; hand-added roots stay; no change means no write. The scan never deletes an element and never changes `review`. Renames are not guessed (new proposed element, old one reported as missing path, with an optional possible-rename hint by shared basename). A matched component under a different container is a `parent-mismatch` finding, not a rewrite.
- Ignore rules apply only to proposing candidates; an existing element owning an ignored path is left alone. `.tasklog/architecture/ignore` is a user-owned file (one path or glob per line, never written by the scan) that stops re-proposal of hand-deleted elements.
- Write safety: read all elements with hashes, compute the whole plan in memory, then write per element through the normal write path with that element's hash. A stale hash is skipped as "changed during scan", never retried or overwritten; the scan is not transactional and a rerun is idempotent.

### Tools and CLI
- New tools: `scan_architecture(dry_run?)` returning `{dry_run, created, updated, unchanged, skipped, findings, ignored}`; `architecture(root?, depth?, drift?)` returning `{containers: [...nested...], findings, warnings}` with direct (not rolled-up) open and claimed counts, no bodies, no `code` arrays; `create_element(kind, title, parent?, code?)` returning `{id, hash, path, slug}`, hand-created elements starting `accepted`; read-only `owners(paths)` returning `{owners: [{id, kind, title, paths}], unowned}`.
- Finding categories (stable kebab-case): `missing-path`, `owns-no-code`, `unowned-code`, `parent-mismatch`, `ambiguous-match`, `possible-rename`. "Ignored" (test, fixture-template, tooling, user, not-workspace-member) appears only in the scan result.
- `architecture` scoping: `root` is a bare slug (`not_found` if missing, `bad_request` if malformed); a container root returns its subtree, a component root returns its parent as a stub with that one child; `depth` 0 or 1; findings and warnings are filtered to the subtree and `unowned-code` is dropped from scoped views. Drift always runs the full plan read-only, then filters.
- `owners` normalises paths (backslashes, `./`, trailing slashes, `a//b`; absolute paths under the workspace become relative; case-sensitive; existence never checked), uses longest-root match on whole segments, lists a path under both elements on a tie, and fails `bad_request` for an empty or over-500 `paths` array or a path escaping the workspace. It never writes `components`.
- `workspace_status` gains `architecture: {containers, components, proposed, accepted, warnings}`. No new error codes (`bad_request`, `not_found`, `stale_hash` only). `tasklog scan [--dry-run] [--json]`: human summary and findings by category, `--json` equals the tool result, exit 0 whenever the scan completes, plus a next-step line only when something needs doing and `Nothing written.` on dry runs.
- Protocol stays 1; release is 0.2.0.

### Module layout
- A new pure `architecture` package (types, manifest parsers, detect, plan; no daemon imports, no filesystem, no git); the existing model extended with element parsing, the tree, drift, owners and reverse `uses`, with small edits for the `components` field and the reserved directory; a new daemon architecture-tools module for file listing, the ignore file and hashed writes; a thin CLI caller. One index, one watcher, one hash scheme.

### Agent onboarding
- A new `## Architecture` section (about 23 lines, including linking and review paragraphs) in the tracker template, delivered to existing repos by the setup patch's refresh step (re-copy if unmodified, else print for merge). It covers: element kinds, the tools, the curate-after-scan workflow (list `proposed`, write Description and Responsibilities, set `review: accepted`, link tickets, never edit element files by hand, never delete elements, raise unowned directories with the user), linking tickets via `owners` then `components` (skipped when the Architecture is empty), reviewing a diff via `owners` against Responsibilities and Interface, body-section conventions, and the `GLOSSARY-MAP.md` line.
- `architecture`, `scan_architecture`, `create_element` and `owners` get self-contained 3 to 5 sentence descriptions. Nothing is added to `CLAUDE.md` or `AGENTS.md`. `tasklog doctor` warns, as one line, when elements exist but the tracker doc has no Architecture section; no further doctor checks.

### Build order (slices; each leaves tests green)
1. Element model: elements, `components` field, index, reserved name, `workspace_status`.
2. Element tools: `create_element`, `architecture` (with scoping, drift and counts), `owners`. Blocked by 1.
3. Detection: types, manifest parsers, detect, fixtures and goldens. No blockers.
4. Match and merge: the planner and its table-driven tests. Blocked by 3.
5. Scan apply: `scan_architecture`, file listing, ignore file, hashed writes, concurrency tests. Blocked by 1, 3, 4.
6. CLI `tasklog scan` plus the MCP e2e smoke test. Blocked by 2 and 5.
7a. Docs: README Architecture and `tasklog scan` section; the tracker template section, tool descriptions and setup patch; an ADR "scan matches by owned paths only, never by name, and never overwrites curated content". Blocked by 5, may run alongside 6.
7b. Real-repo check (HITL task): `tasklog scan --dry-run` on the tasklogmd, rpgengine and Gable checkouts, compared by eye with the worked examples. Blocked by 6; blocks the bump.
7c. Release: bump to 0.2.0, `npm pack`, install the tarball, `tasklog doctor`, daemon-upgrade check, `npm publish`, tag. Blocked by 7a and 7b.
Post-0.2.0 follow-up (depends on slice 1 only): `hotspots(since?, include_zero?, limit?)` ranking elements by direct linked-ticket count across all statuses, per-status breakdown, sorted by total then id, zeros omitted by default, limit 20, dangling names to `warnings`, no score or "problem" wording.
Slices 1 and 3 start in parallel; the critical path is 1, 4 (via 3), 5, 6, 7b, 7c.

## Testing Decisions

- A good test asserts external behaviour: tool results, element and ticket file contents, CLI output. It never asserts internal structure or call order.
- **Primary seam: the daemon tool API.** Integration tests run the real daemon core on a temp workspace through the HTTP API: `scan_architecture`, `architecture`, `create_element`, `owners`, `set_fields` on `components`, hand-deletion, stale hashes, `workspace_status` counts, the reserved `architecture` name, and one end-to-end case per scan outcome (created, updated, findings, ignored). Drift and tree behaviour use exact-equality JSON on small hand-built workspaces (missing path, unowned code, nested order, direct counts, dangling `components` giving both a flag and a warning, empty Architecture). `owners` has the twelve table rows from its decision (component vs container ownership, tie, shared-prefix sibling, normalisation, escape, ancestor-only, empty Architecture, bounds, duplicates, read-only check).
- **One extra seam: the pure detect-and-plan functions**, table-driven with no filesystem or git. Detection runs over an in-memory file list and manifest contents; match and merge rows each carry an expected plan (rename, split, merge, exactly 50% overlap, same files different kind, hand-deleted element with and without ignore entry, curated fields untouched, idempotence). A shared normalisation helper has one table test including a case-sensitivity row.
- **Fixtures and goldens**: tiny synthetic trees (`single-package`, `dotnet-multi`, `npm-workspaces`, `angular-nx`, `no-git`, `unowned`) with a checked-in `scan.golden.json` each (the `--dry-run --json` result, compared whole, updated only by an explicit `UPDATE_GOLDEN=1` run and reviewed in the diff). Real repos are cited in comments only.
- **Concurrency**: reuse the pause-between-verify-and-rename hook: a curator edits mid-scan (skipped, nothing lost), two racing scans (no duplicates), scan interleaved with `create_element` of the same slug (exactly one winner), plus one seeded randomised run of parallel scans, edits and deletions asserting every file parses and a final dry-run is stable.
- **Thin extras**: CLI test for `tasklog scan [--dry-run] [--json]` only (exit code, shape, `--json` equals the tool result, next-step line); one MCP e2e smoke test that the new tools are listed and callable; preservation tests that a rescan and `replace_section` keep hand-written `## Interface` and `## Seams` and that `create_element` writes only Description and Responsibilities; a template-content unit test (style of the existing tracker-template test) checking `owners`, `components` and `Responsibilities` appear and the section stays within its line cap; a `doctor` test for the one warning.
- **Windows and CI**: detection and merge unit tests run everywhere; integration and CLI scan tests run on Windows every change and on Linux where the filesystem allows. Named cases: backslash input, case differences, drive-letter workspace root, CRLF in manifests and element files. No new CI job.
- **Prior art**: the existing Vitest unit, integration, CLI and MCP e2e layers and the pause hook for stale-hash tests; the existing tracker-template test; the project's earlier test strategy.
- **Release gate**: a manual, non-CI real-repo `tasklog scan --dry-run` before 0.2.0 (slice 7b).

## Out of Scope

- A web viewer or diagram renderer for the architecture.
- Static export (to a site or image).
- A PR-comment GitHub Action.
- Draft or flow records (Groma-style drafts and dynamic flows).
- Symbol analysis and per-language plugins: the v1 scan is structural only.
- Derived component-to-component relationships: `uses` is seeded between containers on creation only and otherwise curated. Revisit after 0.2.0.
- Rename and combine helpers for elements: hand edits and rescan only. Revisit if curation proves painful.
- ADR reverse lookup (which elements an ADR affects) and any structured ADR or context link.
- A `hotspots` tool in 0.2.0 (designed, post-0.2.0 follow-up).
- A scoped-plan optimisation for `architecture(root)`; drift still runs the full plan.
- Auto-writing `components` on tickets, auto-fixing drift, and deleting elements by tool.

## Further Notes

- Known wrinkle: in tasklogmd, `spikes/02-launch/stub/package.json` is a named manifest, so the plain rule proposes it as a container. It is reviewable as `proposed`; the user ignore file stops re-proposal after deletion.
- Implementation tickets are not created yet. They go in a new effort (for example `architecture-build`) from the Build order above, each with its slice scope, blockers and the decisions it implements.
- 0.2.0 release checklist: tests green on Windows across all layers; manual real-repo check; bump to 0.2.0 (protocol 1); `npm pack`, install the tarball, `tasklog doctor`; daemon-upgrade check (old 0.1.x daemon replaced, new tools listed); docs updated; `GLOSSARY.md` updated if terms moved; `npm publish`, then tag.
- Source decisions live in the resolved tickets of the `tasklog-architecture` effort; see its map for the index.
- Triage: the spec item cannot take a triage tag (the tracker rejects `triage` on specs), so `ready-for-agent` could not be applied here; apply it to the implementation tickets when they are created.
