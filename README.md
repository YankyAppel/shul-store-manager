# Shul Store Manager

An offline-first desktop inventory and store-management application for small stores operated by shuls and shamosim.

## Milestone 1

This repository currently provides the Store Manager foundation:

- Electron + React + TypeScript manager application
- local SQLite database with explicit, transactional migrations
- categories and products, including local images, secondary-language names, integer-cent prices, tax status, low-stock levels, multiple barcodes, and soft deactivation
- offline generation of values suitable for Code 128 encoding
- append-only inventory movement ledger with receiving and manual adjustments
- calculated stock totals and audit records
- constrained, validated Electron IPC; the renderer has no Node, filesystem, or SQL access
- automated migration, catalog, barcode, rollback, and inventory tests

The checkout foundation also supports scanner/name product lookup, tax-inclusive or tax-exclusive cart totals, transactional cash and externally approved terminal sales, immutable sale snapshots, inventory deduction, receipt display/printing, and sales history. Integrated payment processing, refunds, customer accounts, label printing, kiosks, cloud sync, and subscriptions remain intentionally deferred.

## Requirements

- Node.js 22.12 or newer (use the version declared in `.nvmrc`)
- npm 10 or newer

Electron ships its own compatible Node runtime for the desktop application. Repository commands—tests, migrations, type checking, and builds—run in the host Node.js runtime and require Node 22.12+ because the database package uses `node:sqlite`.

## Local development

```bash
npm install
npm run dev
```

The manager stores its database and copied image files in Electron's OS-specific `userData` directory. It does not need a server or internet connection at runtime.

## Quality commands

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

See [Architecture](docs/architecture.md) for boundaries and data design and [Development](docs/development.md) for workflow details.
