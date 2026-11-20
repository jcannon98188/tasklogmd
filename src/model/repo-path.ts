// Repo-relative path normalisation shared by element `code` roots and the `owners` tool. Pure: no
// filesystem, so it never checks that a path exists and never resolves symlinks. Case is always preserved.

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

const forward = (p: string): string => p.replace(/\\/g, '/');

/**
 * Normalises one path to the form element `code` entries use: forward slashes, no leading `./`, no trailing
 * slash, no empty or `.` segments (`a//b` becomes `a/b`), `.` for the workspace root. `..` is resolved
 * lexically. An absolute path becomes relative when it lies under `workspaceRoot` (a Windows drive-letter
 * root is compared case-insensitively, as that file system is). Returns null for an empty input, an absolute
 * path with no root or outside it, and any path that climbs out of the workspace.
 */
export function normalizeRepoPath(input: string, workspaceRoot?: string): string | null {
  let p = forward(input).trim();
  if (p === '') return null;
  if (isAbsolute(p)) {
    if (workspaceRoot === undefined) return null;
    const root = forward(workspaceRoot).replace(/\/+$/, '');
    const fold = /^[A-Za-z]:/.test(root);
    const same = (a: string, b: string): boolean => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (same(p.replace(/\/+$/, ''), root)) return '.';
    if (!same(p.slice(0, root.length), root) || p[root.length] !== '/') return null;
    p = p.slice(root.length + 1);
  }
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length === 0 ? '.' : out.join('/');
}
