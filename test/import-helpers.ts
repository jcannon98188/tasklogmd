import fs from 'node:fs';
import path from 'node:path';

export const IMPORT_FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'import');

/** The fixed time every source file gets, so scratch `created`/`updated` (file mtime) are reproducible. */
export const FIXED_MTIME = new Date('2026-01-01T12:00:00Z');

function touchAll(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) touchAll(p);
    else fs.utimesSync(p, FIXED_MTIME, FIXED_MTIME);
  }
}

/** Copies an import fixture (`scratch` or `backlog`) into `parent` with every mtime pinned; returns the workspace root. */
export function copyImportFixture(name: 'scratch' | 'backlog', parent: string): string {
  const dest = path.join(parent, name);
  fs.cpSync(path.join(IMPORT_FIXTURES, name), dest, { recursive: true });
  touchAll(dest);
  return dest;
}

/** All files under `dir` as `relative/path -> bytes` (forward slashes), for exact tree comparison. */
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'latin1');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
