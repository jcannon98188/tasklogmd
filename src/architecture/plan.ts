// Pure match-and-merge planner: existing elements plus detected candidates in, a Plan out. No I/O, no daemon
// imports. Candidates are matched to elements by owned files, never by name (spec: "Match and merge").

import { isCodeFile } from './detect.ts';
import { globToRegExp, isUnder, normalizePath } from './paths.ts';
import type { Candidate, Element, Finding, FindingCategory, IgnoredEntry, Plan } from './types.ts';

export interface PlanInput {
  /** Existing elements, parsed from their files. */
  existing: Element[];
  /** `Detection.candidates`. */
  candidates: Candidate[];
  /** The scan's file list; decides which owned roots are missing or own no code. */
  files: string[];
  /** `Detection.ignored`, passed through to the plan. */
  ignored?: IgnoredEntry[];
  /** `Detection.unowned`. */
  unowned?: string[];
  /** Lines of `.tasklog/architecture/ignore` (one path or glob each; blanks and `#` comments allowed). */
  userIgnore?: string[];
}

const CATEGORY_ORDER: FindingCategory[] = [
  'missing-path',
  'owns-no-code',
  'unowned-code',
  'parent-mismatch',
  'ambiguous-match',
  'possible-rename',
];

/** Builds a predicate for the ignore file: a path matches when a rule matches it or any ancestor directory. */
function userIgnoreMatcher(lines: string[]): (path: string) => boolean {
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => globToRegExp(normalizePath(l)));
  return (path) => {
    if (rules.length === 0) return false;
    const segs = path.split('/');
    for (let n = segs.length; n >= 1; n--) {
      const prefix = segs.slice(0, n).join('/');
      if (rules.some((r) => r.test(prefix))) return true;
    }
    return false;
  };
}

/** Files owned by each element: the element(s) with the longest matching root own a file. */
function ownedFiles(elements: Element[], files: string[]): Map<string, Set<string>> {
  const owned = new Map<string, Set<string>>(elements.map((e) => [e.slug, new Set<string>()]));
  const rootLen = (r: string) => (r === '.' ? 0 : r.length);
  for (const f of files) {
    let best = -1;
    let owners: string[] = [];
    for (const e of elements) {
      let len = -1;
      for (const r of e.code) if (isUnder(f, r)) len = Math.max(len, rootLen(r));
      if (len < 0) continue;
      if (len > best) {
        best = len;
        owners = [e.slug];
      } else if (len === best) owners.push(e.slug);
    }
    for (const s of owners) owned.get(s)!.add(f);
  }
  return owned;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && new Set([...a, ...b]).size === a.length;
}

export function plan(input: PlanInput): Plan {
  const { existing, candidates, files } = input;
  const isUserIgnored = userIgnoreMatcher(input.userIgnore ?? []);
  // Containers are matched at container level only: components are ignored on both sides. Components keep the
  // all-elements rule.
  const allOwned = ownedFiles(existing, files);
  const containerOwned = ownedFiles(
    existing.filter((e) => e.kind === 'container'),
    files,
  );
  const ownedOf = (e: Element): Set<string> => (e.kind === 'container' ? containerOwned : allOwned).get(e.slug)!;
  const candFiles = new Map<Candidate, string[]>(candidates.map((c) => [c, c.files]));
  const candContainers = candidates.filter((c) => c.kind === 'container');
  if (candContainers.length > 0) {
    const asElements: Element[] = candContainers.map((c, i) => ({
      slug: String(i),
      kind: 'container',
      title: c.title,
      review: 'proposed',
      uses: [],
      code: c.code,
    }));
    const byCand = ownedFiles(asElements, files);
    candContainers.forEach((c, i) => candFiles.set(c, [...byCand.get(String(i))!].sort()));
  }

  // 1. Candidate/element pairs that pass the 50% rule on both sides, same kind only.
  interface Pair {
    ci: number;
    el: Element;
    shared: number;
  }
  const pairs: Pair[] = [];
  candidates.forEach((c, ci) => {
    for (const el of existing) {
      if (el.kind !== c.kind) continue;
      const own = ownedOf(el);
      const cfiles = candFiles.get(c)!;
      let shared = 0;
      for (const f of cfiles) if (own.has(f)) shared++;
      if (shared === 0) continue;
      if (shared * 2 >= cfiles.length && shared * 2 >= own.size) pairs.push({ ci, el, shared });
    }
  });

  // 2. Take pairs from the largest shared count down, one-to-one. Equal competing pairs match neither.
  const matchOf = new Map<number, Element>(); // candidate index -> element
  const takenEl = new Set<string>();
  const blockedC = new Set<number>();
  const blockedEl = new Set<string>();
  const ambiguous: Pair[] = [];
  const counts = [...new Set(pairs.map((p) => p.shared))].sort((a, b) => b - a);
  for (const n of counts) {
    const group = pairs.filter(
      (p) => p.shared === n && !matchOf.has(p.ci) && !takenEl.has(p.el.slug) && !blockedC.has(p.ci) && !blockedEl.has(p.el.slug),
    );
    for (const p of group) {
      const conflict = group.some((q) => q !== p && (q.ci === p.ci || q.el.slug === p.el.slug));
      if (conflict) ambiguous.push(p);
    }
    for (const p of ambiguous) {
      blockedC.add(p.ci);
      blockedEl.add(p.el.slug);
    }
    for (const p of group) {
      if (blockedC.has(p.ci) || blockedEl.has(p.el.slug)) continue;
      matchOf.set(p.ci, p.el);
      takenEl.add(p.el.slug);
    }
  }

  // 3. Matched elements: replace only overlapping roots; unmatched candidates become proposals.
  const updated: Plan['updated'] = [];
  const created: Candidate[] = [];
  const ignored: IgnoredEntry[] = [...(input.ignored ?? [])];
  const findings: Finding[] = [];
  const candToElSlug = new Map<string, string>();
  for (const [ci, el] of matchOf) candToElSlug.set(candidates[ci]!.slug, el.slug);
  const changed = new Set<string>();

  candidates.forEach((c, ci) => {
    const el = matchOf.get(ci);
    if (!el) {
      const hit = c.code.find((r) => isUserIgnored(r));
      if (hit !== undefined) ignored.push({ path: hit, reason: 'user' });
      else created.push(c);
      return;
    }
    const sharedFiles = candFiles.get(c)!.filter((f) => ownedOf(el).has(f));
    const code: string[] = [];
    let inserted = false;
    for (const r of el.code) {
      if (sharedFiles.some((f) => isUnder(f, r))) {
        if (!inserted) code.push(...c.code);
        inserted = true;
      } else code.push(r);
    }
    if (!inserted) code.push(...c.code);
    const next = [...new Set(code)];
    if (!sameSet(next, el.code)) {
      updated.push({ slug: el.slug, code: next });
      changed.add(el.slug);
    }
    if (c.kind === 'component' && el.parent !== undefined && c.parent !== undefined) {
      const resolved = candToElSlug.get(c.parent) ?? c.parent;
      if (resolved !== el.parent) {
        findings.push({
          category: 'parent-mismatch',
          element: el.slug,
          path: c.code[0]!,
          message: `Element ${el.slug} has parent ${el.parent} but its code now sits under ${resolved}. The parent was not changed.`,
        });
      }
    }
  });

  // 4. Drift on existing elements: missing roots and roots owning no code.
  const missingByEl = new Map<string, string[]>();
  for (const el of existing) {
    for (const r of el.code) {
      const under = files.filter((f) => isUnder(f, r));
      if (under.length === 0) {
        findings.push({ category: 'missing-path', element: el.slug, path: r, message: `Element ${el.slug} owns ${r}, but no files were found there.` });
        missingByEl.set(el.slug, [...(missingByEl.get(el.slug) ?? []), r]);
      } else if (!under.some(isCodeFile)) {
        findings.push({ category: 'owns-no-code', element: el.slug, path: r, message: `Element ${el.slug} owns ${r}, which holds no code files.` });
      }
    }
  }

  // 5. Ambiguous matches and rename hints.
  for (const p of ambiguous) {
    const c = candidates[p.ci]!;
    findings.push({
      category: 'ambiguous-match',
      element: p.el.slug,
      path: c.code[0],
      message: `Candidate ${c.slug} (${c.code[0]}) ties with another for element ${p.el.slug}; neither was matched and the candidate is proposed.`,
    });
  }
  for (const el of existing) {
    for (const root of missingByEl.get(el.slug) ?? []) {
      const base = basenameOf(root);
      if (base === '.') continue;
      for (const c of created) {
        const hit = c.code.find((r) => c.kind === el.kind && basenameOf(r) === base);
        if (hit !== undefined) {
          findings.push({
            category: 'possible-rename',
            element: el.slug,
            path: hit,
            message: `${hit} may be a rename of ${root} (element ${el.slug}). Nothing was changed.`,
          });
        }
      }
    }
  }

  // 6. Unowned code: a detected directory is reported only while some of its code files sit under no element root.
  const ignoredPaths = ignored.map((i) => i.path);
  const hasUncoveredCode = (dir: string): boolean =>
    files.some(
      (f) =>
        isCodeFile(f) &&
        (dir === '.' ? !f.includes('/') : isUnder(f, dir)) &&
        !existing.some((e) => e.code.some((r) => isUnder(f, r))) &&
        !ignoredPaths.some((i) => isUnder(f, i)),
    );

  for (const u of input.unowned ?? []) {
    if (!hasUncoveredCode(u)) continue;
    if (isUserIgnored(u)) {
      ignored.push({ path: u, reason: 'user' });
      continue;
    }
    findings.push({ category: 'unowned-code', path: u, message: `Code in ${u} is not owned by any element.` });
  }

  const order = (f: Finding) => CATEGORY_ORDER.indexOf(f.category);
  findings.sort(
    (a, b) =>
      order(a) - order(b) || (a.element ?? '').localeCompare(b.element ?? '') || (a.path ?? '').localeCompare(b.path ?? ''),
  );
  ignored.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));

  return {
    created,
    updated,
    unchanged: existing.map((e) => e.slug).filter((s) => !changed.has(s)).sort(),
    skipped: [],
    findings,
    ignored,
  };
}
