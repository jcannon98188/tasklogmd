// Bundles each entry point into ONE self-contained ESM file (spec section 11):
// a running daemon must never lazy-load a file an upgrade just replaced.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: { cli: 'src/cli.ts', daemon: 'src/daemon-main.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: false,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  define: { __TASKLOG_VERSION__: JSON.stringify(pkg.version) },
  // Some bundled CJS dependencies call require(); provide it in the ESM output.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
