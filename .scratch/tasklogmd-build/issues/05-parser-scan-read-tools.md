# 05: Parser, scan and read tools

**What to build:** An agent can read a workspace: the daemon scans `.tasklog/`, builds the two-layer model (parsed-item store plus workspace index), and serves `get_item` and `list_items` with structured filters and paging. Spec reference: `.scratch/tasklogmd/spec.md`, sections 3, 4 (model), 5 (`list_items` and `get_item`) and 12 (fixtures). Text search is out of scope here; writes are out of scope.

**Blocked by:** 04 Walking skeleton

**Status:** resolved

- [x] Given the native fixture workspace, when scanned, then every item is in the index with the right ID, kind, status, type, tags, `blocked_by` and ACs.
- [x] Given an invalid file, when scanned, then it appears flagged invalid in listings and `get_item` on it fails `invalid_item`.
- [x] Given duplicate Item IDs, when scanned, then both are kept, lookup by that ID fails `conflicted` listing both paths, and `workspace_status` counts them.
- [x] Given an unknown frontmatter key, CRLF or LF endings, a UTF-8 BOM or unknown sections, when parsed, then all are preserved in the parse result.
- [x] Given identical file bytes in two workspaces, when both are scanned, then they share one parse result in the store, which is evicted when no index references it.
- [x] Given `list_items` with `effort`, `kind`, `status`, `type` and tag filters, when called, then results match and are ordered by effort then ticket number, each carrying `hash` and `flags`.
- [x] Given `list_items` with `limit` above 200, when called, then it is capped at 200 and `total` is the pre-paging count; given the model version changes between pages, the next page fails `stale_cursor`.
- [x] Given a request during the initial scan, when it waits more than about 5 s, then it fails with the retryable `indexing` error.

## Comments

Implementation notes for later tickets (06 editor, 08 watcher, 10 search, 11 observability, 13 import).

**New modules.**
- `src/model/parse.ts`: pure `parseItem(bytes|string): ParseResult` and `contentHash(bytes)` (hex sha256 of the exact file bytes, BOM included; this is the concurrency token). Constants `KINDS`, `STATUSES`, `TYPES`. No dependencies; hand-written parser for the frontmatter subset (scalars, inline lists, block lists, quoted strings, comments; anything else under a key is kept as raw text).
- `src/model/store.ts`: `ParsedItemStore` (`acquire(bytes) -> ParseResult`, `release(hash)`, `get`, `has`, `refs`, `size`, `parseCount`). Keyed by hash, ref-counted, evicted at zero. Every `acquire` must be balanced by one `release`. It knows no paths.
- `src/model/index.ts`: `WorkspaceIndex(root, store, {log, now?, beforeScan?})`. Mutation: `upsertFile(relPath, bytes) -> true|false|null` (changed / identical bytes / outside layout), `removeFile(relPath)`, `scan(reason)` (full scan diffed by hash; the first one flips `state` to `ready`; ticket 08's rescan calls the same method), `dispose()`. Reads: `get(id)`, `list(query)`, `entries()`, `entriesForId(id)`, `entryByPath()`, `counts()`, `problems()`, `modelVersion`, `state`, `ready`. Paths are workspace-relative with forward slashes (`.tasklog/<effort>/tickets/01-x.md`); `upsertFile`/`removeFile` accept that form or relative to `.tasklog/`.
- `src/daemon/models.ts`: `ModelManager(registry, log, {indexWaitMs?, beforeScan?})` owns the global store and one index per workspace. Wired through registry hooks (`onRegister` starts the background scan, `onUnregister` disposes and evicts, `stateOf` feeds `/health`). `ready(root)` waits for the initial scan up to 5 s then throws retryable `indexing`; `peek(root)` does not wait. `RunningDaemon.models` exposes it (tests; ticket 06/08 will call `idx.upsertFile` after a write or watcher event). `McpDeps` now has `models`.

**Parse result shape** (`ParseResult = ValidParse | InvalidParse`, immutable). Both: `hash`, `bom`, `eol` (`lf|crlf|mixed|none`), `text` (file decoded, BOM stripped, line endings untouched; every offset indexes into it). Invalid: `{ok:false, error}`. Valid: `fields` (`kind,title,status,type?,claimedBy?,blockedBy,tags,created?,updated?`), `entries[]` (every top-level frontmatter key in order: `key, value, start, end, raw`; the editor patches by these offsets), `extra` (unknown keys), `bodyStart`, `body`, `sections[]` (`heading,start,contentStart,end`; `##` only, fenced code ignored, unknown sections included), `acs[]` (`n|null,text,checked,start,end`; read from `## Acceptance criteria` only; `n` is null for a hand-added AC). `blockedBy` is as written (numbers = same effort; strings = `effort/NN`); the index resolves them to full IDs, since the parse result is path-independent.

**Decisions.**
- Item IDs come from the path: `<effort>/map`, `<effort>/spec`, `<effort>/NN` where NN is the filename number **zero-padded to two digits** (`3-x.md` and `03-y.md` are the same ID, so they conflict). `normalizeId` applies the same rule to lookups, so `get_item("alpha/3")` works. Only `<effort>/map.md`, `spec.md` and `tickets/<digits>[-slug].md` are items; everything else (README, stray notes, dot-directories, symlinks, temp files) is ignored.
- An invalid file keeps its path-derived id and kind, appears in `list_items` with `flags:["invalid"]`, `status:null`, `error`, and the file name as title; `get_item` fails `invalid_item` (details: id, path, error). Invalid items match only the `effort`, `kind` and `tags_none` filters. `IndexEntry.lastGoodHash` is kept when a valid file turns invalid.
- Conflicted IDs: all files kept and listed (flag `conflicted`); `get_item` fails `conflicted` with `details.paths` (sorted); `counts.conflicted` counts IDs; `problems()` lists them. Ticket 06 must refuse writes via `entriesForId(id).length > 1` and take `max+1` over `entries()`.
- `list_items` rows carry `id,title,kind,status,type,tags,claimed_by,blocked_by,hash,flags` plus `path` (needed to tell conflicted files apart; additive) and `error` (invalid only). Order: effort, then map, spec, tickets by number. Tag filters (`tags_all/any/none`) are implemented here since they are structured filters; `text`, `snippet`, `matched_in` are ticket 10's. `limit` default 50, clamped to 1..200. Cursor = base64url JSON `{v: modelVersion, o: offset, k: filter key}`; `modelVersion` bumps on every real model change, a mismatch gives `stale_cursor`, a malformed cursor or one from different filters gives `bad_request`.
- `get_item` returns `id, path, hash, frontmatter (all keys incl. unknown, raw values), body, acs, flags, mtime` (stat at call time). The model's hash is returned, not a re-read of the disk.
- `workspace_status` now returns real `state`, `counts` (`items,invalid,conflicted,efforts,by_kind,by_status`) and `problems[]` (`{type,id,paths,error?,since}`; ticket 11 owns the final shape and `recent_events`). It waits up to the same 5 s but reports `state:"indexing"` instead of failing.
- `/health` workspace `state` is now real (`indexing` until the first scan ends).
- Logging: `scan.start`, `scan.finished` (reason, counts, duration), `item.invalid` (warn), `item.valid`, `item.conflicted` (warn).

**Fixtures** (`test/fixtures/native/<name>/.tasklog/...`, copied per test with `copyFixture(name, parentDir)` in `test/helpers.ts`): `normal` (two efforts, all kinds/statuses/types, cross-effort and numeric `blocked_by`, non-ASCII title, unknown `## Comments` section, files outside the layout), `invalid`, `duplicate-ids`, `unknown-key` (unknown keys, comments, quoting, unnumbered AC, unknown sections), `eol-bom` (CRLF, LF, BOM, BOM+CRLF). `.gitattributes` marks `test/fixtures/**` as `-text` so CRLF and BOM bytes survive checkout. Import fixtures (spec section 12) belong to ticket 13.

**Tests.** `test/unit/parse.test.ts`, `test/unit/model.test.ts` (store sharing and eviction, ordering, filters, paging, cursors, conflicts), `test/integration/read-tools.test.ts` (all ACs through the real daemon over HTTP; indexing gate via `DaemonOptions.beforeScan` and `indexWaitMs`), one e2e read through the shim.

**Deviations/limits.** No YAML library: exotic YAML (anchors, multi-line flow maps) is kept as raw text under its key rather than parsed. No watcher yet, so the model only changes on scan or explicit `upsertFile`/`removeFile`. `kind` in frontmatter that disagrees with the path is not flagged (id and kind come from different sources); worth a check in ticket 08/11 if wanted.
