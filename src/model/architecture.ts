// Pure architecture reads over the element list: owner lookup, the compact tree and its scoping. No I/O.

import type { Element, ElementKind } from '../architecture/types.ts';
import { TaskLogError } from '../errors.ts';
import { normalizeRepoPath } from './repo-path.ts';

const bad = (message: string, details?: Record<string, unknown>): TaskLogError => new TaskLogError('bad_request', { message, details });

export const MAX_OWNER_PATHS = 500;

/** One ticket's link into the architecture, as the tree counts it. */
export interface TicketLink {
  /** The ticket's Item ID. */
  id: string;
  status?: string;
  components: string[];
}

export interface TreeNode {
  id: string;
  title: string;
  review: string;
  uses: Array<{ to: string; label?: string }>;
  tickets: { open: number; claimed: number };
  /** Containers only; absent at `depth: 0`. */
  children?: TreeNode[];
}

export interface ArchitectureWarning {
  /** Item ID carrying the dangling reference: a ticket or an element. */
  id: string;
  field: 'components' | 'parent' | 'uses';
  /** The slug that names nothing (or, for `parent`, no container). */
  slug: string;
  detail: string;
}

/** Dangling references: tickets naming unknown elements, elements with a missing or non-container parent or an unknown `uses` target. */
export function danglingWarnings(elements: Element[], tickets: TicketLink[]): ArchitectureWarning[] {
  const bySlug = new Map(elements.map((e) => [e.slug, e]));
  const out: ArchitectureWarning[] = [];
  for (const el of elements) {
    if (el.parent !== undefined && bySlug.get(el.parent)?.kind !== 'container') {
      out.push({ id: `architecture/${el.slug}`, field: 'parent', slug: el.parent, detail: `${el.slug} has parent "${el.parent}", which is not a container` });
    }
    for (const u of el.uses) {
      if (!bySlug.has(u.to)) out.push({ id: `architecture/${el.slug}`, field: 'uses', slug: u.to, detail: `${el.slug} uses "${u.to}", which is not an element` });
    }
  }
  for (const t of tickets) {
    for (const slug of t.components) {
      if (!bySlug.has(slug)) out.push({ id: t.id, field: 'components', slug, detail: `ticket ${t.id} links "${slug}", which is not an element` });
    }
  }
  return out;
}

/**
 * The compact tree: containers (slug order) with their components as children, direct open/claimed ticket counts,
 * no bodies, no `code`. A component whose parent is missing or not a container is left out (it is a warning).
 */
export function buildTree(elements: Element[], tickets: TicketLink[]): TreeNode[] {
  const counts = new Map<string, { open: number; claimed: number }>();
  for (const t of tickets) {
    if (t.status !== 'open' && t.status !== 'claimed') continue;
    for (const slug of t.components) {
      const c = counts.get(slug) ?? { open: 0, claimed: 0 };
      c[t.status]++;
      counts.set(slug, c);
    }
  }
  const node = (e: Element): TreeNode => ({
    id: e.slug,
    title: e.title,
    review: e.review,
    uses: e.uses.map((u) => (u.label !== undefined ? { to: u.to, label: u.label } : { to: u.to })),
    tickets: counts.get(e.slug) ?? { open: 0, claimed: 0 },
  });
  return elements
    .filter((e) => e.kind === 'container')
    .map((c) => ({ ...node(c), children: elements.filter((x) => x.kind === 'component' && x.parent === c.slug).map(node) }));
}

/** Scopes a full tree to `root`: a container's subtree, or a component's parent stub holding only that component. Also returns the slugs inside the subtree. */
export function scopeTree(tree: TreeNode[], elements: Element[], root: string): { tree: TreeNode[]; slugs: Set<string>; stub: boolean } {
  const el = elements.find((e) => e.slug === root);
  if (!el) throw new TaskLogError('not_found', { message: `No element "${root}"; check slugs with the architecture tool.`, details: { root } });
  if (el.kind === 'container') {
    const kids = elements.filter((x) => x.kind === 'component' && x.parent === root).map((x) => x.slug);
    return { tree: tree.filter((n) => n.id === root), slugs: new Set([root, ...kids]), stub: false };
  }
  const parent = tree.find((n) => n.id === el.parent);
  const child = parent?.children?.find((c) => c.id === root);
  return { tree: parent && child ? [{ ...parent, children: [child] }] : [], slugs: new Set([root]), stub: true };
}

/** `depth: 0` drops children from every container. */
export const applyDepth = (tree: TreeNode[], depth: 0 | 1): TreeNode[] => (depth === 1 ? tree : tree.map(({ children: _c, ...n }) => n));

/**
 * Filters findings to a scoped subtree: kept when the finding's `id` is in `slugs`, or its `path` is owned (longest
 * root) by an element in `slugs`. `unowned-code` is dropped.
 */
export function filterFindings<F extends { category: string; id?: string; path?: string }>(findings: F[], elements: Element[], slugs: Set<string>): F[] {
  return findings.filter((f) => {
    if (f.category === 'unowned-code') return false;
    if (f.id !== undefined && slugs.has(f.id)) return true;
    if (f.path === undefined) return false;
    const path = normalizeRepoPath(f.path);
    return path !== null && ownersOfPath(elements, path).some((o) => slugs.has(o.slug));
  });
}

/** Filters warnings to a subtree: those on an element inside it. A ticket `components` warning names a missing slug, which belongs to no subtree, so only the unscoped call shows it. */
export function filterWarnings(warnings: ArchitectureWarning[], slugs: Set<string>): ArchitectureWarning[] {
  return warnings.filter((w) => w.field !== 'components' && slugs.has(w.id.replace(/^architecture\//, '')));
}

const under = (path: string, root: string): boolean => root === '.' ? true : path === root || path.startsWith(`${root}/`);

export interface OwnerGroup {
  id: string;
  kind: ElementKind;
  title: string;
  paths: string[];
}

export interface OwnersResult {
  owners: OwnerGroup[];
  unowned: string[];
}

/**
 * Elements owning `path` (already normalised): those whose longest matching root is the longest of all.
 * More than one only on an exact tie. `.` matches every path but is the shortest possible root.
 */
export function ownersOfPath(elements: Element[], path: string): Element[] {
  let best = -1;
  let winners: Element[] = [];
  for (const el of elements) {
    let len = -1;
    for (const root of el.code) if (under(path, root)) len = Math.max(len, root === '.' ? 0 : root.length);
    if (len < 0) continue;
    if (len > best) {
      best = len;
      winners = [el];
    } else if (len === best) winners.push(el);
  }
  return winners;
}

/**
 * Owner lookup: normalises, de-duplicates, then groups paths by owning element
 * in order of first appearance. Never checks existence. Fails `bad_request` for a bad `paths` array or for a path
 * outside the workspace.
 */
export function lookupOwners(elements: Element[], paths: unknown, workspaceRoot: string): OwnersResult {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string')) {
    throw bad('paths must be a non-empty array of path strings (1 to 500).');
  }
  if (paths.length > MAX_OWNER_PATHS) throw bad(`paths has ${paths.length} entries; at most ${MAX_OWNER_PATHS} per call, so split the list.`);
  const seen = new Set<string>();
  const normalised: string[] = [];
  for (const raw of paths as string[]) {
    const p = normalizeRepoPath(raw, workspaceRoot);
    if (p === null) throw bad(`path ${JSON.stringify(raw)} is empty or outside the workspace; pass repo-relative paths or absolute paths under the workspace root.`, { path: raw });
    if (!seen.has(p)) {
      seen.add(p);
      normalised.push(p);
    }
  }
  const groups = new Map<string, OwnerGroup>();
  const unowned: string[] = [];
  for (const p of normalised) {
    const owners = ownersOfPath(elements, p);
    if (owners.length === 0) unowned.push(p);
    for (const el of owners) {
      let g = groups.get(el.slug);
      if (!g) groups.set(el.slug, (g = { id: el.slug, kind: el.kind, title: el.title, paths: [] }));
      g.paths.push(p);
    }
  }
  return { owners: [...groups.values()], unowned };
}
