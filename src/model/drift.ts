// Drift for the `architecture` tool: findings about how the element list and the file list disagree.
//
// ============================== STUB, REPLACED BY SLICE 5 ==============================
// `computeDrift` is the single seam between the `architecture` tool and the scan planner. Until slice 5
// (scan apply) lands it derives only what the element index and the file list alone allow:
//   - `missing-path`: an element root (other than `.`) that no listed file equals or lies under;
//   - `unowned-code`: code files no element owns, one finding per shallowest directory holding no element root.
// Slice 5 swaps the body for "run the planner (`detect` + `plan`) read-only over the same inputs and map its
// `Plan.findings` (`element` -> `id`, `message` -> `detail`) to `DriftFinding`s", which adds `owns-no-code`,
// `parent-mismatch`, `ambiguous-match` and `possible-rename`. The signature and result shape stay as they are.
// =======================================================================================

import { isCodeFile } from '../architecture/detect.ts';
import type { Element, FindingCategory } from '../architecture/types.ts';
import { ownersOfPath } from './architecture.ts';

/** A finding as `architecture` and `scan_architecture` report it: `{category, id?, path?, detail}`. */
export interface DriftFinding {
  category: FindingCategory;
  /** Element slug, when the finding is about one element. */
  id?: string;
  /** Repo-relative path, when the finding is about one path. */
  path?: string;
  detail: string;
}

const CATEGORY_ORDER: FindingCategory[] = ['missing-path', 'owns-no-code', 'unowned-code', 'parent-mismatch', 'ambiguous-match', 'possible-rename'];

const exists = (files: string[], root: string): boolean => files.some((f) => f === root || f.startsWith(`${root}/`));

/** Findings in a stable order: by category, then element id, then path. */
export function sortFindings(findings: DriftFinding[]): DriftFinding[] {
  const cmp = (a?: string, b?: string): number => (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;
  return [...findings].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || cmp(a.id, b.id) || cmp(a.path, b.path));
}

/** `files` are repo-relative, forward slashes, as the scan lists them. */
export function computeDrift(elements: Element[], files: string[]): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const roots = elements.flatMap((e) => e.code);

  for (const el of elements) {
    for (const root of el.code) {
      if (root !== '.' && !exists(files, root)) findings.push({ category: 'missing-path', id: el.slug, path: root, detail: `${el.slug} owns ${root}, which does not exist` });
    }
  }

  // The shallowest directory prefix of a file that has no element root at or below it; a root-level file is its own group.
  const groups = new Map<string, number>();
  for (const f of files) {
    if (!isCodeFile(f) || ownersOfPath(elements, f).length > 0) continue;
    const segs = f.split('/');
    let key = f;
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      if (!roots.some((r) => r === prefix || r.startsWith(`${prefix}/`))) {
        key = prefix;
        break;
      }
    }
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [path, n] of groups) {
    const where = files.includes(path) ? '' : ` under ${path}`;
    findings.push({ category: 'unowned-code', path, detail: `${n} code file${n === 1 ? '' : 's'}${where} ${n === 1 ? 'has' : 'have'} no owner` });
  }
  return sortFindings(findings);
}
