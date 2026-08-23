import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const managerRoot = path.resolve(__dirname, '..');

const preloadPath = path.join(managerRoot, 'dist-electron', 'preload.cjs');
const mainTsPath = path.join(managerRoot, 'electron', 'main.ts');

console.log('[verify-preload] Checking sandboxed Electron preload artifact...');

// 1. Check main.ts references preload.cjs
if (!existsSync(mainTsPath)) {
  console.error(`[verify-preload] ERROR: main.ts not found at ${mainTsPath}`);
  process.exit(1);
}
const mainTsContent = readFileSync(mainTsPath, 'utf8');
if (
  !mainTsContent.includes("'preload.cjs'") &&
  !mainTsContent.includes('"preload.cjs"')
) {
  console.error(
    `[verify-preload] ERROR: main.ts does not reference 'preload.cjs'`,
  );
  process.exit(1);
}

// 2. Check emitted preload.cjs exists
if (!existsSync(preloadPath)) {
  console.error(
    `[verify-preload] ERROR: Emitted preload file does not exist at ${preloadPath}`,
  );
  process.exit(1);
}

// 3. Check for forbidden top-level ESM statements
const content = readFileSync(preloadPath, 'utf8');
if (
  /^\s*import\s/m.test(content) ||
  (/^\s*export\s+(?!default|\*|\{|const|let|var|function|class)/m.test(
    content,
  ) &&
    !content.includes('require('))
) {
  console.error(
    '[verify-preload] ERROR: preload.cjs contains top-level ESM import/export statements.',
  );
  process.exit(1);
}

// 4. Run CommonJS syntax check via `node --check`
const checkResult = spawnSync(process.execPath, ['--check', preloadPath], {
  encoding: 'utf8',
});

if (checkResult.status !== 0) {
  console.error(
    '[verify-preload] ERROR: CommonJS syntax check (node --check) failed for preload.cjs:',
  );
  console.error(checkResult.stderr || checkResult.stdout);
  process.exit(1);
}

console.log(
  '[verify-preload] OK: preload.cjs is verified as valid CommonJS for sandboxed Electron.',
);
