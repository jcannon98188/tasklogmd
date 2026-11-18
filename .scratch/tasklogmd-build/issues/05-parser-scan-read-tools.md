# 05: Parser, scan and read tools

**What to build:** An agent can read a workspace: the daemon scans `.tasklog/`, builds the two-layer model (parsed-item store plus workspace index), and serves `get_item` and `list_items` with structured filters and paging. Spec reference: `.scratch/tasklogmd/spec.md`, sections 3, 4 (model), 5 (`list_items` and `get_item`) and 12 (fixtures). Text search is out of scope here; writes are out of scope.

**Blocked by:** 04 Walking skeleton

**Status:** ready-for-agent

- [ ] Given the native fixture workspace, when scanned, then every item is in the index with the right ID, kind, status, type, tags, `blocked_by` and ACs.
- [ ] Given an invalid file, when scanned, then it appears flagged invalid in listings and `get_item` on it fails `invalid_item`.
- [ ] Given duplicate Item IDs, when scanned, then both are kept, lookup by that ID fails `conflicted` listing both paths, and `workspace_status` counts them.
- [ ] Given an unknown frontmatter key, CRLF or LF endings, a UTF-8 BOM or unknown sections, when parsed, then all are preserved in the parse result.
- [ ] Given identical file bytes in two workspaces, when both are scanned, then they share one parse result in the store, which is evicted when no index references it.
- [ ] Given `list_items` with `effort`, `kind`, `status`, `type` and tag filters, when called, then results match and are ordered by effort then ticket number, each carrying `hash` and `flags`.
- [ ] Given `list_items` with `limit` above 200, when called, then it is capped at 200 and `total` is the pre-paging count; given the model version changes between pages, the next page fails `stale_cursor`.
- [ ] Given a request during the initial scan, when it waits more than about 5 s, then it fails with the retryable `indexing` error.
