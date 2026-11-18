#!/usr/bin/env node
// The `tasklog` binary (bundled to dist/cli.js).
import { runCommand } from './commands.ts';

const code = await runCommand(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
// Flush piped stdout before exiting so output is never truncated.
process.stdout.write('', () => process.exit(code));
