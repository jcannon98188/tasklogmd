// Manifest parsers for structural detection. Pure: text in, small records out. Every parser tolerates a BOM
// and CRLF line endings and returns null / an empty result instead of throwing on malformed input.

const clean = (text: string): string => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** True for a path whose file name is a manifest the detection reads. */
export function isManifestPath(path: string): boolean {
  const b = baseName(path.replace(/\\/g, '/'));
  return (
    b === 'package.json' ||
    b === 'go.mod' ||
    b === 'Cargo.toml' ||
    b === 'angular.json' ||
    b === 'project.json' ||
    b === 'pnpm-workspace.yaml' ||
    b.endsWith('.csproj')
  );
}

function json(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(clean(text));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export interface PackageJson {
  name?: string;
  private?: boolean;
  workspaces?: string[];
  /** Names from dependencies, devDependencies, peerDependencies and optionalDependencies. */
  deps: string[];
}

export function parsePackageJson(text: string): PackageJson | null {
  const o = json(text);
  if (!o) return null;
  const out: PackageJson = { deps: [] };
  if (typeof o.name === 'string' && o.name) out.name = o.name;
  if (typeof o.private === 'boolean') out.private = o.private;
  const ws = o.workspaces;
  if (Array.isArray(ws)) out.workspaces = strings(ws);
  else if (ws && typeof ws === 'object') out.workspaces = strings((ws as { packages?: unknown }).packages);
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const d = o[k];
    if (d && typeof d === 'object') out.deps.push(...Object.keys(d));
  }
  return out;
}

export interface Csproj {
  isTest: boolean;
  /** `ProjectReference Include` values, backslashes converted to forward slashes. */
  references: string[];
}

export function parseCsproj(text: string): Csproj {
  const t = clean(text);
  const isTest = /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(t) || /Microsoft\.NET\.Test\.Sdk/i.test(t);
  const references = [...t.matchAll(/<ProjectReference\s[^>]*?Include\s*=\s*"([^"]+)"/gi)].map((m) => m[1]!.replace(/\\/g, '/'));
  return { isTest, references };
}

export function parseGoMod(text: string): { name: string } | null {
  const m = /^\s*module\s+(\S+)/m.exec(clean(text));
  if (!m) return null;
  const segs = m[1]!.replace(/^"|"$/g, '').split('/').filter(Boolean);
  let name = segs.pop();
  if (name && /^v\d+$/.test(name) && segs.length) name = segs.pop();
  return name ? { name } : null;
}

export interface Cargo {
  name?: string;
  pathDeps: string[];
}

export function parseCargo(text: string): Cargo {
  const out: Cargo = { pathDeps: [] };
  let section = '';
  for (const raw of clean(text).split('\n')) {
    const line = raw.trim();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1]!.trim();
      continue;
    }
    if (section === 'package') {
      const n = /^name\s*=\s*"([^"]+)"/.exec(line);
      if (n) out.name = n[1];
    } else if (/(^|\.)(dependencies|dev-dependencies|build-dependencies)$/.test(section)) {
      const p = /\bpath\s*=\s*"([^"]+)"/.exec(line);
      if (p) out.pathDeps.push(p[1]!);
    }
  }
  return out;
}

export interface AngularProject {
  name: string;
  root: string;
  sourceRoot?: string;
}

export function parseAngularJson(text: string): AngularProject[] {
  const o = json(text);
  const projects = o?.projects;
  if (!projects || typeof projects !== 'object') return [];
  const out: AngularProject[] = [];
  for (const [name, v] of Object.entries(projects as Record<string, unknown>)) {
    if (typeof v === 'string') out.push({ name, root: v });
    else if (v && typeof v === 'object') {
      const p = v as { root?: unknown; sourceRoot?: unknown };
      const entry: AngularProject = { name, root: typeof p.root === 'string' ? p.root : '' };
      if (typeof p.sourceRoot === 'string') entry.sourceRoot = p.sourceRoot;
      out.push(entry);
    }
  }
  return out;
}

export function parseNxProject(text: string): { name: string; sourceRoot?: string } | null {
  const o = json(text);
  if (!o || typeof o.name !== 'string' || !o.name) return null;
  return typeof o.sourceRoot === 'string' ? { name: o.name, sourceRoot: o.sourceRoot } : { name: o.name };
}

/** The `packages:` list of a pnpm-workspace.yaml (block-list form only). */
export function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of clean(text).split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]!.replace(/^['"]|['"]$/g, ''));
    else if (/^\S/.test(line)) inPackages = false;
  }
  return out;
}
