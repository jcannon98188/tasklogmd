// Drift for the `architecture` tool: findings about how the element list and the file list disagree.
//
// Drift is the scan planner (`detect` + `plan`) run read-only over the same inputs as `scan_architecture`;
// `daemon/architecture-scan.ts` (`computeScan`) runs it and the tool maps `Plan.findings` through
// `planFindingToDrift` below. Nothing here computes drift itself.

import type { Finding, FindingCategory } from '../architecture/types.ts';

/** A finding as `architecture` and `scan_architecture` report it: `{category, id?, path?, detail}`. */
export interface DriftFinding {
  category: FindingCategory;
  /** Element slug, when the finding is about one element. */
  id?: string;
  /** Repo-relative path, when the finding is about one path. */
  path?: string;
  detail: string;
}

/** The planner's finding in the tool's shape (`element` becomes `id`, `message` becomes `detail`). */
export function planFindingToDrift(f: Finding): DriftFinding {
  return {
    category: f.category,
    ...(f.element !== undefined ? { id: f.element } : {}),
    ...(f.path !== undefined ? { path: f.path } : {}),
    detail: f.message,
  };
}
