// Structural detection (v1): a file list plus manifest contents in, candidate elements out. Purely
// structural, language-agnostic, and pure: no filesystem, no git, no daemon imports. Rules follow the spec.

import {
  isManifestPath,
  parseAngularJson,
  parseCargo,
  parseCsproj,
  parseGoMod,
  parseNxProject,
  parsePackageJson,
  parsePnpmWorkspace,
} from './manifests.ts';
import { dirOf, globToRegExp, isUnder, joinPath, normalizePath } from './paths.ts';
import type { Candidate, Detection, DetectInput, IgnoredEntry, IgnoredReason, Use } from './types.ts';

export const CODE_EXTENSIONS: readonly string[] = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'cs', 'go', 'rs', 'py', 'java', 'kt', 'kts', 'scala',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'swift', 'rb', 'php', 'vue', 'svelte', 'dart',
];
const CODE_EXT = new Set(CODE_EXTENSIONS);
const GROUPING = new Set(['app', 'features', 'modules', 'pages', 'routes', 'views', 'screens', 'domains']);
const TOOLING = new Set(['scripts', 'tools', 'config', 'e2e', 'cypress', '.storybook', 'public', 'static', 'bin']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__']);
const FIXTURE_DIRS = new Set(['fixtures', 'test-fixtures', '__fixtures__', 'testdata', 'template', 'templates']);

export function isCodeFile(path: string): boolean {
  const i = path.lastIndexOf('.');
  return i > path.lastIndexOf('/') + 1 && CODE_EXT.has(path.slice(i + 1).toLowerCase());
}

/** Kebab-case slug: camelCase boundaries split, every non-alphanumeric run becomes one hyphen. */
export function kebab(name: string): string {
  const s = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'unnamed';
}

/** The reason a directory name is never proposed, or null. */
function nameReason(name: string): IgnoredReason | null {
  if (TEST_DIRS.has(name)) return 'test';
  if (FIXTURE_DIRS.has(name) || name.startsWith('template-')) return 'fixture-template';
  if (TOOLING.has(name)) return 'tooling';
  return null;
}

/** For a directory path, the first test/fixture segment's path and reason, if any. */
function excludedPrefix(dir: string): { path: string; reason: IgnoredReason } | null {
  if (dir === '.') return null;
  const segs = dir.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const r: IgnoredReason | null = TEST_DIRS.has(s) ? 'test' : FIXTURE_DIRS.has(s) || s.startsWith('template-') ? 'fixture-template' : null;
    if (r) return { path: segs.slice(0, i + 1).join('/'), reason: r };
  }
  return null;
}

function matchesWorkspace(rel: string, globs: string[]): boolean {
  const pos = globs.filter((g) => !g.startsWith('!')).map(globToRegExp);
  const neg = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
  return pos.some((r) => r.test(rel)) && !neg.some((r) => r.test(rel));
}

type SpecKind = 'descriptor' | 'csproj' | 'cargo' | 'go' | 'npm';
const PRIORITY: Record<SpecKind, number> = { descriptor: 0, csproj: 1, cargo: 2, go: 3, npm: 4 };

interface Spec {
  kind: SpecKind;
  name: string;
  /** Container directory. */
  dir: string;
  manifest: string;
  sourceRoot?: string;
  /** Raw references, resolved to uses after the container set is known. */
  refs: { kind: 'project-reference' | 'workspace-dependency' | 'path-dependency'; value: string }[];
}

export function detect(input: DetectInput): Detection {
  const files = [...new Set(input.files.map(normalizePath))].sort();
  const manifests = new Map<string, string>();
  for (const [k, v] of Object.entries(input.manifests)) manifests.set(normalizePath(k), v);

  const ignored = new Map<string, IgnoredEntry>();
  const ignore = (path: string, reason: IgnoredReason): void => {
    ignored.set(`${path}\0${reason}`, { path, reason });
  };
  const ignoredRoots: string[] = [];
  const ignoreRoot = (path: string, reason: IgnoredReason): void => {
    ignore(path, reason);
    ignoredRoots.push(path);
  };

  // ---- 1. Manifests to specs -------------------------------------------------------------------------
  const specs: Spec[] = [];
  const workspaceRoots: { dir: string; globs: string[] }[] = [];
  const descriptorDirs = new Set<string>();
  const manifestPaths = files.filter(isManifestPath);

  for (const mp of manifestPaths) {
    const text = manifests.get(mp);
    if (text === undefined) continue;
    const dir = dirOf(mp);
    const base = mp.slice(mp.lastIndexOf('/') + 1);
    if (base === 'pnpm-workspace.yaml') {
      const globs = parsePnpmWorkspace(text);
      if (globs.length) workspaceRoots.push({ dir, globs });
    } else if (base === 'package.json') {
      const p = parsePackageJson(text);
      if (!p) continue;
      if (p.workspaces?.length) {
        workspaceRoots.push({ dir, globs: p.workspaces });
        continue; // grouping-only
      }
      if (!p.name) continue;
      specs.push({ kind: 'npm', name: p.name, dir, manifest: mp, refs: p.deps.map((value) => ({ kind: 'workspace-dependency', value })) });
    } else if (base === 'go.mod') {
      const g = parseGoMod(text);
      if (g) specs.push({ kind: 'go', name: g.name, dir, manifest: mp, refs: [] });
    } else if (base === 'Cargo.toml') {
      const c = parseCargo(text);
      if (c.name) specs.push({ kind: 'cargo', name: c.name, dir, manifest: mp, refs: c.pathDeps.map((value) => ({ kind: 'path-dependency', value })) });
    } else if (base.endsWith('.csproj')) {
      const c = parseCsproj(text);
      if (c.isTest) {
        ignoreRoot(dir, 'test');
        continue;
      }
      specs.push({ kind: 'csproj', name: base.slice(0, -'.csproj'.length), dir, manifest: mp, refs: c.references.map((value) => ({ kind: 'project-reference', value })) });
    } else if (base === 'angular.json') {
      const projects = parseAngularJson(text);
      if (projects.length) descriptorDirs.add(dir);
      for (const p of projects) {
        const pdir = joinPath(dir, p.root);
        if (pdir === null) continue;
        descriptorDirs.add(pdir);
        const s: Spec = { kind: 'descriptor', name: p.name, dir: pdir, manifest: mp, refs: [] };
        const sr = p.sourceRoot !== undefined ? joinPath(dir, p.sourceRoot) : null;
        if (sr) s.sourceRoot = sr;
        specs.push(s);
      }
    } else if (base === 'project.json') {
      const n = parseNxProject(text);
      if (!n) continue;
      descriptorDirs.add(dir);
      const s: Spec = { kind: 'descriptor', name: n.name, dir, manifest: mp, refs: [] };
      const sr = n.sourceRoot !== undefined ? joinPath(dir, n.sourceRoot) : null;
      if (sr) s.sourceRoot = sr;
      specs.push(s);
    }
  }

  // Descriptors beat package.json for the same paths.
  let live = specs.filter((s) => !(s.kind === 'npm' && descriptorDirs.has(s.dir)));

  // Test projects and fixture/template directories are never containers.
  live = live.filter((s) => {
    const ex = excludedPrefix(s.dir);
    if (ex) {
      ignoreRoot(ex.path, ex.reason);
      return false;
    }
    return true;
  });

  // JS workspaces: when declared, only matched package.json manifests are containers.
  live = live.filter((s) => {
    if (s.kind !== 'npm') return true;
    const root = workspaceRoots.filter((w) => w.dir !== s.dir && isUnder(s.dir, w.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (!root) return true;
    const rel = root.dir === '.' ? s.dir : s.dir.slice(root.dir.length + 1);
    if (matchesWorkspace(rel, root.globs)) return true;
    ignoreRoot(s.dir, 'not-workspace-member');
    return false;
  });

  // One container per directory: the highest-priority manifest, then the first by path.
  const byDir = new Map<string, Spec>();
  for (const s of [...live].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.manifest.localeCompare(b.manifest))) {
    if (!byDir.has(s.dir)) byDir.set(s.dir, s);
  }
  live = [...byDir.values()];

  // ---- 2. Ownership; a container with no code is no container ---------------------------------------
  const inIgnored = (f: string): boolean => ignoredRoots.some((r) => isUnder(f, r));
  const ownerDir = (f: string, dirs: string[]): string | null => {
    let best: string | null = null;
    for (const d of dirs) if (isUnder(f, d) && (best === null || d.length > best.length)) best = d;
    return best;
  };
  const codeFiles = files.filter((f) => isCodeFile(f) && !inIgnored(f));
  const hasCode = (dirs: string[]): Set<string> => {
    const s = new Set<string>();
    for (const f of codeFiles) {
      const o = ownerDir(f, dirs);
      if (o !== null) s.add(o);
    }
    return s;
  };
  live = live.filter((s) => hasCode(live.map((x) => x.dir)).has(s.dir));
  live.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const containerDirs = live.map((s) => s.dir);

  // Container slugs: kebab-case of the name, numeric suffix on collision.
  const used = new Set<string>();
  const slugOf = new Map<Spec, string>();
  for (const s of live) {
    const base = kebab(s.name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    slugOf.set(s, slug);
  }

  // ---- 3. Components ---------------------------------------------------------------------------------
  interface RawComponent {
    container: Spec;
    dir: string;
    base: string;
  }
  const raws: RawComponent[] = [];
  const owned = new Map<Spec, string[]>();
  for (const s of live) owned.set(s, files.filter((f) => ownerDir(f, containerDirs) === s.dir));

  for (const s of live) {
    const mine = owned.get(s)!;
    const srcDefault = s.dir === '.' ? 'src' : `${s.dir}/src`;
    const srcRoot = s.sourceRoot ?? (mine.some((f) => f.startsWith(`${srcDefault}/`)) ? srcDefault : s.dir);
    const codeMine = mine.filter((f) => isCodeFile(f) && !inIgnored(f));

    const childDirs = (parent: string, from: string[]): string[] => {
      const prefix = parent === '.' ? '' : `${parent}/`;
      const out = new Set<string>();
      for (const f of from) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i > 0) out.add(`${prefix}${rest.slice(0, i)}`);
      }
      return [...out].sort();
    };
    const name = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
    const holdsCode = (p: string): boolean => codeMine.some((f) => isUnder(f, p));
    /** True when `p` is excluded (and reports it when it holds code). */
    const excluded = (p: string): boolean => {
      if (ignoredRoots.includes(p)) return true;
      const r = nameReason(name(p));
      if (!r) return false;
      if (mine.some((f) => isCodeFile(f) && isUnder(f, p))) ignore(p, r);
      return true;
    };

    // Tooling/test/fixture directories next to the manifest are reported even when the source root is src/.
    if (srcRoot !== s.dir) for (const d of childDirs(s.dir, mine)) excluded(d);

    for (const d of childDirs(srcRoot, mine)) {
      if (excluded(d) || !holdsCode(d)) continue;
      if (GROUPING.has(name(d))) {
        const subs = childDirs(d, codeMine).filter((x) => !excluded(x) && holdsCode(x));
        if (subs.length) {
          for (const sub of subs) raws.push({ container: s, dir: sub, base: name(sub) });
          continue;
        }
      }
      raws.push({ container: s, dir: d, base: name(d) });
    }
  }

  // Component slugs: a collision (with a container or another component) prefixes the container slug.
  const counts = new Map<string, number>();
  for (const slug of used) counts.set(slug, 1);
  for (const r of raws) counts.set(kebab(r.base), (counts.get(kebab(r.base)) ?? 0) + 1);
  const compSlugs = new Set<string>();
  const compSlug = (r: RawComponent): string => {
    const base = kebab(r.base);
    let slug = (counts.get(base) ?? 0) > 1 ? `${slugOf.get(r.container)!}-${base}` : base;
    const root = slug;
    for (let n = 2; compSlugs.has(slug) || used.has(slug); n++) slug = `${root}-${n}`;
    compSlugs.add(slug);
    return slug;
  };

  // ---- 4. Candidates ---------------------------------------------------------------------------------
  const specOfDir = new Map(live.map((s) => [s.dir, s]));
  const uses = (s: Spec): Use[] => {
    const out: Use[] = [];
    const add = (to: string | undefined, label: string): void => {
      if (to && to !== slugOf.get(s) && !out.some((u) => u.to === to && u.label === label)) out.push({ to, label });
    };
    for (const r of s.refs) {
      if (r.kind === 'workspace-dependency') {
        add(slugOf.get(live.find((x) => x !== s && x.kind === 'npm' && x.name === r.value) as Spec), r.kind);
      } else if (r.kind === 'path-dependency') {
        const d = joinPath(s.dir, r.value);
        add(d === null ? undefined : slugOf.get(specOfDir.get(d) as Spec), r.kind);
      } else {
        const p = joinPath(s.dir, r.value);
        add(p === null ? undefined : slugOf.get(specOfDir.get(dirOf(p)) as Spec), r.kind);
      }
    }
    return out;
  };

  const components: Candidate[] = raws.map((r) => ({
    kind: 'component' as const,
    slug: compSlug(r),
    title: r.base,
    parent: slugOf.get(r.container)!,
    code: [r.dir],
    files: owned.get(r.container)!.filter((f) => isUnder(f, r.dir)),
    uses: [],
  }));
  components.sort((a, b) => (a.code[0]! < b.code[0]! ? -1 : a.code[0]! > b.code[0]! ? 1 : 0));

  const containers: Candidate[] = live.map((s) => {
    const compDirs = raws.filter((r) => r.container === s).map((r) => r.dir);
    return {
      kind: 'container' as const,
      slug: slugOf.get(s)!,
      title: s.name,
      code: [s.dir],
      files: owned.get(s)!.filter((f) => !compDirs.some((d) => isUnder(f, d))),
      uses: uses(s),
    };
  });

  // ---- 5. Unowned code -------------------------------------------------------------------------------
  const unowned = new Set<string>();
  for (const f of codeFiles) {
    if (ownerDir(f, containerDirs) !== null) continue;
    const i = f.indexOf('/');
    unowned.add(i < 0 ? '.' : f.slice(0, i));
  }

  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    candidates: [...containers, ...components],
    ignored: [...ignored.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.reason, b.reason)),
    unowned: [...unowned].sort(cmp),
  };
}
