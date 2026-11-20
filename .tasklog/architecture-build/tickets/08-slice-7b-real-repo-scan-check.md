---
kind: ticket
title: "Slice 7b: Real-repo scan check"
status: resolved
type: task
blocked_by: [6]
tags: [ready-for-human]
created: 2026-11-20
updated: 2026-11-20T23:11:33Z
---

## Question

Run `tasklog scan --dry-run` against the tasklogmd, rpgengine and Gable checkouts and compare the results by eye with the worked examples in tasklog-architecture/01 (including the `spikes/` wrinkle). Record any discrepancies as tickets; resolve this one with the findings. Blocks the version bump.

## Answer

Done by the orchestrator, read-only: a script ran `detect` and `plan` (no existing elements) over each repo's git file list on the integration branch after the ticket 11 fix, so nothing was written into those repos and the CLI itself was not run against them. Results versus tasklog-architecture/01:

- **tasklogmd**: container `tasklog` (`.`), components `architecture`, `daemon`, `import`, `model`; `spikes/02-launch/stub` proposed as container `tasklogspike2` (the known wrinkle, reviewable as `proposed`); `scripts` ignored as tooling, `test` ignored. Deviation already recorded on architecture-build/03: `scripts/` and `spikes/` are not listed as unowned because the root container owns them by prefix.
- **rpgengine**: four containers (`waymark-abi-common`, `waymark-abi-selftest`, `waymark-analyzers`, `waymark-foundation`), 13 Foundation components (Allocation to Types), Analyzers has none, test projects ignored, `build` reported unowned. Matches ticket 01.
- **Gable**: about 20 containers from `packages/*`, `native/engine-harness` and `site`; examples ignored as not workspace members; fixtures and templates ignored; grouping and layer directories give components such as `agent`, `server`, `components`, `lib`; slug collisions get suffixes (`gable-ui-2`, `gable-designer-2` for `src-tauri`). `.`, `examples` and `scripts` reported unowned. Matches ticket 01 in shape; counts are higher than its "about 15".

No blocking discrepancy.
