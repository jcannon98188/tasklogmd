import { describe, expect, it } from 'vitest';
import { detect, kebab } from '../../../src/architecture/detect.ts';
import { normalizePath } from '../../../src/architecture/paths.ts';
import type { Detection } from '../../../src/architecture/types.ts';
import { isManifestPath } from '../../../src/architecture/manifests.ts';

/** Build input from a path -> contents map; every manifest path's contents are passed as manifests. */
function run(tree: Record<string, string>): Detection {
  const files = Object.keys(tree);
  const manifests: Record<string, string> = {};
  for (const f of files) if (isManifestPath(f)) manifests[f] = tree[f]!;
  return detect({ files, manifests });
}
const pkg = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, ...extra });
const summary = (d: Detection) => d.candidates.map((c) => `${c.kind}:${c.slug}:${c.code.join(',')}${c.parent ? `^${c.parent}` : ''}`);

describe('normalizePath', () => {
  it.each([
    ['a\\b\\c.ts', 'a/b/c.ts'],
    ['./a/b', 'a/b'],
    ['a/b/', 'a/b'],
    ['a//b', 'a/b'],
    ['.', '.'],
    ['A/b', 'A/b'], // case-sensitive: never lowercased
  ])('%s -> %s', (i, o) => expect(normalizePath(i)).toBe(o));
});

describe('kebab', () => {
  it.each([
    ['Waymark.Foundation', 'waymark-foundation'],
    ['WaymarkAbi.Common', 'waymark-abi-common'],
    ['@scope/my_pkg', 'scope-my-pkg'],
    ['Interop', 'interop'],
  ])('%s -> %s', (i, o) => expect(kebab(i)).toBe(o));
});

describe('detect: containers and components', () => {
  it('proposes one container for a single package with depth-1 components of src/', () => {
    const d = run({
      'package.json': pkg('tasklog'),
      'src/cli.ts': '',
      'src/daemon/a.ts': '',
      'src/model/b/c.ts': '',
      'docs/readme.md': '',
    });
    expect(summary(d)).toEqual(['container:tasklog:.', 'component:daemon:src/daemon^tasklog', 'component:model:src/model^tasklog']);
    const c = d.candidates[0]!;
    expect(c.files).toEqual(['docs/readme.md', 'package.json', 'src/cli.ts']);
    expect(d.candidates[1]!.files).toEqual(['src/daemon/a.ts']);
  });

  it('uses the manifest directory when there is no src/', () => {
    const d = run({ 'package.json': pkg('p'), 'lib/a.ts': '', 'util/b.ts': '' });
    expect(summary(d)).toEqual(['container:p:.', 'component:lib:lib^p', 'component:util:util^p']);
  });

  it('does not propose directories without code, and a code-less manifest is no container', () => {
    const d = run({ 'package.json': pkg('p'), 'src/a.ts': '', 'src/docs/x.md': '', 'other/package.json': pkg('q'), 'other/data.json': '{}' });
    expect(summary(d)).toEqual(['container:p:.']);
  });

  it('carves nested manifest directories out of the outer container', () => {
    const d = run({ 'package.json': pkg('root'), 'src/a.ts': '', 'spikes/stub/package.json': pkg('stub'), 'spikes/stub/i.js': '', 'spikes/x.js': '' });
    const root = d.candidates.find((c) => c.slug === 'root')!;
    expect(root.files).toContain('spikes/x.js');
    expect(root.files).not.toContain('spikes/stub/i.js');
    expect(d.candidates.some((c) => c.slug === 'stub' && c.code[0] === 'spikes/stub')).toBe(true);
  });

  it('suffixes a numeric slug on container collisions', () => {
    const d = run({ 'a/package.json': pkg('same'), 'a/x.ts': '', 'b/package.json': pkg('same'), 'b/x.ts': '' });
    expect(summary(d)).toEqual(['container:same:a', 'container:same-2:b']);
  });

  it('prefixes the container slug when component slugs collide', () => {
    const d = run({
      'a/package.json': pkg('alpha'),
      'a/src/core/x.ts': '',
      'b/package.json': pkg('beta'),
      'b/src/core/x.ts': '',
    });
    expect(summary(d)).toEqual([
      'container:alpha:a',
      'container:beta:b',
      'component:alpha-core:a/src/core^alpha',
      'component:beta-core:b/src/core^beta',
    ]);
  });

  it('descends a grouping directory once; its loose files stay with the container', () => {
    const d = run({
      'package.json': pkg('site'),
      'src/app/layout.ts': '',
      'src/app/features/billing/x.ts': '',
      'src/app/features/auth/y.ts': '',
      'src/app/shell/z.ts': '',
      'src/components/btn.ts': '',
      'src/pages/home/p.ts': '',
    });
    expect(summary(d)).toEqual([
      'container:site:.',
      'component:features:src/app/features^site',
      'component:shell:src/app/shell^site',
      'component:components:src/components^site',
      'component:home:src/pages/home^site',
    ]);
  });

  it('falls back to the grouping directory itself when it has no code-bearing subdirectories', () => {
    const d = run({ 'package.json': pkg('s'), 'src/pages/a.ts': '', 'src/pages/b.ts': '' });
    expect(summary(d)).toEqual(['container:s:.', 'component:pages:src/pages^s']);
  });

  it('reports tooling and test directories as ignored and never proposes them', () => {
    const d = run({ 'package.json': pkg('p'), 'scripts/build.mjs': '', 'test/a.test.ts': '', 'e2e/x.ts': '', 'src/a.ts': '', 'docs/d.md': '' });
    expect(summary(d)).toEqual(['container:p:.']);
    expect(d.ignored).toEqual(
      expect.arrayContaining([
        { path: 'e2e', reason: 'tooling' },
        { path: 'scripts', reason: 'tooling' },
        { path: 'test', reason: 'test' },
      ]),
    );
    expect(d.ignored.some((i) => i.path === 'docs')).toBe(false);
  });
});

describe('detect: manifests', () => {
  it('ignores test csproj files, seeds ProjectReference into uses, and a Cargo [workspace] is no container', () => {
    const d = run({
      'Lib/Lib.csproj': '<Project/>',
      'Lib/A.cs': '',
      'App/App.csproj': '<Project><ItemGroup><ProjectReference Include="..\\Lib\\Lib.csproj"/></ItemGroup></Project>',
      'App/Program.cs': '',
      'App/Core/B.cs': '',
      'App.Tests/App.Tests.csproj': '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>',
      'App.Tests/T.cs': '',
      'native/Cargo.toml': '[workspace]\nmembers=["x"]',
      'native/x/lib.rs': '',
      'build/gen.mjs': '',
    });
    expect(summary(d)).toEqual(['container:app:App', 'container:lib:Lib', 'component:core:App/Core^app']);
    expect(d.candidates.find((c) => c.slug === 'app')!.uses).toEqual([{ to: 'lib', label: 'project-reference' }]);
    expect(d.ignored).toEqual(expect.arrayContaining([{ path: 'App.Tests', reason: 'test' }]));
    expect(d.unowned).toEqual(['build', 'native']);
  });

  it('proposes go.mod and Cargo [package] containers and seeds Cargo path dependencies', () => {
    const d = run({
      'svc/go.mod': 'module github.com/acme/svc\n',
      'svc/main.go': '',
      'core/Cargo.toml': '[package]\nname = "core"\n',
      'core/src/lib.rs': '',
      'app/Cargo.toml': '[package]\nname = "app"\n[dependencies]\ncore = { path = "../core" }\n',
      'app/src/main.rs': '',
    });
    expect(summary(d)).toEqual(['container:app:app', 'container:core:core', 'container:svc:svc']);
    expect(d.candidates[0]!.uses).toEqual([{ to: 'core', label: 'path-dependency' }]);
  });

  it('with JS workspaces declared only matched manifests are containers; the root and others are not', () => {
    const d = run({
      'package.json': pkg('mono', { private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg('@m/a', { dependencies: { '@m/b': '*' } }),
      'packages/a/src/x.ts': '',
      'packages/b/package.json': pkg('@m/b'),
      'packages/b/src/y.ts': '',
      'packages/b/src/ui/z.ts': '',
      'tools/odd/package.json': pkg('odd'),
      'tools/odd/i.js': '',
      'examples/fixtures/f/package.json': pkg('fx'),
      'examples/fixtures/f/i.js': '',
      'create/templates/t/package.json': pkg('tpl'),
      'create/templates/t/i.js': '',
    });
    expect(summary(d)).toEqual(['container:m-a:packages/a', 'container:m-b:packages/b', 'component:ui:packages/b/src/ui^m-b']);
    expect(d.candidates[0]!.uses).toEqual([{ to: 'm-b', label: 'workspace-dependency' }]);
    expect(d.ignored).toEqual(
      expect.arrayContaining([
        { path: 'create/templates', reason: 'fixture-template' },
        { path: 'examples/fixtures', reason: 'fixture-template' },
        { path: 'tools/odd', reason: 'not-workspace-member' },
      ]),
    );
  });

  it('reads pnpm-workspace.yaml globs (with negation)', () => {
    const d = run({
      'package.json': pkg('root'),
      'pnpm-workspace.yaml': "packages:\n  - 'pkgs/*'\n  - '!pkgs/skip'\n",
      'pkgs/a/package.json': pkg('a'),
      'pkgs/a/i.ts': '',
      'pkgs/skip/package.json': pkg('skip'),
      'pkgs/skip/i.ts': '',
    });
    expect(summary(d)).toEqual(['container:a:pkgs/a']);
    expect(d.ignored).toEqual([{ path: 'pkgs/skip', reason: 'not-workspace-member' }]);
  });

  it('lets angular.json projects and Nx project.json beat the root package.json', () => {
    const d = run({
      'package.json': pkg('shop-root'),
      'angular.json': JSON.stringify({ projects: { shop: { root: '', sourceRoot: 'src' }, ui: { root: 'projects/ui', sourceRoot: 'projects/ui/src' } } }),
      'src/main.ts': '',
      'src/app/cart/c.ts': '',
      'projects/ui/src/btn/b.ts': '',
      'libs/data/project.json': JSON.stringify({ name: 'data' }),
      'libs/data/package.json': pkg('data-pkg'),
      'libs/data/src/api/a.ts': '',
    });
    expect(summary(d)).toEqual([
      'container:shop:.',
      'container:data:libs/data',
      'container:ui:projects/ui',
      'component:api:libs/data/src/api^data',
      'component:btn:projects/ui/src/btn^ui',
      'component:cart:src/app/cart^shop',
    ]);
  });

  it('skips a package.json under a test directory as a test project', () => {
    const d = run({ 'package.json': pkg('p'), 'src/a.ts': '', 'test/helper/package.json': pkg('h'), 'test/helper/x.ts': '' });
    expect(summary(d)).toEqual(['container:p:.']);
    expect(d.ignored).toEqual([{ path: 'test', reason: 'test' }]);
  });
});

describe('detect: unowned code and file list', () => {
  it('reports manifest-less code directories as unowned and never proposes them', () => {
    const d = run({ 'scripts/a.mjs': '', 'spikes/s/x.ts': '', 'README.md': '', 'loose.js': '', 'assets/logo.png': '' });
    expect(d.candidates).toEqual([]);
    expect(d.unowned).toEqual(['.', 'scripts', 'spikes']);
  });

  it('is empty for an empty file list, and tolerates a missing manifest entry', () => {
    expect(detect({ files: [], manifests: {} })).toEqual({ candidates: [], ignored: [], unowned: [] });
    expect(detect({ files: ['package.json', 'a.ts'], manifests: {} }).candidates).toEqual([]);
  });

  it('is deterministic regardless of file order and normalises backslashes and CRLF', () => {
    const tree = { 'package.json': JSON.stringify({ name: 'p' }, null, 2).replace(/\n/g, '\r\n'), 'src/a/x.ts': '', 'src/b/y.ts': '' };
    const a = run(tree);
    const files = Object.keys(tree).reverse().map((f) => f.replace(/\//g, '\\'));
    const b = detect({ files, manifests: { 'package.json': tree['package.json'] } });
    expect(b).toEqual(a);
  });

  it('does not treat markdown, json or assets as code', () => {
    expect(run({ 'package.json': pkg('p'), 'src/docs/a.md': '', 'src/data/b.json': '' }).candidates.map((c) => c.slug)).toEqual([]);
  });
});
