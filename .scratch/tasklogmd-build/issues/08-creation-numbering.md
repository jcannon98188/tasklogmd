# 08: Creation and numbering

**What to build:** An agent can start a new body of work and add tickets to it: `create_effort` and `create_item` produce correctly formatted new files with `max + 1` numbering. Spec reference: `.scratch/tasklogmd/spec.md`, sections 3 and 5.

**Blocked by:** 06 Minimal-diff editor and write protocol

**Status:** ready-for-agent

- [ ] Given a new effort, when created, then `map.md` and `spec.md` exist with the fixed map headings, LF endings and canonical key order, and the map and spec IDs are returned.
- [ ] Given existing tickets, when one is created, then its number is `max + 1` over all files including conflicted ones, with no stored counters.
- [ ] Given `create_item` without `effort`, when called, then it fails `bad_request`.
- [ ] Given `blocked_by` and `tags`, when a ticket is created, then they are written normalized (lowercase tags, same-effort numbers or `effort/NN` across efforts).
- [ ] Given `type` omitted, when a ticket is created, then no `type` key is written.
- [ ] Given a title, when the file is named, then the slug is lowercase kebab-case derived from it and is never auto-renamed later.
- [ ] Given an effort that already exists, when `create_effort` is called, then it fails `bad_request` and changes nothing.
