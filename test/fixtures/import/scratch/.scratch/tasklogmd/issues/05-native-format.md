Type: grilling
Status: resolved
Blocked by: 01

## Question

Design TaskLog's native file format. Decide the directory layout, the relation between map, spec and ticket files, the ID and filename scheme, the exact frontmatter fields (type, status, tags, claim, blocked-by, parent), the markers for ACs and the resolution answer in the body, and how fine-grained edits address a single AC stably (by index, by id, or by text). Use the backlog.md schema research as input to what to keep or drop.

## Answer

Settled by grilling with the user. Terms added to `GLOSSARY.md`: Item, Effort, Item ID, Acceptance criterion, Status.

**Layout and identity**
- All items live under `.tasklog/<effort>/`: `map.md`, `spec.md`, `tickets/NN-slug.md`. The directory is the parent, so there is no `parent` field.
- One item type with `kind: map | spec | ticket`, one parser and one set of generic edit operations.
- IDs are `<effort>/NN`, `<effort>/map`, `<effort>/spec`. They never change. The filename slug is cosmetic and never auto-renamed. Renaming an effort is unsupported in v1 (seen as delete plus new effort).

**Frontmatter** (unknown keys preserved)
- `kind`, `title` (no H1 duplicate in the body), `status`, `type` (tickets only: research | prototype | grilling | task), `claimed_by` (absent when unclaimed), `blocked_by` (same-effort numbers, or `effort/NN` across efforts), `tags`, `created`, `updated`.
- `status` is a fixed enum: `open | claimed | resolved | closed`. Closed means ruled out without resolving. Triage roles are ordinary tags.
- Tags are lowercase `[a-z0-9-]`. Slugs are lowercase kebab-case derived from the title.

**Bodies** (plain `##` headings, no sentinels)
- Ticket: `## Question` (required), `## Acceptance criteria`, `## Answer`. Unknown sections are left alone and sections are never reordered.
- ACs are written `- [ ] #N text`. A fine-grained edit addresses an AC by item plus `#N`. A hand-added AC without a number gets the next free one on the daemon's next write.
- Resolving and closing both write their explanation to `## Answer`. No `resolved_at` or `closed_reason` fields; `updated` records when.
- Map: fixed headings Destination, Notes, Decisions so far, Not yet specified, Out of scope. Decisions-so-far is an append-only list of `- [title](relative/path.md): gist`.
- Spec: free-form body, edited by whole-section replace only.

**Behavior**
- New ticket and AC numbers are `max + 1`, with no stored counters. The daemon closes tickets and never deletes them. An AC deleted from the end of a list may have its number reused.
- Writes patch in place and preserve CRLF, key order, comments, quoting, blank lines and unknown sections. A one-field edit produces a one-line diff. New files use LF and canonical key order.
- Concurrency token is a content hash of the whole file, returned on reads and required on writes. It is not stored in the file, and a stale hash is rejected. It matches the content-hash self-write suppression from the file-watching decision.

**Import (for the import ticket)**
- Dropped from backlog.md: sentinel comments, configurable ID prefixes, a configurable status list, moving files to mark done.
- Backlog `labels` map to `tags`, and "done" maps to `resolved`.
