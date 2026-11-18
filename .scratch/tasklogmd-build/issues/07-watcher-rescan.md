# 07: Watcher and rescan

**What to build:** The model stays in step with edits made outside the daemon: a chokidar v6 watcher with debounce, hash-equality self-write suppression, create, delete and rename handling, and rescan on error. Spec reference: `.scratch/tasklogmd/spec.md`, sections 4 (watching and recovery) and 12 (watching and self-write suppression). The event source, clock and debounce are injectable.

**Blocked by:** 06 Minimal-diff editor and write protocol

**Status:** ready-for-agent

- [ ] Given a daemon write, when the watcher fires, then no reparse occurs (real chokidar test, waiting on the daemon's own log events, never fixed sleeps).
- [ ] Given an external edit, when the debounce elapses, then the model updates and the next write needs the new hash.
- [ ] Given a burst of events for one path, when time advances, then they coalesce into one read (synthetic events, injected clock).
- [ ] Given a rename, when seen, then the old item is removed and the new one added; given a new effort directory or file, it is picked up.
- [ ] Given a file outside `.tasklog/**/*.md`, a symlink, `.git` or `node_modules`, when events arrive, then they are ignored.
- [ ] Given any scenario, when a full rescan runs, then its model equals the live incremental model.
- [ ] Given a watcher error or missed event, when it occurs, then a workspace rescan diffed by hash runs and is logged with its reason, and rescans log a summary count of suppressed events.
- [ ] Given an unparseable file that is later fixed, when it parses again, then it leaves the invalid state.
