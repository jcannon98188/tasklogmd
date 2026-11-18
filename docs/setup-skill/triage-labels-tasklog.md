# Triage Labels

The skills speak in terms of five canonical triage roles. In TaskLog the roles are **tags** on an item (set with the `triage` tool or `set_fields`), not a `Status:` line.

| Label in mattpocock/skills | Tag in TaskLog    | Meaning                                  |
| -------------------------- | ----------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human` | Requires human implementation            |
| `wontfix`                  | `wontfix`         | Will not be actioned                     |

An item carries exactly one of these state tags (plus at most one category tag, `bug` or `enhancement`). Use `triage(id, state, category, note)`: it replaces the old tag instead of adding a second one. `wontfix` is a tag plus `status: closed`, with the reason in `## Answer`.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding tag from this table.
