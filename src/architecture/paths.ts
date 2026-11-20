// Path helpers shared by the pure architecture code. Paths are repo-relative with forward slashes.

/**
 * Normalises a repo-relative path: backslashes to `/`, repeated `/` collapsed, leading `./` and trailing `/`
 * removed, empty becomes `.`. Case is preserved (matching is case-sensitive). Existence is never checked.
 */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p === '' || p === '/' ? '.' : p;
}

/** Joins and normalises `a` and `b`, resolving `.` and `..`. Returns null when the result escapes the root. */
export function joinPath(a: string, b: string): string | null {
  const out: string[] = [];
  for (const seg of `${a}/${b}`.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/') : '.';
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
}

/** True when `path` equals `root` or lies under it, on whole path segments. `.` contains everything. */
export function isUnder(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}
