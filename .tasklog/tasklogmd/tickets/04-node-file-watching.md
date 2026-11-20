---
kind: ticket
title: Node file watching
status: resolved
type: research
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd/issues/04-node-file-watching.md
---

## Question

What is the most reliable way to watch a tree of markdown files from Node on Windows? Compare `fs.watch`, chokidar and @parcel/watcher on event reliability, atomic-save handling (editors that write a temp file and rename), event coalescing, startup scan cost, and ways to ignore the daemon's own writes (content hash or write token). Use primary sources: Node docs and each library's repo and issue tracker.

## Answer

Full notes: `.scratch/tasklogmd/research/04-node-file-watching.md` on branch `research/node-file-watching` (never merged). Measured on this Windows machine.

- Use chokidar v6 (pure JS, needs Node 22.22 or newer) and treat every event as a hint: on each event, stat and read the file and compare a content hash.
- Atomic saves: chokidar turned both variants into one `change`. Raw `fs.watch` emitted 5 events across two filenames. `@parcel/watcher` emitted 2 `update` events for a plain write and has open Windows bugs.
- Startup: chokidar about 84 ms to `ready` for 2,000 files and about 560 ms for 20,000. `@parcel/watcher` about 22 ms at both sizes, but it does not scan, so the daemon needs its own index walk anyway.
- No library can ignore the daemon's own writes. Keep a per-file hash of the last content the daemon wrote or read and drop events whose content matches. Rescan on watcher error and at startup.
- Not tested: real editors, network drives, cloud-sync interference. Worth a spike during implementation.
