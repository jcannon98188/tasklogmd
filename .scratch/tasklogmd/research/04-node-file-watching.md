# Research 04: watching a markdown tree from Node on Windows

Ticket: `.scratch/tasklogmd/issues/04-node-file-watching.md`. Researched 2026-11-17 on Node v24.21.0, Windows 11.

## Answer in brief

**Use chokidar v6 as the primary watcher, and treat every event as an invalidation.** On each event the daemon stats and reads the file, then compares a content hash to decide whether anything changed. Do not trust event type or event count from any watcher.

- Raw `fs.watch` is too noisy and gives no atomic-save handling (see the measured results below).
- chokidar 6 turns an atomic save into one `change`, coalesces bursts, is pure JS (no native build), and ships `atomic`, `ignored` and `ready` out of the box.
- `@parcel/watcher` is the fallback if scale ever matters. It is native C++ and has better coalescing, but it has open Windows bugs, no event for a lost-events overflow on Linux, and no write-finish handling.
- Self-write suppression is not a feature of any of the three. The daemon needs its own mechanism: remember the content hash it just wrote, and drop an event whose file content matches that hash. A write token is a weaker alternative.

## Sources

Primary sources used, all fetched 2026-11-17.

- [Node `fs.watch` docs](https://nodejs.org/api/fs.html#fswatchfilename-options-listener) (raw: <https://github.com/nodejs/node/blob/main/doc/api/fs.md>)
- [chokidar README](https://github.com/paulmillr/chokidar/blob/main/README.md), [docs/architecture.md](https://github.com/paulmillr/chokidar/blob/main/docs/architecture.md), and its [issue tracker](https://github.com/paulmillr/chokidar/issues)
- [@parcel/watcher README](https://github.com/parcel-bundler/watcher/blob/master/README.md) and its [issue tracker](https://github.com/parcel-bundler/watcher/issues)
- [npm registry metadata](https://registry.npmjs.org/chokidar/latest): chokidar 6.0.0 (depends only on `readdirp`, needs Node >= 22.22). [@parcel/watcher 2.6.0](https://registry.npmjs.org/@parcel/watcher/latest) (native, prebuilt binaries per platform, plus `picomatch` and `is-glob`).
- My own experiment on this machine (script and method below). That is first-hand measurement, not a citation; it is labelled "measured" wherever used.

## Comparison

### Node `fs.watch`

- **Reliability.** The docs say the API "is not 100% consistent across platforms". On Windows it is implemented over `ReadDirectoryChangesW`. Moving or renaming a watched directory emits nothing, and deleting it gives an `EPERM` error. Network filesystems are called out as unreliable. The `filename` argument "is not always guaranteed to be provided".
  [Node docs, Caveats and Availability](https://nodejs.org/api/fs.html#caveats)
- **Event model.** Only two event types exist, `rename` and `change`. `rename` fires "whenever a filename appears or disappears". There is no add/delete/modify distinction, so the caller must stat the path.
- **Recursive.** `recursive: true` is supported on Windows and macOS, and since v19.1.0 on Linux (changelog in the same section).
- **Loss of events.** The docs say nothing about overflow or lost events, so assume you will not be told.
- **Measured (Windows, Node 24, recursive watch on the root).**

  | Operation | Events observed for the target |
  |---|---|
  | plain write | 2x `change` |
  | append | 1x `change` |
  | atomic save (write tmp, rename over) | `rename tmp`, `change tmp`, `rename a.md`, `rename tmp`, `rename a.md` (5 events, two files) |
  | atomic save (write tmp, unlink, rename) | the same plus a trailing `change a.md` |
  | delete | 1x `rename` |
  | create | `rename` then `change` |

  chokidar's README says the same thing: raw `fs.watch` "reports many changes as an non-transparent `rename`, can fire twice for one change" ([README, Why?](https://github.com/paulmillr/chokidar#why)).
- **Startup cost.** Setup is about 0.3 ms and there is no initial scan; the daemon must walk the tree itself. Measured: a recursive `readdir` of 20,000 files took 12 ms and statting every file took about 200 ms.

### chokidar v6

v6 is described in the README changelog as "complete rewrite; new fs.watch(recursive) backend on macos + windows; requires Node.js 22+" (Oct 2026). v5 and earlier behave differently, so don't cite v3/v4 behaviour.

- **Reliability.** The architecture doc states the principle: "Backend notifications are invalidations; `stat`/scan results are truth" ([architecture.md](https://github.com/paulmillr/chokidar/blob/main/docs/architecture.md)). Reconciliation is serial per root and coalesced, and a rescan removes an entry only after `lstat` confirms it is gone. There is explicit Windows handling: a deleted watched directory's `EPERM` becomes a final `rename` invalidation, and callbacks that arrive with a truncated (empty) file are held for up to 10 ms until a non-empty stat arrives, "always on Windows with Node 22/24". The tracker still has recent fixed bugs about missed or dropped events, for example [#1471](https://github.com/paulmillr/chokidar/issues/1471) (files created in a newly added directory between scan and `fs.watch` registration were missed) and [#1437](https://github.com/paulmillr/chokidar/issues/1437) (events dropped when watching multiple files from one watcher). Both are closed, but they show the class of bug to expect.
- **Atomic saves.** `atomic` is `true` by default with native backends: "Editors that save through a temp file and rename produce `unlink` then `add`; within the window (100 ms by default) Chokidar emits a single `change` instead. It also ignores common editor temp files (`.swp` / `.swx`, `~` backups, Sublime `.subl*.tmp`)" ([README, Event timing](https://github.com/paulmillr/chokidar#event-timing)). Measured: both atomic variants above gave exactly one `change`, and no event for the `.tmp` file. Known caveat: [#1370](https://github.com/paulmillr/chokidar/issues/1370) (closed) reported that atomic detection breaks event ordering, and [#1028](https://github.com/paulmillr/chokidar/issues/1028) (closed) a performance problem with atomic writes. Neither is a reason to avoid it, but an editor whose temp file does not match the built-in patterns is not covered, so do not rely on the filename.
- **Coalescing.** There is a single user-visible 50 ms `change` window in `EventPolicy`; echoes such as create-then-change within 25 ms and a same-kind write within 10 ms are collapsed when the stat facts match (architecture.md, "Event policy"). Measured: plain write, append, atomic and delete each produced exactly one event. `awaitWriteFinish` (off by default) holds events until size is stable, which is useful only for large files and costs latency; tasks files are small, so leave it off.
- **Startup cost.** The initial scan walks the tree and stats every file. Measured: `ready` after about 84 ms for 2,000 files and about 560 ms for 20,000 files. `ignoreInitial: true` stops `add` events for existing files but still performs the scan, so the daemon should do its own initial indexing and use chokidar only for changes (or use `add` events as the scan and skip a second walk).
- **Ignoring.** `ignored` accepts exact path strings, regexes tested against forward-slash paths even on Windows, functions `(path, stats?)`, and `{ path, recursive }` objects. Globs were removed in v4. Use a function such as `(p, s) => s?.isFile() && !p.endsWith('.md')` and ignore `.git` and `node_modules` directories.
- **Cost of v6.** Needs Node >= 22.22, which is fine for a new TypeScript-on-Node daemon. Pure JS, one dependency, no native install step.

### @parcel/watcher 2.6.0

- **Reliability.** Native C++; on Windows it uses `ReadDirectoryChangesW` ([README, backends](https://github.com/parcel-bundler/watcher#watching)). On a Windows buffer overflow it throws `WatcherError("Buffer overflow. Some events may have been lost.")`, and macOS surfaces a must-rescan error, but on Linux `IN_Q_OVERFLOW` is silently skipped ([#280](https://github.com/parcel-bundler/watcher/issues/280), open). Other open Windows issues: [#193](https://github.com/parcel-bundler/watcher/issues/193) (every update emits 2 events), [#164](https://github.com/parcel-bundler/watcher/issues/164) (no `change` when continuously appending to a file that existed before the watch), [#262](https://github.com/parcel-bundler/watcher/issues/262) (use-after-free after `unsubscribe` while a completion is pending). All open as of today; the maintainers' own README lists VS Code, Nx and Nuxt as users, so it is battle-tested overall.
- **Atomic saves.** There is no atomic option. The README says "Only one notification will be emitted per file" per batch, "if a file was both created and updated since the last event, you'll get only a `create`", and "a file both created and deleted" is not reported. In effect, a temp file created and renamed within one batch disappears from the report. Measured: both atomic variants gave `update a.md` (plus the `.tmp` create and delete when the batch straddled them), so filter `.tmp` names and re-stat the target anyway.
- **Coalescing.** "Events are throttled and coalesced for performance during large changes ... and a single notification will be emitted with all of the events at the end", and one event per file per batch. Events arrive as an array, so batch handling comes for free. Measured: plain write still gave 2 `update` events (matches #193); append gave 1.
- **Startup cost.** `subscribe` does not scan. Measured about 22 ms at both 2,000 and 20,000 files. This is its main advantage over chokidar, but the daemon needs an initial index anyway, so the saving is only the second walk. `getEventsSince` plus `writeSnapshot` can catch changes made while the daemon was not running, but on Windows it falls back to a brute-force `FindFirstFile` scan unless Watchman is installed ([README, Querying](https://github.com/parcel-bundler/watcher#querying)), and snapshot-file issues on Windows are open ([#118](https://github.com/parcel-bundler/watcher/issues/118), [#211](https://github.com/parcel-bundler/watcher/issues/211)). A plain full re-index at start-up is simpler.
- **Ignoring.** `ignore` takes paths or picomatch globs relative to the watched root, with no events for matches. Glob handling has had crashes on long paths ([#250](https://github.com/parcel-bundler/watcher/issues/250), open) and drive-letter casing problems ([#63](https://github.com/parcel-bundler/watcher/issues/63), open).
- **Packaging cost.** Native module with prebuilt binaries per platform, installed via a postinstall step; in my install npm warned that the build-from-source install script was not run, and the prebuilt `@parcel/watcher-win32-x64` package was used. That adds an extra failure mode for Windows packaging, which is one of the map's unspecified areas.

## Summary table

| | `fs.watch` | chokidar 6 | @parcel/watcher 2.6 |
|---|---|---|---|
| Native / deps | built in | pure JS, 1 dep | native, prebuilt per platform |
| Event vocabulary | `rename` / `change` only | add / change / unlink (+Dir) | create / update / delete |
| Atomic save (measured) | 5 raw events, 2 filenames | 1 `change` | 1 `update` (tmp noise possible) |
| Plain write (measured) | 2 `change` | 1 `change` | 2 `update` (issue #193) |
| Coalescing | none | 50 ms window + echo suppression | native throttle, batches per file |
| Start-up, 20k files (measured) | 0.3 ms + own walk (~12 ms readdir, ~200 ms stat) | ~560 ms to `ready` | ~22 ms, no scan |
| Overflow signalled | undocumented | reconciles by rescan | Windows and macOS yes, Linux no (#280) |
| Ignore | `ignore` option (in current main docs; version not stated there) or manual | path / regex / function | paths + picomatch globs |
| Own-write suppression | none | none | none |

## Ignoring the daemon's own writes

None of the three libraries has this. Options, in order of robustness:

1. **Content hash (recommended).** The daemon keeps, per file, the hash (and mtime/size) of the last content it either read from disk or wrote. On any event for the path it re-reads the file and hashes it. If the hash equals the stored one, the event is dropped. This also makes duplicate events harmless (parcel #193, fs.watch double `change`), makes atomic-save noise harmless, and is correct however the event was produced. It matches the map's rule that the file always wins and the in-memory model is a derived index.
2. **Write token / expected-write registry.** Before writing, register `{path, expectedHash}` and expire it after a short window or on the first matching event. This is cheaper (no re-read), but it needs a time window and mishandles a user edit that lands inside that window; use it only as an optimisation in front of (1).
3. **Suppress by time window or by pausing the watcher.** Not recommended: either one can swallow a real concurrent edit, which would contradict "the file always wins".

Chokidar's internal echo suppression (`TreeState.observed`) and `awaitWriteFinish` do not distinguish the daemon's writes from other writes, so they do not replace this.

Windows note: write the daemon's own changes with a temp file plus rename in the same directory, so readers and watchers never see a half-written file, and still hash after the fact. (My experiment shows this pattern produces the same single event as an editor's atomic save in chokidar.)

## Recommended design (for the spec)

- Watcher: chokidar 6, `ignored` function limited to `*.md` and excluding `.git`, `node_modules`; `atomic` left at default; no `awaitWriteFinish`; one watcher per registered workspace.
- Treat events as hints: debounce per path (chokidar already does 50 ms), then `stat` and read, hash, compare with the model's last-known hash, and reparse only on a difference. A `unlink` is confirmed with a stat before the task is removed.
- Provide a manual rescan path and a periodic or on-error full rescan (on `error`, on wake from sleep, and at start-up) because no native watcher reliably reports lost events on every platform.
- Behind a small `Watcher` interface so `@parcel/watcher` can be swapped in if a workspace ever reaches tens of thousands of files, since its start-up cost and batched events scale better.
- Network drives and virtualised filesystems: use `backend: 'polling'` (Node docs say `fs.watch` can be unreliable there).

## Method and limits

Experiment: created a temp tree with 2,000 and then 20,000 small `.md` files, started each watcher on the root, and ran plain write, append, atomic save (two variants), delete and create against one file, waiting 700 ms after each. Versions: Node 24.21.0, chokidar 6.0.0, @parcel/watcher 2.6.0, on a local NTFS drive in the OS temp directory. One run per size; counts of duplicate events can vary with timing, and the numbers are indicative, not a benchmark. Not tested: network drives, antivirus or cloud-sync (OneDrive/Dropbox) interference, real editors (VS Code, Obsidian), or overflow behaviour under heavy event bursts. Those would be worth a spike during implementation.
