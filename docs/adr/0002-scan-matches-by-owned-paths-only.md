# Scan matches by owned paths only, never by name, and never overwrites curated content

The architecture scan decides whether a proposed container or component is an existing element by comparing the files each side owns, never by comparing names or slugs. A pair matches only when the same kind shares at least 50% of both sides' files; pairs are taken from the largest overlap down, one-to-one, and a tie matches neither and is reported as ambiguous. A matched element has only its overlapping `code` roots rewritten, and an unchanged element is not written. The scan never changes `review`, descriptions, `uses`, `parent` or any other section, never deletes an element, and never fixes drift: a missing path, a parent mismatch or a possible rename is reported as a finding.

## Considered Options

- **Match by title or slug:** a renamed directory or retitled element would be duplicated or silently merged into the wrong element, and a curator's edited title would break the link to the code.
- **Rewrite elements from the scan on every run:** the picture would always equal the repo, but every curated Description, Responsibilities, `uses` and review decision would be lost on the first rescan.
- **Guess renames and fix drift automatically:** a wrong guess destroys curated work with no review step, and in a structural scan a moved directory is indistinguishable from a deleted one plus a new one.

## Consequences

- A renamed directory shows as a new `proposed` element plus a `missing-path` finding (with an optional `possible-rename` hint) on the old one; the curator decides what to keep.
- Titles and slugs are free for humans to edit; slugs stay permanent identifiers.
- An unchanged repo produces zero writes on rescan, so scans are safe to run routinely.
- Stale hashes are skipped as "changed during scan", never retried or overwritten, because a curator's edit always wins.
