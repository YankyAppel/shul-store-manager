# Development guide

## Runtime versions

Use the Node.js major declared in `.nvmrc` (Node 22, version 22.12 or newer). Electron bundles its own Node runtime when the desktop application runs, while repository tests and build tools execute with the host Node runtime. Both must support `node:sqlite`. CI reads the same `.nvmrc` declaration.

## Install and run

From the repository root:

```bash
npm install
npm run dev
```

The root script builds shared packages, starts Vite, and launches Electron when Vite is ready. Development state is written to Electron's `userData` location, never browser local storage.

## Database migrations

Migrations live in `packages/database/src/migrations.ts`. To change the schema:

1. append a migration with the next integer version;
2. never modify a migration already distributed to users;
3. make forward-compatible changes and preserve historical records;
4. add a fresh-database test and, where relevant, an upgrade-path test.

`StoreDatabase` applies pending migrations on startup inside transactions. SQLite's `user_version` is advanced only after a migration succeeds.

## Tests

Run all current tests:

```bash
npm test
```

Tests use isolated in-memory SQLite databases and cover fresh migration, category/product creation, unique and multiple barcodes, receiving, signed adjustments, calculated stock, rollback/idempotency, append-only enforcement, and history retention after deactivation.

## Before submitting changes

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Do not add APIs that expose arbitrary SQL or filesystem access to the renderer. Add a narrow IPC method, a shared schema/type, main-process validation, and tests for each new operation.
