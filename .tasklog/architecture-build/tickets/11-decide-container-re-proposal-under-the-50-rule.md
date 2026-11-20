---
kind: ticket
title: "Decide: container re-proposal under the 50% rule"
status: open
type: grilling
created: 2026-11-20
updated: 2026-11-20
---

## Question

Found in slices 4 and 5. A candidate container excludes files owned by its component candidates, but an existing container counts every file under its roots that no existing element claims. After two or more of a container's components are hand-deleted (or many new component directories appear at once), the container owns more than half the files, fails the 50% match on both sides, and is proposed as a new element. If the old container owns `.`, the tie means every later scan proposes another one (seen as `app-10`). tasklog-architecture/02 states the rule this way, so it needs a decision before 0.2.0: change how files are counted for the match (for example match containers on manifest directory, or count only files not owned by any other existing element), or accept it and document it. Decide, then say which tests change.
