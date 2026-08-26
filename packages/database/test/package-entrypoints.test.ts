import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

function packageManifestPaths(directory: string): string[] {
  return readdirSync(path.join(repositoryRoot, directory), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.join(repositoryRoot, directory, entry.name, 'package.json'),
    )
    .filter((manifestPath) => {
      try {
        readFileSync(manifestPath);
        return true;
      } catch {
        return false;
      }
    });
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
}

describe('workspace package entrypoints', () => {
  it('do not expose TypeScript source files as runtime or type entrypoints', () => {
    const manifests = [
      ...packageManifestPaths('packages'),
      ...packageManifestPaths('apps'),
    ];

    for (const manifestPath of manifests) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        main?: string;
        types?: string;
        exports?: unknown;
      };
      const targets = [
        manifest.main,
        manifest.types,
        ...exportTargets(manifest.exports),
      ].filter((target): target is string => typeof target === 'string');

      expect(
        targets.some(
          (target) => target.endsWith('.ts') && !target.endsWith('.d.ts'),
        ),
        `${manifest.name ?? manifestPath} exposes a TypeScript entrypoint`,
      ).toBe(false);
    }
  });
});
