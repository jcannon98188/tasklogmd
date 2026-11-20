---
kind: ticket
title: Structural detection heuristics
status: resolved
type: grilling
created: 2026-11-20
updated: 2026-11-20T19:48:37Z
---

## Question

How does the v1 scan decide what is a container and what is a component from manifests (package.json, .csproj, go.mod, ...) and top-level directories? Cover monorepos, nested packages, non-code directories, and what is ignored. Run it against this repo and one other (rpgengine) as worked examples.

## Answer

The v1 scan is purely structural. It reads manifests and directory layout, never source symbols, tsconfig, path aliases or dependency names for framework sniffing.

### Inputs
- File list: `git ls-files` plus untracked-not-ignored when the workspace is a git repo. Otherwise a built-in ignore list: `.git`, `node_modules`, `dist`, `bin`, `obj`, `target`, `vendor`, `.tasklog`.
- Code file = a fixed extension list (ts, js, mjs, cs, go, rs, py, java, kt, c, cpp, h and similar), a constant extended in later releases. Markdown, JSON, assets and fixtures are not code. A directory with no code below it never becomes an element.

### Containers
1. A container is one named, buildable manifest: `package.json` with a `name`, `.csproj`, `go.mod`, Cargo `[package]`. Grouping-only manifests (Cargo `[workspace]`, a root `package.json` with `workspaces` and no source, `.sln`/`.slnx`) contribute nothing.
2. JS workspaces: when a root `package.json` or `pnpm-workspace.yaml` declares workspaces, only manifests matched by the globs are containers. Other manifests are reported as "ignored: not a workspace member". Repos without a declaration use the plain rule in 1.
3. Descriptors that define projects beat the single `package.json`: each `angular.json` `projects` entry is a container (name = key, source root = its `sourceRoot`), and each Nx `project.json` is a container (name = `name`). The root `package.json` is then not a container for those paths. Turborepo and Lerna get no special handling.
4. Containers are flat. A container's `code` is its manifest directory minus nested manifest directories, so each file has one owning container. `parent` is only used on components.
5. Never containers: test projects (`.csproj` with `IsTestProject` or a test SDK reference, test-only `package.json`, directories named `test`, `tests`, `__tests__`) and anything under `fixtures`, `test-fixtures`, `__fixtures__`, `testdata`, `template`, `templates`, `template-*`. They are reported as "ignored: test" or "ignored: fixture/template", not proposed.
6. Title = manifest name (package name, csproj file name, Cargo package name, last segment of the `go.mod` module path). Slug = kebab-case of the title; a collision gets a numeric suffix.

### Components
1. Source root = `src/` if the container has one, else the container's manifest directory (or the Angular `sourceRoot`).
2. A component is each direct subdirectory of the source root that holds at least one code file anywhere below it. Depth is 1 only. No minimum file count. Loose files at the source root belong to the container only, so a container may have no components (rpgengine `Waymark.Analyzers`).
3. Grouping directories: `app`, `features`, `modules`, `pages`, `routes`, `views`, `screens`, `domains` are not elements. Their subdirectories become the components (descent happens once) and their loose files belong to the container. A grouping directory with no code-bearing subdirectories falls back to being a component itself. Technical layers (`components`, `hooks`, `store`, `services`, `utils`) stay components.
4. Tooling directories are never components: `scripts`, `tools`, `config`, `e2e`, `cypress`, `.storybook`, `public`, `static`, `bin`. Any that hold code are reported as "ignored: tooling".
5. Title = directory name. Slug = kebab-case of the title; on a collision the slug is prefixed with the container slug.

### Unowned code
Manifest-less directories with code (`scripts/`, `spikes/`, `build/`) are never proposed as elements. They are reported as unowned code, which feeds the drift report. A human or agent can create an element with `code: [scripts]`.

### `uses` seeding
A brand-new proposed container is seeded with `uses` from manifest references to other containers (`ProjectReference`, workspace dependencies, Cargo path dependencies), label = reference kind (for example `project-reference`). This happens at creation only; rescans never touch `uses` (only `code`), so after creation `uses` belongs to the curators.

### Worked examples
- **tasklogmd**: container `tasklog` (code: `.` minus nested manifests). Components `daemon`, `model`, `import` (depth-1 of `src/`; loose `cli.ts`, `client.ts` and the rest stay on the container). Ignored: `test/` (tests), `scripts/` (tooling/unowned), `docs/`, `assets/` (no code). Unowned code: `spikes/` and `scripts/`. **Known wrinkle**: `spikes/02-launch/stub/package.json` (`tasklogspike2`, `private`) is a named manifest, so the plain rule proposes it as a container and carves it out of `tasklog`. It is reviewable as `proposed`, and the rescan-after-deletion question (a deleted element being re-proposed) is for the match and merge ticket.
- **rpgengine**: containers `waymark-foundation`, `waymark-analyzers`, `waymark-abi-common`, `waymark-abi-selftest`. The 6 test csproj files are ignored. `native/Cargo.toml` is a `[workspace]`, so it is not a container. Foundation has 12 components (Allocation, Annotations, Config, Diagnostics, Fatal, Interop, Jobs, Lifecycle, Memory, Platform, Seams, Threading, Types); Analyzers has none. Unowned code: `build/*.mjs`. `uses` seeded from `ProjectReference` where present.
- **Gable** (npm workspaces): about 15 `packages/*` plus `examples/*` apps and `site` become containers. The 8 designer fixtures and the `create-gable` templates are ignored (fixtures/templates, not workspace members). `native/engine-harness`, if it holds a Cargo manifest, follows the plain rule. Inside `site/src`, any `app/`, `features/` or `pages/` directory is descended once; layers such as `components/` and `hooks/` stay components.

### Not covered (left to later tickets)
Whether a deleted element is re-proposed on rescan, how `code` paths are matched across renames, and the exact result format are tickets 02 and 03.
