# 10: Search

**What to build:** An agent can find items by text and tags: `list_items` gains `text`, `tags_none` and `snippet`, with tokens computed in the parsed-item store and linear-scan queries. Spec reference: `.scratch/tasklogmd/spec.md`, section 6.

**Blocked by:** 05 Parser, scan and read tools

**Status:** ready-for-agent

- [ ] Given a title with diacritics, when searched without them, then it matches (case- and diacritic-folded).
- [ ] Given `"exact phrase"` and `-term`, when queried, then the phrase and exclusion are honoured against the stored token sequence; multi-word queries are an implicit AND with whole-word or prefix matching.
- [ ] Given identifier text such as `list_items` or `07-daemon`, when searched by a part or the whole, then it matches.
- [ ] Given a title hit and a body hit, when ranked, then the title hit sorts first, ties break by effort then ticket number, and `matched_in` lists the fields that hit.
- [ ] Given `tags_all`, `tags_any` and `tags_none`, when combined with each other and with the structured filters and `text`, then they AND together; tags match exactly after lowercasing.
- [ ] Given `text`, when searched, then the title, Item ID, tags and every body section (including `## Comments` and unknown sections) are covered, and frontmatter fields other than `title` and `tags` are not.
- [ ] Given `snippet: true`, when called with `text`, then each result carries an excerpt of about 160 characters; it is off by default.
- [ ] Tokens are computed once per distinct file content in the shared store and nothing is persisted to disk.
