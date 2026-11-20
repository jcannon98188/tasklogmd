---
kind: ticket
title: Scan match and merge algorithm
status: open
type: grilling
blocked_by: [1]
created: 2026-11-20
updated: 2026-11-20
---

## Question

Given existing elements with owned `code` paths and a fresh scan, how exactly are they matched (path overlap rules), and what happens on renames, splits, merges, and ignored paths? Only `code` is rewritten on a rescan and matching is by owned code, never by name. Define the algorithm and its edge cases.
