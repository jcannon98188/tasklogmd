---
kind: ticket
title: Build order, package layout and release steps for 0.2.0
status: resolved
type: grilling
blocked_by: [4]
created: 2026-11-20
updated: 2026-11-20T20:40:43Z
---

## Question

With tickets 01 to 04 resolved, decide what the build spec still needs: the module and package layout for the Architecture feature (pure detect/plan, apply step, index, tools, CLI), the ordering of the build as implementation tickets (including what gates what), and the 0.2.0 release steps (including the manual real-repo scan check). Resolving this clears the way to write the effort's `spec` item from the decisions so far.

## Answer

Settled by grilling with the user (all eleven recommendations accepted, in two rounds). Builds on tickets 01 to 04. No new glossary terms.

**Package and module layout**
- `src/architecture/` (new, pure: no `daemon/` imports, no `fs`, no git): `types.ts` (`Element`, `Candidate`, `Plan`, `Finding`; written first, the single source of these types), `manifests.ts` (package.json, csproj, go.mod, Cargo, Nx/Angular parsers, one place to add a language), `detect.ts` (file list and manifest contents in, candidates out), `plan.ts` (existing elements and candidates in, plan out).
- `src/model/` extended, no parallel model: `elements.ts` (element parsing, schema, `create_element`), `architecture.ts` (tree, drift, direct open/claimed counts, reverse `uses`), and small edits to `parse.ts`, `index.ts` and `store.ts` for the `components` ticket field and the `architecture/` reserved directory. One index, one watcher, one hash scheme, so `get_item`, `list_items` and `set_fields` work on elements unchanged.
- `src/daemon/architecture-tools.ts` (new, in the style of `edit-tools.ts`): `scan_architecture`, `architecture`, `create_element`. It lists files (git-aware, built-in ignore list from ticket 01), calls the pure planner, and applies through `writes.ts` with hashes and the user ignore file.
- `src/commands.ts` and `src/cli.ts` gain only `tasklog scan [--dry-run] [--json]`, a thin caller of the tool.
- Small edits in existing code: `create_effort` refuses `architecture`; `workspace_status` gains the architecture counts and dangling-name warnings. Both ship in slice 1 with the index.

**Build order** (implementation slices; each leaves tests green)
1. Element model: elements, `components` field, index, reserved name, `workspace_status`.
2. Element tools: `create_element`, `architecture` tree with drift and counts. Blocked by 1.
3. Detection: `types.ts`, manifest parsers, `detect.ts`, fixtures and `scan.golden.json`. No blockers.
4. Match and merge: `plan.ts` and the table-driven unit rows. Blocked by 3 (imports the element type from `types.ts`, not the index).
5. Scan apply: `architecture-tools.ts` `scan_architecture`, file listing, ignore file, hashed writes, concurrency and stale-hash tests. Blocked by 1, 3, 4.
6. CLI: `tasklog scan` plus the MCP e2e smoke test. Blocked by 2 and 5.
7a. Docs: README Architecture and `tasklog scan` section; `docs/setup-skill` issue-tracker note on `components` and the `architecture` tool; ADR "scan matches by owned paths only, never by name, and never overwrites curated content" (hard to reverse, surprising, a real trade-off). Blocked by 5; can run while 6 is in progress.
7b. Real-repo check (HITL `task`): `tasklog scan --dry-run` on the tasklogmd, rpgengine and Gable checkouts, compared by eye with ticket 01's worked examples. Blocked by 6; blocks the bump.
7c. Release: bump `version.ts` and `package.json` to 0.2.0 (protocol stays 1), `npm pack`, install the tarball and run `tasklog doctor`, daemon-upgrade check, `npm publish`, tag. Blocked by 7a and 7b.

Slices 1 and 3 start in parallel; critical path is 1, 4 (via 3), 5, 6, 7b, 7c. Slice 2 hangs off the side, so a hand-built Architecture with ticket links is usable before any scan exists. No separate types-only slice.

**0.2.0 release checklist**
1. All tests green on Windows, including the four layers from ticket 04.
2. Manual real-repo `tasklog scan --dry-run` check (slice 7b).
3. Bump to 0.2.0, protocol 1.
4. `npm pack`, install the tarball, run `tasklog doctor`.
5. Daemon-upgrade check: after installing 0.2.0, an old 0.1.x daemon is replaced and the new tools are listed.
6. README and `docs/setup-skill` docs updated (slice 7a).
7. `GLOSSARY.md` updated if terms moved.
8. `npm publish`, then tag.

**Where the tickets live**: this effort ends at a build spec, so the slices are recorded in the effort's `spec` item as a build-order section. No implementation tickets are created now; they are created later in a new effort (for example `architecture-build`) from the spec, with each slice's scope, blockers, and the decisions from tickets 01 to 04 it implements.

**Next**: nothing is left to decide. The way is clear to write the effort's `spec` item from the decisions so far.
