// Lists the files of a workspace for drift: git-tracked plus untracked-not-ignored in a git repo, otherwise a
// walk with the built-in ignore list (spec, Detection). Paths are repo-relative with forward slashes, sorted.
// Slice 5 (scan apply) owns file listing for the scan; this is the minimal version the `architecture` tool needs
// and slice 5 may replace it with its own lister.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const BUILTIN_IGNORES: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'bin', 'obj', 'target', 'vendor', '.tasklog']);

function walk(root: string): string[] {
  const out: string[] = [];
  const go = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (BUILTIN_IGNORES.has(e.name) || e.isSymbolicLink()) continue;
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) go(r);
      else if (e.isFile()) out.push(r);
    }
  };
  go('');
  return out;
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
      const files = new Set(stdout.split('\0').filter((f) => f !== '' && fs.existsSync(path.join(root, f))));
      return [...files].filter((f) => !f.startsWith('.tasklog/')).sort();
    } catch {
      /* git missing or failing: fall back to the walk */
    }
  }
  return walk(root).sort();
}
