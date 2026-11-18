# 06: Minimal-diff editor and write protocol

**What to build:** An agent can edit items safely: field, section and AC edit tools that patch the file in place as a minimal diff, under hash-verified, temp-and-rename writes with a per-file queue. Spec reference: `.scratch/tasklogmd/spec.md`, sections 3 (numbering and edits), 4 (write protocol), 5 (generic edit tools) and 12 (concurrency). Tools: `set_fields`, `replace_section`, `append_to_section`, `add_ac`, `edit_ac`, `toggle_ac`, `remove_ac`. Includes the test hook that pauses a write between hash verification and rename.

**Blocked by:** 05 Parser, scan and read tools

**Status:** ready-for-agent

- [ ] Given a one-field edit, when written, then the file diff is exactly one line, byte-exact, with CRLF, key order, comments, quoting, blank lines and unknown sections preserved.
- [ ] Given a stale hash, when a content edit is sent, then it fails `stale_hash` and the file is unchanged.
- [ ] Given two writers racing one file, when both write, then exactly one succeeds and the other gets `stale_hash`.
- [ ] Given an external edit between a client's read and write, when the client writes, then it is detected as stale.
- [ ] Given interleaved edits to different ACs of one ticket, when queued, then both apply in order through the per-file queue.
- [ ] Given a failure mid-write, when it occurs, then the original file is whole and no temp file remains; leftover temp files are swept at daemon start.
- [ ] Given a hand-added AC without a number, when the next write occurs, then it gets the next free number; given an invalid or conflicted item, writes are refused.
- [ ] `set_fields` cannot set `status` except `reopen: true`; tags are normalized to lowercase `[a-z0-9-]`.
- [ ] Given the seeded randomized run, when N parallel clients apply random operations to a small workspace, then the file on disk always parses and equals a rescan.
- [ ] Every write returns the new `hash` and registers the parse result in the store.
