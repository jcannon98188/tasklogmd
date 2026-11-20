// Shared loader for the synthetic architecture fixtures (test/fixtures/architecture/<name>/tree.json).
// Unit tests feed `detectInput` to `detect`; the integration tests (later slices) can materialise `tree`
// into a temp workspace. Real repos (tasklogmd, rpgengine, Gable) are cited in comments only.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isManifestPath } from '../src/architecture/manifests.ts';
import type { DetectInput } from '../src/architecture/types.ts';

export const FIXTURE_NAMES = ['single-package', 'dotnet-multi', 'npm-workspaces', 'angular-nx', 'no-git', 'unowned'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export const fixtureDir = (name: FixtureName): string => fileURLToPath(new URL(`./fixtures/architecture/${name}/`, import.meta.url));

export interface Fixture {
  /** Repo-relative path -> file contents. */
  tree: Record<string, string>;
  detectInput: DetectInput;
}

export function loadFixture(name: FixtureName): Fixture {
  const parsed = JSON.parse(readFileSync(`${fixtureDir(name)}tree.json`, 'utf8')) as { files: Record<string, string> };
  const tree = parsed.files;
  const files = Object.keys(tree);
  const manifests: Record<string, string> = {};
  for (const f of files) if (isManifestPath(f)) manifests[f] = tree[f]!;
  return { tree, detectInput: { files, manifests } };
}
