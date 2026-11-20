---
kind: ticket
title: Creation and numbering
status: resolved
blocked_by: [6]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd-build/issues/08-creation-numbering.md
---

## Question

**What to build:** An agent can start a new body of work and add tickets to it: `create_effort` and `create_item` produce correctly formatted new files with `max + 1` numbering. Spec reference: `.scratch/tasklogmd/spec.md`, sections 3 and 5.



- [x] Given a new effort, when created, then `map.md` and `spec.md` exist with the fixed map headings, LF endings and canonical key order, and the map and spec IDs are returned.
- [x] Given existing tickets, when one is created, then its number is `max + 1` over all files including conflicted ones, with no stored counters.
- [x] Given `create_item` without `effort`, when called, then it fails `bad_request`.
- [x] Given `blocked_by` and `tags`, when a ticket is created, then they are written normalized (lowercase tags, same-effort numbers or `effort/NN` across efforts).
- [x] Given `type` omitted, when a ticket is created, then no `type` key is written.
- [x] Given a title, when the file is named, then the slug is lowercase kebab-case derived from it and is never auto-renamed later.
- [x] Given an effort that already exists, when `create_effort` is called, then it fails `bad_request` and changes nothing.

## Comments

Creation API for ticket 09 (workflow tools) and later tickets.

**New/changed modules.**
- `src/model/create.ts` (pure, no I/O): `renderTicket(NewTicket, date)`, `renderMap(title, destination?, date)`, `renderSpec(title, date)`, `ticketFileName(n, title)` (`NN-slug.md`, or `NN.md` when the slug is empty), `ticketId(effort, n)`, `slugify`, `checkEffortName`, `checkTitle`, `isoDate(ms)` (UTC `YYYY-MM-DD`), `MAP_HEADINGS`. New files are LF, canonical key order (`kind,title,status,type,blocked_by,tags,created,updated`), tags and `blocked_by` as inline lists, no `type`/`tags`/`blocked_by` key when empty or omitted. Map = the five fixed headings in order (Destination holds the optional text); spec = frontmatter only (free-form body).
- `src/model/edit.ts`: now also exports `normalizeBlockedBy`, `renderString`, `checkNoHeading` (reused so creation and `set_fields` normalise identically).
- `src/daemon/writes.ts`: `WriteService.createEffort(root, {effort, title, destination?})` returns `{effort, map_id, map_hash, spec_id, spec_hash, paths:{map,spec}}`; `WriteService.createItem(root, {effort, title, question, type?, blocked_by?, tags?})` returns `{id, hash, path, number}`. `WriteServiceOptions.now` injects the clock (core.ts passes the daemon clock) for `created`/`updated`; ticket 09 should use the same `now` for `updated`.
- `src/daemon/edit-tools.ts`: MCP tools `create_effort` and `create_item` (both accept optional `workspace`). `effort` is optional in the zod schema only so a missing one reaches the handler and fails `bad_request` rather than a protocol error.

**Decisions.**
- Number = `max + 1` over every ticket file of the effort, taken from the model entries (conflicted and invalid files count) and a fresh `readdir` of `tickets/` (so it is right even before the watcher has seen a hand-added file). No counters. Numbers are zero-padded to two digits (`100` past 99).
- Creation runs in the per-effort queue (key `create\0root\0effort`), separate from the per-file edit queues. Files are written temp-then-hard-link (`fs.link` fails `EEXIST` rather than overwriting; rename fallback where links are unsupported), then registered with `idx.upsertFile` and recorded in `selfWrites` for the watcher (07). Failure removes the temp file; a failed `create_effort` removes the directory it made and its index entries.
- Effort names must match `^[a-z0-9][a-z0-9-]*$` (`bad_request` otherwise, with a suggested slug), so they are safe directory names on case-insensitive file systems. An effort "exists" if its directory exists or the index has any item of it; then `create_effort` is `bad_request` and writes nothing.
- `create_item` on an unknown effort is `not_found` (hint: `create_effort`), a deliberate choice since spec says to start an effort per body of work. Empty or missing `effort` is `bad_request`. `question` must be non-empty and contain no `## ` heading line (outside code fences); CRLF in the question becomes LF. Title must be single-line. `blocked_by`: digits become numbers, same-effort `eff/N` collapses to `N`, other efforts become `eff/NN`, self-reference is `bad_request`. Tags: `normalizeTags`.
- The slug is cosmetic and fixed at creation; `set_fields` title changes never rename (tested).

**Tests.** `test/unit/create.test.ts` (format, key order, no `type` key, normalisation, refusals, slugs, map headings), `test/integration/create-tools.test.ts` (all ACs through the daemon over HTTP; conflicted+invalid numbering, racing `create_effort`, 8 concurrent `create_item`, no temp files).
