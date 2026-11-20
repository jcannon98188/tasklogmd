---
kind: ticket
title: Owner lookup by file path
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

Groma resolves every source file to an owning component, so a task's modified files point at what it touched. Our elements own directories, and the ticket owns the `components` link, but an agent starting a ticket has no way to ask "which elements own these paths?". Decide whether to add an owner lookup and its shape: an optional `paths` argument on the `architecture` tool, or a separate tool; the result (owning elements by longest matching owned path, `unowned` for the rest, nothing else); how it relates to Touched component (read-only suggestion, never auto-written to `components`); path normalisation rules shared with ticket 02 and 03; and the test cases to add to ticket 04's integration layer. Name the slice it joins (probably slice 2) and any glossary term needed.
