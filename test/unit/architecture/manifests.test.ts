import { describe, expect, it } from 'vitest';
import {
  isManifestPath,
  parseAngularJson,
  parseCargo,
  parseCsproj,
  parseGoMod,
  parseNxProject,
  parsePackageJson,
  parsePnpmWorkspace,
} from '../../../src/architecture/manifests.ts';

describe('isManifestPath', () => {
  it.each([
    ['package.json', true],
    ['a/b/App.csproj', true],
    ['go.mod', true],
    ['crates/x/Cargo.toml', true],
    ['angular.json', true],
    ['libs/a/project.json', true],
    ['pnpm-workspace.yaml', true],
    ['tsconfig.json', false],
    ['src/index.ts', false],
  ])('%s -> %s', (p, expected) => expect(isManifestPath(p)).toBe(expected));
});

describe('parsePackageJson', () => {
  it('reads name, private, workspaces array and dependency names (CRLF and BOM tolerant)', () => {
    const text = '﻿{\r\n "name": "@x/app",\r\n "private": true,\r\n "workspaces": ["packages/*"],\r\n "dependencies": {"@x/lib": "*"},\r\n "devDependencies": {"vitest": "1"}\r\n}';
    expect(parsePackageJson(text)).toEqual({
      name: '@x/app',
      private: true,
      workspaces: ['packages/*'],
      deps: ['@x/lib', 'vitest'],
    });
  });
  it('reads the workspaces object form', () => {
    expect(parsePackageJson('{"workspaces":{"packages":["a/*","!a/skip"]}}')?.workspaces).toEqual(['a/*', '!a/skip']);
  });
  it('has no name when absent, and is null for invalid JSON', () => {
    expect(parsePackageJson('{}')?.name).toBeUndefined();
    expect(parsePackageJson('{nope')).toBeNull();
  });
});

describe('parseCsproj', () => {
  it('detects test projects and project references with backslash paths', () => {
    const text = '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup><ProjectReference Include="..\\Lib\\Lib.csproj" /></ItemGroup></Project>';
    expect(parseCsproj(text)).toEqual({ isTest: true, references: ['../Lib/Lib.csproj'] });
  });
  it('treats the test SDK reference as a test project', () => {
    expect(parseCsproj('<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="1"/></ItemGroup></Project>').isTest).toBe(true);
  });
  it('is not a test project by default', () => {
    expect(parseCsproj('<Project Sdk="Microsoft.NET.Sdk"></Project>')).toEqual({ isTest: false, references: [] });
  });
});

describe('parseGoMod', () => {
  it('takes the last module path segment, skipping a major-version suffix', () => {
    expect(parseGoMod('module github.com/acme/tool\n\ngo 1.22\n')?.name).toBe('tool');
    expect(parseGoMod('module github.com/acme/tool/v2\r\n')?.name).toBe('tool');
  });
  it('is null without a module line', () => {
    expect(parseGoMod('go 1.22')).toBeNull();
  });
});

describe('parseCargo', () => {
  it('reads the package name and path dependencies', () => {
    const text = '[package]\nname = "engine"\nversion = "0.1.0"\n\n[dependencies]\ncore = { path = "../core" }\nserde = "1"\n';
    expect(parseCargo(text)).toEqual({ name: 'engine', pathDeps: ['../core'] });
  });
  it('has no name for a workspace-only manifest', () => {
    expect(parseCargo('[workspace]\nmembers = ["a"]\n')).toEqual({ pathDeps: [] });
  });
});

describe('parseAngularJson', () => {
  it('lists projects with root and sourceRoot', () => {
    const text = JSON.stringify({ projects: { app: { root: '', sourceRoot: 'src' }, lib: { root: 'projects/lib', sourceRoot: 'projects/lib/src' }, old: 'projects/old' } });
    expect(parseAngularJson(text)).toEqual([
      { name: 'app', root: '', sourceRoot: 'src' },
      { name: 'lib', root: 'projects/lib', sourceRoot: 'projects/lib/src' },
      { name: 'old', root: 'projects/old' },
    ]);
  });
  it('is empty for invalid JSON', () => {
    expect(parseAngularJson('x')).toEqual([]);
  });
});

describe('parseNxProject', () => {
  it('reads name and sourceRoot', () => {
    expect(parseNxProject('{"name":"shop","sourceRoot":"apps/shop/src"}')).toEqual({ name: 'shop', sourceRoot: 'apps/shop/src' });
  });
  it('is null without a name', () => {
    expect(parseNxProject('{}')).toBeNull();
  });
});

describe('parsePnpmWorkspace', () => {
  it('reads the packages list', () => {
    expect(parsePnpmWorkspace("packages:\r\n  - 'packages/*'\r\n  - \"apps/*\"\r\n  - '!apps/skip'\r\n")).toEqual(['packages/*', 'apps/*', '!apps/skip']);
  });
});
