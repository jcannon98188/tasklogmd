---
kind: ticket
title: "Hotspots: ranking elements by ticket history"
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

Elements touched by many tickets, resolved ones included, are candidates for the `codebase-design` skill's search for deepening opportunities. `architecture` counts only direct open and claimed tickets (ticket 03), and `list_items` with the `components` filter lists one element's tickets. Decide whether to add a hotspot view: its home (an option on `architecture`, a field, or a separate tool); what is counted (all statuses, direct only, optional date window); the result shape and ordering, including ties and elements with zero tickets; cost on a large workspace; and what it must not claim (a count is a signal, not a quality judgement). Name the slice it joins or whether it is a post-0.2.0 follow-up, and the test cases to add to ticket 04's integration layer.
