# 07: Watcher and rescan

**What to build:** The model stays in step with edits made outside the daemon: a chokidar v6 watcher with debounce, hash-equality self-write suppression, create, delete and rename handling, and rescan on error. Spec reference: `.scratch/tasklogmd/spec.md`, sections 4 (watching and recovery) and 12 (watching and self-write suppression). The event source, clock and debounce are injectable.

**Blocked by:** 06 Minimal-diff editor and write protocol

**Status:** resolved

- [x] Given a daemon write, when the watcher fires, then no reparse occurs (real chokidar test, waiting on the daemon's own log events, never fixed sleeps).
- [x] Given an external edit, when the debounce elapses, then the model updates and the next write needs the new hash.
- [x] Given a burst of events for one path, when time advances, then they coalesce into one read (synthetic events, injected clock).
- [x] Given a rename, when seen, then the old item is removed and the new one added; given a new effort directory or file, it is picked up.
- [x] Given a file outside `.tasklog/**/*.md`, a symlink, `.git` or `node_modules`, when events arrive, then they are ignored.
- [x] Given any scenario, when a full rescan runs, then its model equals the live incremental model.
- [x] Given a watcher error or missed event, when it occurs, then a workspace rescan diffed by hash runs and is logged with its reason, and rescans log a summary count of suppressed events.
- [x] Given an unparseable file that is later fixed, when it parses again, then it leaves the invalid state.

## Comments

Implementation notes for later tickets (08 creation, 09 workflow, 11 observability).

**New module `src/daemon/watcher.ts`.** `WorkspaceWatcher(root, idx, log, guard, opts)`, one per workspace, created by `ModelManager.ensure` before the initial scan (events during indexing wait on `idx.ready`). Injectable: `WatcherOptions {enabled?, source?: EventSourceFactory, timers?: WatchTimers, debounceMs? (100)}`, passed as `DaemonOptions.watcher`; `enabled: false` runs without one. Default source is chokidar 6 on `<root>/.tasklog` (`ignoreInitial`, `followSymlinks:false`, non-`.md` files, `.git`, `node_modules` and temp files ignored). `ModelManager.watcherOf(root)` returns the watcher (tests call `push({type,path})`, advance fake timers, then `await idle()`; `stats` = events, reads, suppressed, rescans).

**Behaviour.** Every event for an item path (`identify` must accept it) is debounced per path; the debounced job waits for any queued daemon write to that file (`WriteService.settled(root, rel)`, new), then lstat (symlink or directory = not an item, dropped), read, hash. If the model already holds that hash the event is dropped (`watch.suppressed`, debug, reason `self_write` when `writes.isSelfWrite` agrees, else `unchanged`); otherwise `upsertFile` (`item.changed` or `item.added`, info). ENOENT removes the item (`item.removed`). Rename = unlink + add. Suppression is by model hash equality, not by trusting `isSelfWrite`, so a rescan racing a write cannot leave the model stale. `addDir`/`unlinkDir` additionally schedule one coalesced rescan (reason `directory_event`) in case per-file events are missing. A source error (`watch.error`, warn) or a non-ENOENT read failure triggers `rescan(reason)`: logs `watch.rescan {reason, suppressed_events}` (count since the previous rescan), waits for `writes.idle()`, then `idx.scan(reason)` (`scan.finished` carries the reason). `watch.ready` is logged when the source is live.

**Wiring.** `ModelManager.writeGuard` is set in `core.ts` right after the `WriteService` is created (`WriteGuard` = `isSelfWrite`, `settled`, `idle`); `ModelManager.drop` closes the watcher before disposing the index. Dependency added: `chokidar@^6`.

**Tests.** `test/integration/watcher.test.ts`: synthetic events with a fake clock (coalescing at 99 vs 100 ms, external edit then stale/fresh hash, own-write suppression with unchanged `store.parseCount`, invalid then fixed, rename, delete, unlink+add, new effort directory with and without file events, ignored paths and symlink, watcher error rescan with reason and suppressed count, mixed scenario), each ending in a rescan-as-oracle comparison against a fresh `WorkspaceIndex`; three real-chokidar tests that wait on `watch.ready`, `watch.suppressed`, `item.changed`, `item.added`, `item.removed` through a recording logger (`probe`), no fixed sleeps.

**Limits.** The watcher watches `.tasklog/` only, so a workspace whose `.tasklog` is created after the daemon starts is not watched until restart. A change made between the initial scan reading a file and chokidar becoming ready is not caught until the next event or rescan. `read-tools` 'initial scan gating' showed a one-off failure in a full parallel run under heavy machine load; it passes alone and in subsequent full runs.
