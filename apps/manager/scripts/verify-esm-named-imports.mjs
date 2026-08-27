import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The packaged main process runs as ESM, where a named import from a CommonJS
 * dependency fails at instantiation time — before any of our code runs, so the
 * app dies on launch with a SyntaxError. Type checking does not catch it,
 * because TypeScript resolves those names from the package's type declarations.
 * This check resolves every named import in the compiled main process the way
 * Node does at runtime.
 *
 * `electron` is skipped: it only resolves inside the Electron runtime, and its
 * bindings are provided by Electron's own ESM loader. Workspace packages are
 * skipped too: they are our own ESM builds, and importing them here would run
 * their module initialisation during the build.
 */
const SKIPPED_SPECIFIERS = new Set(['electron']);
const SKIPPED_PREFIXES = ['node:', '@shul-store/'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(__dirname, '..', 'dist-electron');

const namedImportPattern =
  /import\s*\{([^}]*)\}\s*from\s*['"]([^'".][^'"]*)['"]/gs;

function collectNamedImports(source) {
  const imports = new Map();
  for (const match of source.matchAll(namedImportPattern)) {
    const specifier = match[2];
    if (
      SKIPPED_SPECIFIERS.has(specifier) ||
      SKIPPED_PREFIXES.some((prefix) => specifier.startsWith(prefix))
    )
      continue;
    const names = match[1]
      .split(',')
      .map((entry) =>
        entry
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter((name) => name.length > 0 && name !== 'type');
    const existing = imports.get(specifier) ?? new Set();
    for (const name of names) existing.add(name);
    imports.set(specifier, existing);
  }
  return imports;
}

const failures = [];

for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const filePath = path.join(outputDirectory, entry.name);
  const imports = collectNamedImports(readFileSync(filePath, 'utf8'));
  for (const [specifier, names] of imports) {
    let namespace;
    try {
      namespace = await import(specifier);
    } catch (reason) {
      failures.push(
        `${entry.name}: cannot import '${specifier}': ${String(reason)}`,
      );
      continue;
    }
    for (const name of names) {
      if (!(name in namespace)) {
        failures.push(
          `${entry.name}: '${specifier}' has no named export '${name}'. ` +
            `It is CommonJS — import the default export and destructure instead.`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify-esm-named-imports] ERROR:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  '[verify-esm-named-imports] OK: every named import in the compiled main process resolves as ESM.',
);
