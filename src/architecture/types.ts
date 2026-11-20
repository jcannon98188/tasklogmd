// Shared types of the pure `architecture` package. This file is the single source of these types: the
// daemon, the model and the planner import them from here. No imports, no I/O.

export type ElementKind = 'container' | 'component';
export type Review = 'proposed' | 'accepted';

/** A `uses` edge as stored in element front matter. `to` is a bare container slug. */
export interface Use {
  to: string;
  label?: string;
}

/** An element as the planner sees it: the parsed front matter of an existing element file. */
export interface Element {
  slug: string;
  kind: ElementKind;
  title: string;
  review: Review;
  /** Container slug; components only. */
  parent?: string;
  uses: Use[];
  /** Owned roots: repo-relative, forward slashes, no `./`, no trailing slash, `.` for the workspace root. */
  code: string[];
}

/** An element the structural detection proposes. Never carries `review` (new elements start `proposed`). */
export interface Candidate {
  kind: ElementKind;
  slug: string;
  title: string;
  /** Container slug; components only. */
  parent?: string;
  /** Owned roots (a container: its manifest directory; a component: its directory). */
  code: string[];
  /** Every listed file this candidate owns (longest-root rule, so nested elements' files excluded), sorted. */
  files: string[];
  /** Seeded from manifest references; containers only. */
  uses: Use[];
}

/** Why a path was left out of the proposals. `user` is added by the scan from the ignore file, not by detect. */
export type IgnoredReason = 'test' | 'fixture-template' | 'tooling' | 'not-workspace-member' | 'user';

export interface IgnoredEntry {
  path: string;
  reason: IgnoredReason;
}

/** Stable kebab-case drift categories. */
export type FindingCategory =
  | 'missing-path'
  | 'owns-no-code'
  | 'unowned-code'
  | 'parent-mismatch'
  | 'ambiguous-match'
  | 'possible-rename';

export interface Finding {
  category: FindingCategory;
  /** The element slug the finding is about, when it is about one. */
  element?: string;
  /** The repo-relative path the finding is about, when it is about one. */
  path?: string;
  message: string;
}

/** The pure result of planning a scan: what would be created, updated, left alone, skipped or reported. */
export interface Plan {
  created: Candidate[];
  updated: { slug: string; code: string[] }[];
  unchanged: string[];
  skipped: { slug: string; reason: string }[];
  findings: Finding[];
  ignored: IgnoredEntry[];
}

/** Input to `detect`: the workspace file list and the contents of every manifest in it. */
export interface DetectInput {
  /** Repo-relative file paths (git-tracked plus untracked-not-ignored, or built-in-ignore-filtered). */
  files: string[];
  /** Contents by path of every file for which `isManifestPath` is true. Missing entries are treated as unreadable. */
  manifests: Record<string, string>;
}

export interface Detection {
  /** Containers first, then components, each sorted by first `code` root. */
  candidates: Candidate[];
  ignored: IgnoredEntry[];
  /** Top-level directories (or `.` for loose root files) holding code that no container covers. Sorted. */
  unowned: string[];
}
