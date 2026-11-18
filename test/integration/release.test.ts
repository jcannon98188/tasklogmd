import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor.ts';
import { createLogger } from '../../src/log.ts';
import { makeEnv, type TestEnv } from '../helpers.ts';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('package.json is publish-ready', () => {
  it('has the name, engines, bin, files and build hook npm needs', () => {
    expect(pkg.name).toBe('tasklog');
    expect(pkg.engines.node).toBe('>=24');
    expect(pkg.bin).toEqual({ tasklog: 'dist/cli.js' });
    expect(pkg.files).toEqual(['dist']);
    expect(pkg.private).not.toBe(true);
    expect(pkg.license).toBeTruthy();
    expect(pkg.scripts.prepublishOnly).toMatch(/build/);
  });

  it('carries no secrets in publishable files or manifest', () => {
    const text = JSON.stringify(pkg);
    expect(text).not.toMatch(/npm_[A-Za-z0-9]{20,}|_authToken|ghp_[A-Za-z0-9]{20,}/);
    expect(fs.existsSync(path.join(root, '.npmrc'))).toBe(false);
  });
});

describe('the bundle (spec section 11 build rules)', () => {
  const dist = path.join(root, 'dist');
  const NATIVE_MODULES = /\b(?:fsevents|bufferutil|utf-8-validate|node-pty|better-sqlite3|sharp|keytar|ffi-napi|node-gyp-build|bindings)\b/;

  beforeEach(() => {
    // `npm test` builds first. Never rebuild here when dist exists: the build wipes dist and would race the e2e tests.
    if (!fs.existsSync(path.join(dist, 'daemon.js'))) execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'ignore' });
  });

  it('is exactly one self-contained ESM file per entry point', () => {
    const files = fs.readdirSync(dist).sort();
    expect(files).toEqual(['cli.js', 'daemon.js']);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dist, f), 'utf8');
      // No relative imports/requires: nothing for a running daemon to lazy-load after an upgrade.
      expect(src, f).not.toMatch(/(?:from|import)\s*\(?\s*["']\.{1,2}\//);
      expect(src, f).not.toMatch(/require\(\s*["']\.{1,2}\//);
      // ESM, not CJS.
      expect(src, f).toMatch(/^import |\nimport |\nexport /);
    }
    expect(pkg.type).toBe('module');
  });

  it('has no native addon in the daemon', () => {
    const all: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        e.isDirectory() ? walk(p) : all.push(p);
      }
    })(dist);
    expect(all.filter((f) => /\.(node|dll|so|dylib)$/i.test(f))).toEqual([]);

    const daemon = fs.readFileSync(path.join(dist, 'daemon.js'), 'utf8');
    expect(daemon).not.toMatch(/require\(\s*["'][^"']*\.node["']\s*\)/);
    expect(daemon).not.toMatch(/process\.dlopen/);
    expect(daemon).not.toMatch(new RegExp(`require\\(\\s*["'](?:${NATIVE_MODULES.source.slice(2, -2)})["']`));
    // Every runtime dependency is pure JS: none ships a binding.gyp or .node file.
    for (const dep of Object.keys(pkg.dependencies)) {
      const dir = path.join(root, 'node_modules', dep);
      expect(fs.existsSync(path.join(dir, 'binding.gyp')), dep).toBe(false);
    }
  });
});

describe('doctor on an old Node', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => env.cleanup());

  async function nodeCheck(nodeVersion: string) {
    const rep = await runDoctor({
      paths: env.paths,
      log: createLogger(),
      cwd: env.root,
      env: { ...process.env, PATH: '' },
      spawn: () => void env.start(),
      nodeVersion,
    });
    return rep.checks.find((c) => c.name === 'node-version')!;
  }

  it('fails the node-version check with a fix on Node 22', async () => {
    const c = await nodeCheck('22.12.0');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('22.12.0');
    expect(c.fix).toMatch(/Node 24/);
  });

  it('passes on Node 24 and newer', async () => {
    expect((await nodeCheck('24.0.0')).ok).toBe(true);
    expect((await nodeCheck('26.1.0')).ok).toBe(true);
  });
});
