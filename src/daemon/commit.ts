// Opt-in `commit: true` for resolve, close and create_item: stage `.tasklog/` and commit with a standard
// message. Whatever else the caller staged rides along in the same commit. Never pushes. A failure is
// reported in the result and never undoes the write that already happened.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

export const commitArg = z
  .boolean()
  .optional()
  .describe('true: after the write, `git add .tasklog` and commit (anything else you staged rides along), with a standard message. Never pushes. A commit failure is reported in `commit` and does not undo the write.');

const run = promisify(execFile);

export interface CommitResult {
  ok: boolean;
  /** Short commit hash when `ok`. */
  commit?: string;
  /** Why it did not commit. */
  error?: string;
}

export async function commitTasklog(root: string, message: string): Promise<CommitResult> {
  const git = (...args: string[]) => run('git', ['-C', root, ...args], { windowsHide: true, timeout: 60_000 });
  try {
    await git('add', '--', '.tasklog');
    await git('commit', '-q', '-m', message);
    const { stdout } = await git('rev-parse', '--short', 'HEAD');
    return { ok: true, commit: stdout.trim() };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || err.message;
    return { ok: false, error: detail.split('\n').slice(0, 3).join(' ').slice(0, 300) };
  }
}
