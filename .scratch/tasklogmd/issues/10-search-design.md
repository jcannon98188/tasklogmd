Type: grilling
Status: resolved
Blocked by: 06

## Question

Design search for `list_items`. Decide the tag query syntax (AND/OR, negation), what text is indexed (title, `## Question`, `## Answer`, ACs, other sections), tokenisation and ranking, whether the index lives in the shared parsed-item store, and the result limits and paging.

## Answer

Settled by grilling with the user (all six recommendations accepted). No new glossary terms.

> Amends the workflow mapping (ticket 06): `list_items` gains `tags_none` and `snippet`, its result gains `total`, `matched_in` and an optional `snippet`, and the error list gains `stale_cursor`.

**Tag filters**
- Flat, ANDed parameters: `tags_all` (every tag present), `tags_any` (at least one present), `tags_none` (no tag present). There is no expression language, no nested OR groups and no prefix or wildcard tag matching in v1.
- Tags are lowercased on write and on query and matched exactly.
- Tag filters combine with the other structured filters (`effort`, `kind`, `status`, `type`) and with `text` by AND.

**What `text` searches**
- The title, the Item ID, the tags, and every body section: `## Question`, `## Answer`, ACs, `## Comments` and any unknown section.
- Frontmatter fields other than `title` and `tags` (`claimed_by`, `blocked_by`, `status` and so on) are not searched; they have structured filters.

**Tokenisation and matching**
- Lowercase, Unicode-normalise and fold diacritics, split on non-alphanumerics. Identifier-like strings (`list_items`, `07-daemon`) are also kept as whole tokens in addition to their parts.
- Matching is whole-word or prefix. No stemming, fuzzy matching or stop-word list.
- A multi-word query is an implicit AND. `"double quotes"` means an exact phrase, and a leading `-` excludes a term. Phrases and exclusions are checked against the stored token sequence; there is no regex engine.

**Ranking and ordering**
- With `text`: a simple field-weighted score (title hit > tag hit > `## Question` or `## Answer` hit > other body hit, with more matched terms scoring higher). Ties break by effort, then ticket number. No BM25 or IDF.
- Without `text`: effort, then ticket number, the same order as the frontier.
- Each result carries `matched_in` (the field names that hit) so an agent can see why it was returned.

**Where the index lives**
- In the shared parsed-item store (ticket 06's amendment), as per-file token data computed once at parse time and keyed by content hash. A query is a linear scan over the workspace's items; there is no separate inverted index and nothing is persisted to disk. It is rebuilt from the files like the rest of the model.

**Limits and paging**
- `limit` defaults to 50 with a hard cap of 200. The result carries an opaque `cursor` and `total` (the match count before paging). Results are summaries only, never bodies.
- `snippet: true` (only meaningful with `text`) adds a short matched-text excerpt of about 160 characters per result. It is off by default so responses stay small.
- The cursor is offset-based and tied to the model version. A stale cursor returns the retryable error `stale_cursor` rather than silently shifting results.

**Resulting `list_items` signature**
`effort?, kind?, status?, type?, tags_all?, tags_any?, tags_none?, text?, snippet?, limit?, cursor?`, returning `items[]` (the 06 summary fields plus `matched_in` and optional `snippet`), `total` and `cursor?`.
