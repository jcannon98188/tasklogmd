// File listing for the architecture tools. The implementation (git-aware, with the built-in ignore list outside
// git) lives with the scan in `architecture-scan.ts`; this module keeps the import path the `architecture`
// tool uses.

export { BUILTIN_IGNORE as BUILTIN_IGNORES, listWorkspaceFiles } from './architecture-scan.ts';
