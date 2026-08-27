import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Both desktop apps load their built renderer through `loadFile`, i.e. a
 * file:// URL. A root-absolute asset path ("/assets/index.js") then resolves
 * against the filesystem root instead of the app directory, so the window
 * renders blank with no error in the main process. Assets must be relative.
 */
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const entrypoints = [
  path.join(repositoryRoot, 'apps', 'manager', 'dist', 'index.html'),
  path.join(repositoryRoot, 'apps', 'kiosk', 'dist', 'index.html'),
];

const absoluteReferencePattern = /(?:src|href)\s*=\s*["']\/(?!\/)[^"']*["']/g;
const failures = [];

for (const entrypoint of entrypoints) {
  if (!existsSync(entrypoint)) {
    failures.push(`${entrypoint} was not built`);
    continue;
  }
  const references = readFileSync(entrypoint, 'utf8').match(
    absoluteReferencePattern,
  );
  if (references) {
    failures.push(
      `${path.relative(repositoryRoot, entrypoint)} references assets by absolute path ` +
        `(${references.join(', ')}); set Vite's \`base\` to './'`,
    );
  }
}

if (failures.length > 0) {
  console.error('[verify-file-url-assets] ERROR:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  '[verify-file-url-assets] OK: both renderers reference their assets relatively.',
);
