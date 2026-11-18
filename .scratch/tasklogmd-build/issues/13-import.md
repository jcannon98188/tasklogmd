# 13: Import

**What to build:** A repo on the backlog layout or scratch layout can move to the native format: `tasklog import <path>` converts it into `.tasklog/`, leaving the originals untouched. Spec reference: `.scratch/tasklogmd/spec.md`, section 9 (the full mapping), plus the fixture notes in section 12.

**Blocked by:** 05 Parser, scan and read tools

**Status:** ready-for-agent

- [ ] Given the scratch fixture (a copy of the wayfinder effort in this repo), when imported, then the output equals the checked-in golden tree, `issues/` links are rewritten to `tickets/`, and `imported_from` is set on every item.
- [ ] Given the backlog fixture, when imported, then milestones become efforts (unmilestoned tasks go to `backlog`), prefixes are dropped and numbers kept, and subtasks get fresh numbers with `parent-NNN` tags.
- [ ] Given dependencies, when resolved, then they resolve by numeric ID across active and archived tasks and across efforts; unresolvable ones are dropped from `blocked_by` and listed in the report.
- [ ] Given two backlog tasks sharing a numeric ID in one effort, when imported, then the second gets the next free number and the report flags it.
- [ ] Given status mappings (triage roles, `wontfix`, middle statuses, drafts, archive, completed), when imported, then each maps as the spec states, with original status names kept as tags where specified.
- [ ] Given a file that fails to parse, when imported, then it is skipped and reported, the rest completes in one staged move so no half-written efforts exist, and the exit code is 1.
- [ ] Given a second run, when imported again, then already-imported items are skipped untouched and hand edits survive; new source files are added.
- [ ] Given `--dry-run`, `--effort` and `--group-by none`, when run, then dry-run writes nothing and the other two behave as specified.
- [ ] Given a prefix change in the backlog fixture, when task files are located, then none are missed.
- [ ] Import runs in-process with no daemon and never modifies the source tree.
