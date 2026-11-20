---
kind: ticket
title: Test strategy for the Architecture feature
status: resolved
type: grilling
blocked_by: [3]
created: 2026-11-20
updated: 2026-11-20T20:30:02Z
---

## Question

Decide how the Architecture feature is tested: fixture repos (which shapes, drawing on the tasklogmd, rpgengine and Gable examples from ticket 01), golden scans for the detection heuristics, how the match and merge edge cases from ticket 02 (rename, split, merge, hand-deletion, stale hash) are covered, how drift findings and the `architecture` tree are asserted, and how the tool and CLI result formats from ticket 03 are pinned. Name the test layers (unit, daemon integration, CLI) and what each owns.

## Answer

Settled by grilling with the user (all eight recommendations accepted). Builds on tickets 01 to 03 and the existing [Test strategy](../../tasklogmd/tickets/14-test-strategy.md). No new glossary terms.

**Layers** (Vitest, existing directories and npm scripts; no new framework)
- Unit (pure, no filesystem, no git): detection over an in-memory file list plus manifest contents; match and merge over (existing elements, candidates) giving a plan. The scan is split into a pure detect-and-plan function and a thin apply-with-hashes step.
- Integration (real daemon core, temp workspace, HTTP API): `scan_architecture`, `architecture`, `create_element`, `set_fields` on `components`, hand-deletion, stale hash, `workspace_status` counts, the reserved `architecture` effort name, one end-to-end case per scan outcome (created, updated, findings, ignored).
- CLI (`cli.test.ts` style): `tasklog scan [--dry-run] [--json]` only: exit code, output shape, `--json` equals the tool result.
- MCP e2e: one smoke test that the new tools are listed and callable through the real shim.

**Fixtures** (`test/fixtures/architecture/`, tiny synthetic trees, real repos cited in comments only): `single-package` (tasklogmd shape, including the `spikes/` nested-manifest wrinkle), `dotnet-multi` (rpgengine shape: test projects ignored, Cargo `[workspace]` not a container, component-less analyzers project, `ProjectReference` seeding), `npm-workspaces` (Gable shape: globs, non-member manifest ignored, fixture and template dirs ignored, grouping dir descended once), `angular-nx` (descriptors beat root `package.json`), `no-git` (built-in ignore list), `unowned` (manifest-less code dirs).

**Golden scans**: each fixture has a checked-in `scan.golden.json`, the `--dry-run --json` result. Whole-output comparison. Updated only by an explicit `UPDATE_GOLDEN=1` run and reviewed in the diff. Unit and integration share the one corpus.

**Match and merge**: table-driven unit rows, each with an expected plan: rename (no overlap, so new proposed element and old one drift, no guessing), split, merge, exactly 50% overlap on one or both sides, same files with a different kind, hand-deleted element with and without an ignore-file entry, curated fields untouched (`review: accepted`, `uses`, body, unknown front matter and sections), idempotence (second scan changes nothing).

**Concurrency and stale hash**: reuse the pause-between-verify-and-rename hook. Cases: a curator edits an element mid-scan and the scan's write gets `stale_hash` handled as ticket 02 decided with nothing lost; two scans racing with no duplicates; a scan interleaved with `create_element` of the same slug with exactly one winner. Plus one seeded randomized run of parallel scans, edits and hand-deletions, asserting every element file parses and a final dry-run scan is stable.

**Drift and tree**: exact-equality JSON assertions on small hand-built workspaces, not goldens. Cases: missing owned path, unowned repo part, nested tree order, direct (not rolled-up) open and claimed counts, dangling `components` names giving both a ticket flag and a `workspace_status` warning, and an empty tree for a workspace with no architecture.

**Windows and CI**: detection and merge unit tests run everywhere. Integration and CLI scan tests run on Windows every change and on Linux where the filesystem allows. Named path cases: backslash input normalised to forward-slash `code` paths, case differences, drive-letter workspace root, CRLF in manifests and element files. No new CI job.

**Release gate**: before 0.2.0, a manual non-CI step in the release steps: run `tasklog scan --dry-run` against the real tasklogmd, rpgengine and Gable checkouts and compare with the worked examples in ticket 01 by eye.
