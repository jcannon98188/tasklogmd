---
kind: ticket
title: Search
status: resolved
blocked_by: [5]
created: 2026-11-18
updated: 2026-11-18
imported_from: .scratch/tasklogmd-build/issues/10-search.md
---

## Question

**What to build:** An agent can find items by text and tags: `list_items` gains `text`, `tags_none` and `snippet`, with tokens computed in the parsed-item store and linear-scan queries. Spec reference: `.scratch/tasklogmd/spec.md`, section 6.



- [x] Given a title with diacritics, when searched without them, then it matches (case- and diacritic-folded).
- [x] Given `"exact phrase"` and `-term`, when queried, then the phrase and exclusion are honoured against the stored token sequence; multi-word queries are an implicit AND with whole-word or prefix matching.
- [x] Given identifier text such as `list_items` or `07-daemon`, when searched by a part or the whole, then it matches.
- [x] Given a title hit and a body hit, when ranked, then the title hit sorts first, ties break by effort then ticket number, and `matched_in` lists the fields that hit.
- [x] Given `tags_all`, `tags_any` and `tags_none`, when combined with each other and with the structured filters and `text`, then they AND together; tags match exactly after lowercasing.
- [x] Given `text`, when searched, then the title, Item ID, tags and every body section (including `## Comments` and unknown sections) are covered, and frontmatter fields other than `title` and `tags` are not.
- [x] Given `snippet: true`, when called with `text`, then each result carries an excerpt of about 160 characters; it is off by default.
- [x] Tokens are computed once per distinct file content in the shared store and nothing is persisted to disk.

## Comments

**Module.** `src/model/search.ts` (pure): `tokenize`, `parseQuery`, `matchItem`, `makeSnippet`, `buildSearchData`. `ParsedItemStore.acquire` computes `SearchData` once per distinct content and `store.search(hash)` returns it (null for invalid files); nothing is persisted. The Item ID is not in the store (it comes from the path), so it is tokenised at query time. `WorkspaceIndex.list` gained `text`, `snippet`; rows gain `matched_in` (always present, `[]` without `text`) and `snippet?`. MCP `list_items` schema gained `text`, `snippet` (`tags_none` already existed from 05).

**Decisions.** Fields: title, id, tags, question, answer, body (preamble, Acceptance criteria, Comments, unknown sections). Weights title 100 > tags 40 > id 30 > question/answer 10 > body 1; a term scores its best field, scores sum over terms; stable sort keeps effort-then-number for ties. Words match whole-word or prefix; `"phrases"` match the stored token sequence exactly (whole words); identifiers (`list_items`, `07-daemon`, `a/03`) match by whole (prefix) or by their part sequence. `-term` / `-"phrase"` exclude. A query with no usable token is ignored. Invalid items never match `text`. The cursor key includes the query text. Snippet: ~160 chars around the first body hit, else start of body.
