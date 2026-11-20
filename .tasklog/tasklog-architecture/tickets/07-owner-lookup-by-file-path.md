---
kind: ticket
title: Owner lookup by file path
status: resolved
type: grilling
created: 2026-11-20
updated: 2026-11-20T20:52:43Z
---

## Question

Groma resolves every source file to an owning component, so a task's modified files point at what it touched. Our elements own directories, and the ticket owns the `components` link, but an agent starting a ticket has no way to ask "which elements own these paths?". Decide whether to add an owner lookup and its shape: an optional `paths` argument on the `architecture` tool, or a separate tool; the result (owning elements by longest matching owned path, `unowned` for the rest, nothing else); how it relates to Touched component (read-only suggestion, never auto-written to `components`); path normalisation rules shared with ticket 02 and 03; and the test cases to add to ticket 04's integration layer. Name the slice it joins (probably slice 2) and any glossary term needed.

## Next

Nothing is left to decide. The two Still to do patches (derived relationships, curation helpers) stay in the fog until after 0.2.0.

## Answer

Settled by grilling with the user (all nine recommendations accepted, in two rounds). Builds on tickets 02, 03, 05 and 06. New glossary term: Owner.

### Tool
A new read-only MCP tool `owners` taking `paths: string[]`. It reads only the index of element `code` roots: no file listing, git, scan or drift. It is a pure function in `src/model/architecture.ts` with a thin registration in `src/daemon/architecture-tools.ts`. No CLI command in 0.2.0.

### Result
```
{ owners: [{id, kind, title, paths: [<normalised input paths>]}],
  unowned: [<paths>] }
```
- Grouped by element in input order; `id` is the element slug. Each entry carries only `id`, `kind`, `title`, `paths`.
- Every input path appears once, under one element or in `unowned`, except on a tie.
- Ownership is ticket 02's longest matching root on whole path segments, so a path under a component's root goes to the component, not its container. `src/daemon-x` does not match root `src/daemon`.
- If two elements tie on the longest root, the path is listed under both. No tie-break, no extra flag.

### Normalisation (one pure helper shared with the scan, ticket 03 `code` rules)
- Backslashes become `/`, leading `./` dropped, trailing slashes dropped, `a//b` collapses; an absolute path under the workspace root becomes repo-relative.
- Case-sensitive on every platform; existence is never checked, so deleted files from a diff still resolve; duplicates collapse.
- A directory path works; an ancestor-only path (`src` with roots `src/a`, `src/b`) is `unowned`; `.` matches only a root of `.`.
- An absolute path outside the workspace, or one escaping with `..`, fails the whole call with `bad_request` naming the path.

### Limits and errors
`paths` must be a non-empty array of at most 500 strings, else `bad_request`. No new error codes. An empty Architecture sends every path to `unowned`.

### Relation to Touched component
Read-only suggestion. It never writes `components`, takes no ticket id and does not read the ticket. The agent or human sets `components` with `set_fields`; the ticket still owns the link.

### Slice
Slice 2, Element tools, beside `create_element` and `architecture`. It needs slice 1 only, so it works on a hand-built Architecture. Build order, blockers and critical path from ticket 05 are unchanged.

### Glossary and onboarding
`GLOSSARY.md` gains **Owner** (done). The `owners` tool description and the `## Architecture` section of the tracker template each get one line: before setting `components`, ask `owners` which elements own the files you will touch. No ADR.

### Tests (ticket 04 integration layer, table rows over a synthetic Architecture)
Fixture: container `daemon` with roots `src/daemon` and `src/shared`, component `daemon-tools` with root `src/daemon/tools`, and a second container with root `.`.
1. A file in the component's root goes to the component.
2. A file in the container outside any component goes to the container.
3. A path under no root is `unowned`.
4. Two elements with the identical longest root list the path under both.
5. A sibling dir with a shared prefix (`src/daemon-x`) does not match `src/daemon`.
6. Normalisation: backslashes, `./`, trailing slash, absolute path under the workspace, Windows drive-letter paths.
7. A `..` escape or an absolute path outside the workspace fails `bad_request`.
8. A directory path equal to a root resolves to it; an ancestor-only path is `unowned`.
9. An empty Architecture sends everything to `unowned`.
10. An empty or oversize `paths` array fails `bad_request`.
11. Duplicate inputs collapse to one.
12. The lookup writes nothing: file hashes are unchanged afterwards.

Unit layer: one table test for the shared normalisation helper, including a case-sensitivity row (`Src/daemon` does not match `src/daemon`).
