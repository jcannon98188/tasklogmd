import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../../src/paths.ts';
import { acquireLock } from '../../src/state.ts';
import { rmDir, tmpDir } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmDir(d);
});
const fresh = () => {
  const d = tmpDir('tasklog-state-');
  dirs.push(d);
  return dataPaths(d);
};

describe('acquireLock', () => {
  it('acquires, refuses a second holder, and releases', () => {
    const paths = fresh();
    const a = acquireLock(paths, process.pid);
    expect(a).not.toBeNull();
    expect(acquireLock(paths, process.pid)).toBeNull();
    a!.release();
    expect(fs.existsSync(paths.lock)).toBe(false);
  });

  it('reclaims a lock whose owner is dead', () => {
    const paths = fresh();
    fs.writeFileSync(paths.lock, '2147483000');
    const lock = acquireLock(paths, process.pid);
    expect(lock).not.toBeNull();
    expect(fs.readFileSync(paths.lock, 'utf8')).toBe(String(process.pid));
    lock!.release();
  });

  it('does not delete a lock that is still being written by another daemon', async () => {
    const paths = fresh();
    // A child creates the lock empty (as `wx` + write does), then fills in its pid a moment later.
    const script = `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(paths.lock)}, '');
      console.log('empty');
      setTimeout(() => { fs.writeFileSync(${JSON.stringify(paths.lock)}, String(process.pid)); }, 250);
      setTimeout(() => process.exit(0), 3000);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
      const lock = acquireLock(paths, process.pid);
      expect(lock).toBeNull();
      expect(fs.readFileSync(paths.lock, 'utf8')).toBe(String(child.pid));
    } finally {
      child.kill();
    }
  });
});
