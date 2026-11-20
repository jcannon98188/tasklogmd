---
kind: ticket
title: File and tool result formats
status: resolved
type: grilling
blocked_by: [2]
created: 2026-11-20
updated: 2026-11-20T20:23:21Z
---

## Question

Specify the element file format precisely (front matter keys and types, body sections, slug rules, `components` field on tickets) and the result shapes of `scan_architecture`, `create_element` and the `architecture` compact tree, including how drift findings and ticket counts appear.

## Answer

### Element file
`.tasklog/architecture/<slug>.md`, flat. The slug is permanent, the title is editable, and there is no rename tool.
- Front matter: `kind` (container|component), `title`, `review` (proposed|accepted), `parent` (container slug, components only, omitted otherwise), `uses: [{to: <slug>, label?: string}]`, `code: [paths]`, `created`, `updated`.
- `code` entries are repo-relative, forward slashes, no leading `./`, no trailing slash, `.` for the workspace root. Roots only, never globs.
- `uses[].to`, `parent` and a ticket's `components` hold bare slugs, never Item IDs. `label` is optional.
- Body: `## Description` and `## Responsibilities`, both written empty by the scan (no generated prose). Other sections are preserved.

### Ticket field and edits
- `components: [slugs]` on tickets only, set with `set_fields`: lowercased, kebab-case, de-duplicated, not checked for existence. Setting it on a map, spec or element fails `bad_request`.
- `set_fields` on elements edits `title`, `parent`, `uses`, `code`, `review`. It validates that `parent` is an existing container and that no `uses` entry points at itself. An invalid edit fails `bad_request` and changes nothing. `kind`, `created` and the slug are immutable.

### Reading
- `architecture/<slug>` is a normal item with kind `container` or `component`. `list_items` hides elements unless `kind` is passed, and gains a `components` filter. `triage`, `claim`, `resolve` and `close` reject elements.

### create_element
`(kind, title, parent?, code?)` returns `{id, hash, path, slug}`. A hand-created element starts `review: accepted`. `bad_request` for a `parent` on a container or a non-container parent; `not_found` for a missing parent.

### scan_architecture
`(dry_run? = false)`; `dry_run` computes and reports the same plan without writing.
```
{ dry_run,
  created: [{id, kind, title, parent?, code}],
  updated: [{id, added: [paths], removed: [paths]}],
  unchanged: <count>,
  skipped: [{id, reason: "changed during scan"}],
  findings: [{category, id?, path?, detail}],
  ignored: {test, fixture-template, tooling, user, not-workspace-member: counts, with paths} }
```
Finding categories (stable kebab-case, one finding per instance): `missing-path`, `owns-no-code`, `unowned-code`, `parent-mismatch`, `ambiguous-match`, `possible-rename`. "Ignored" is not drift and appears only in the scan result.

### architecture
`(drift? = true)`: nested tree, no bodies, no `code` arrays.
```
{ containers: [{id, title, review, uses: [{to, label}],
    tickets: {open, claimed},
    children: [{id, title, review, uses, tickets}]}],
  findings, warnings }
```
- Counts are direct only: a ticket linking `daemon` counts for `daemon`, not its container. Only open and claimed tickets count.
- `uses` is shown on the declaring element only; the derived reverse is left out.
- Drift is computed on every call by running the scan plan read-only; `drift: false` skips it. `findings` has the scan's shape. `warnings` lists dangling references (a ticket's `components`, an element's `parent` or `uses[].to`).

### Flags and status
- One new `ItemFlag`, `dangling`, on a ticket or element with a dangling reference. The item stays valid; the detail lives only in `warnings`.
- `workspace_status` gains `architecture: {containers, components, proposed, accepted, warnings}`, counts only, no drift and no file-list access.

### Errors
No new error codes: `bad_request`, `not_found`, `stale_hash`. `scan_architecture` fails `bad_request` only for an uninitialised workspace, never for a partial write.

### CLI
`tasklog scan [--dry-run] [--json]`: a human summary of counts, then findings grouped by category; `--json` prints the raw tool result. Exit code 0 whenever the scan completes, even with findings. A missing daemon behaves like other commands.
