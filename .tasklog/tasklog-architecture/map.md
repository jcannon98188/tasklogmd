---
kind: map
title: TaskLog Architecture feature
status: open
created: 2026-11-20
updated: 2026-11-20
---

## Destination

A build spec for an Architecture feature inside TaskLog, inspired by Groma.md: a cheap, accurate picture of a workspace's codebase as containers and components, which tickets can link to. Decisions only; nothing is built in this effort.

## Notes

Domain terms are in `GLOSSARY.md` (Architecture, Element, Container, Component, Owned code, Review, Scan, Drift, Touched component). "Map" means only a wayfinder map.

Settled in the opening grilling (26 questions, all agreed); tickets must not reopen these:

- **Purpose**: agents and humans get a cheap, accurate codebase picture; tickets link to the parts they touch. Lives inside TaskLog (same daemon, Item IDs, hashes, tools). Authorship is a mix: a deterministic scan proposes, agents and humans curate, the scan never overwrites curated content.
- **Model**: two element kinds, container and component; the workspace is the implicit system; no code level. One markdown file per element under reserved `.tasklog/architecture/`, slug-based permanent ID, Item ID `architecture/<slug>`; `create_effort` refuses the name `architecture`.
- **Front matter**: `kind`, `title`, `review` (proposed|accepted, not `status`), `parent`, `uses: [{to, label}]` (reverse derived), `code` (owned paths), `created`, `updated`. Body headings `## Description` and `## Responsibilities`; other sections preserved.
- **Tickets**: the ticket owns the link through a `components` field set with `set_fields`; the reverse is derived by index. Dangling names are warnings (workspace_status, ticket flags), not invalid tickets.
- **Scan**: v1 is language-agnostic and structural (manifests such as package.json, .csproj, go.mod, plus top-level dirs); symbol analysis and per-language plugins come later. It runs in the daemon through the normal write path, and `tasklog scan` calls it. It matches existing elements by owned `code` paths only, never by name; unmatched finds become new `proposed` elements. A rescan rewrites only `code`.
- **Tools**: reuse get_item, list_items, set_fields, replace_section, append_to_section; add `scan_architecture`, `architecture` (compact tree: titles, review, uses, open/claimed ticket counts, no bodies, plus drift) and `create_element` (kind, title, optional parent).
- **Drift** (missing owned paths, unowned parts of the repo) is reported, never auto-fixed. Removal is deleting the file by hand; dangling references warn.
- **Release**: 0.2.0, protocol stays 1.
- ADRs and docs stay plain files; a structured ADR link is deferred.

## Decisions so far

- [Structural detection heuristics](tickets/01-structural-detection-heuristics.md): Containers = one per named buildable manifest (workspace members only when declared; Angular/Nx descriptors win); components = depth-1 source dirs, descending once through grouping dirs; tests, fixtures, templates and tooling dirs ignored; manifest-less code dirs reported as unowned; `uses` seeded on new containers only.
- [Scan match and merge algorithm](tickets/02-scan-match-and-merge-algorithm.md): Match by owned files, same kind, one-to-one, at least 50% overlap of both sides; no rename guessing; scan never deletes or changes review; user ignore file stops re-proposal; compute first, write per element with hashes.
- [File and tool result formats](tickets/03-file-and-tool-result-formats.md): Flat `<slug>.md` elements with bare-slug references and root-only `code` paths; `components` on tickets (unchecked, `dangling` flag + warnings); exact shapes for `create_element`, `scan_architecture` (dry_run, created/updated/findings/ignored), `architecture` (nested tree, direct open/claimed counts, drift + warnings), `workspace_status` counts, no new error codes, `tasklog scan [--dry-run] [--json]`.
- [Test strategy for the Architecture feature](tickets/04-test-strategy-for-the-architecture-feature.md): Four existing layers extended: pure unit tests for detection and match/merge (table-driven), integration for apply/concurrency/drift/tree, thin CLI and e2e; synthetic fixtures with golden scan JSON; Windows path/CRLF cases; manual real-repo dry-run before 0.2.0.
- [Build order, package layout and release steps for 0.2.0](tickets/05-build-order-package-layout-and-release-steps-for-0-2-0.md): New `src/architecture/` (pure detect/plan/manifests/types), model extended in `src/model/`, apply and tools in `src/daemon/architecture-tools.ts`; seven slices with 1 and 3 parallel, critical path 1,4,5,6,7; manual real-repo check is a HITL task before the 0.2.0 bump; slices go in the spec, tickets created later.
- [Agent onboarding for the Architecture](tickets/06-agent-onboarding-for-the-architecture.md): Guidance lives in a new `## Architecture` section of the tracker template plus the three tool descriptions; nothing added to CLAUDE.md/AGENTS.md; setup patch gets a refresh step and `doctor` a warning; `tasklog scan` prints a next-step line; no new tools.
- [Owner lookup by file path](tickets/07-owner-lookup-by-file-path.md): New read-only `owners` tool (paths in; owners grouped by element plus `unowned` out) by longest-root match, never writes `components`; shared path normalisation; joins slice 2; Owner added to glossary.
- [Scoped architecture view](tickets/08-scoped-architecture-view.md): `architecture` gains optional `root: <slug>` and `depth` (0 or 1): container root returns its subtree, component root returns a parent stub with that one child; findings and warnings filtered to the subtree, unowned-code dropped; missing slug `not_found`; counts stay direct; joins slice 2.
- [Hotspots: ranking elements by ticket history](tickets/10-hotspots-ranking-elements-by-ticket-history.md): Post-0.2.0 follow-up: a separate read-only `hotspots` tool ranks elements by direct ticket count across all statuses (per-status breakdown, optional `since` on `updated`, id tie-break, zeros omitted unless `include_zero`, `limit` 20); a count is a signal, not a verdict; joins after slice 1.
- [Domain context link and structured ADR link](tickets/11-domain-context-link-and-structured-adr-link.md): No `context` or `adrs` fields: context is derived from owned code plus GLOSSARY-MAP.md; ADRs are plain markdown links in an optional `## Decisions` body section; nothing validated, scanned or returned.
- [Interface and Seams body sections](tickets/12-interface-and-seams-body-sections.md): Interface and Seams are a documented convention only (no scan or create_element scaffolding, soft ~10-line cap, not shown by `architecture`, read via get_item sections); documented in the tracker template and README; two preservation tests; no glossary terms.
- [Components prompt in ticket creation and review guidance](tickets/09-components-prompt-in-ticket-creation-and-review-guidance.md): Pure documentation: a 'Linking tickets' and 'Reviewing a change' paragraph in the template's `## Architecture` section (cap +8 lines, ~23 total) plus one linking sentence in the `owners` description; rides ticket 06's refresh patch; no doctor warning, a template-content unit test only.

## Not yet specified

- **Derived relationships**: Groma infers component-to-component relationships from symbols (supplied callbacks, HTTP calls). Ours seeds `uses` only between containers and otherwise relies on curation. Once symbol analysis and per-language plugins exist, decide what is derived, how derived rows are kept apart from authored ones, and how a rescan replaces only the derived part. Revisit after 0.2.0.
- **Curation helpers**: rename and combine of elements (Groma has `edit --id` and `--combine`; we rely on hand edits and rescan). Revisit if curation proves painful in real use.
- **ADR reverse lookup**: which elements does an ADR affect? ADRs stay plain markdown links in an element's optional `## Decisions` section, so this needs a structured link. Revisit only if real use asks for it.

## Out of scope

- A web viewer or diagram renderer for the architecture.
- Static export of the architecture (for example to a site or image).
- A PR-comment GitHub Action.
- Draft or flow records (Groma-style drafts and dynamic flows).
- Implementing any of this: the effort ends at a build spec.
