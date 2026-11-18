import type { ItemType, Kind, Status } from '../model/parse.ts';

/** One source file, parsed and mapped to the native vocabulary but not yet numbered or rendered. */
export interface Candidate {
  /** Source path relative to the workspace root, forward slashes: the `imported_from` value. */
  srcPath: string;
  kind: Kind;
  /** Target effort. */
  effort: string;
  /** The number the source asked for (tickets); null when it must be allocated. */
  wantNum: number | null;
  /** Whether the number must be allocated fresh even if free (backlog subtasks). */
  fresh: boolean;
  /** Cosmetic filename slug. */
  slug: string;
  title: string;
  status: Status;
  type?: ItemType;
  claimedBy?: string;
  tags: string[];
  created: string;
  updated: string;
  /** Raw dependency references, resolved by the layout's resolver. */
  refs: string[];
  /** Unknown frontmatter carried over verbatim (LF, one block per key). */
  extras: string[];
  /** Native body, ready to write (LF, no trailing newline requirement). */
  body: string;
  /** A short label for messages. */
  label: string;
}

export interface Assigned {
  effort: string;
  num: number;
}

export interface Warning {
  kind: 'dropped_dependency' | 'id_collision' | 'dropped_section' | 'dropped_value' | 'existing_effort' | 'not_overwritten' | 'ambiguous_dependency';
  source: string;
  message: string;
}

export interface LoadResult {
  candidates: Candidate[];
  skipped: Array<{ source: string; reason: string }>;
  notImported: Array<{ path: string; reason: string }>;
  warnings: Warning[];
  /**
   * Resolves one raw dependency reference of `from` to the candidate it points at (null when nothing matches,
   * 'ambiguous' when more than one does). Candidates are compared by identity.
   */
  resolve(ref: string, from: Candidate): Candidate | null | 'ambiguous';
}
