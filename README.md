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

Payment processing, checkout, customer accounts, receipt/label printing, kiosks, cloud sync, and subscriptions are intentionally not part of this milestone.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- an Electron/Node runtime with the built-in SQLite module (provided by this project’s dependencies)

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
