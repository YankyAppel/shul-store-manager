# Shul Store Manager

An offline-first desktop inventory and store-management application for small stores operated by shuls and shamosim.

## Milestone 1: Inventory & Checkout Foundation

- Electron + React + TypeScript manager application
- Local SQLite database with explicit, transactional migrations
- Categories and products, including local images, secondary-language names, integer-cent prices, tax status, low-stock levels, multiple barcodes, and soft deactivation
- Offline generation of values suitable for Code 128 encoding
- Append-only inventory movement ledger with receiving and manual adjustments
- Calculated stock totals and audit records
- Constrained, validated Electron IPC; the renderer has no Node, filesystem, or SQL access
- Transactional cash and externally approved terminal sales, immutable sale snapshots, inventory deduction, receipt display/printing, and sales history

## Milestone 2: Customer Accounts & Receivables

- Customer accounts management with offline account number and Code 128 barcode generation
- Soft customer deactivation and charge blocking
- Append-only customer account ledger with SQLite trigger enforcement
- Consistent balance sign convention: positive balance = amount owed, negative balance = customer credit
- Store-wide and customer-specific credit limits with automatic checkout enforcement
- "Put on Account" checkout option with atomic inventory deduction and ledger charging
- Later account payments (cash with change calculation and externally approved card terminals)
- Configurable overpayment policy for customer credits
- Account sale and account payment receipts showing previous and new balances
- Filterable customer statements (last 30 days, 90 days, all activity, custom date range) with opening and closing balances
- Full idempotency across sales and account payments

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

See [Architecture](docs/architecture.md), [Checkout foundation](docs/checkout.md), [Receivables & Customer accounts](docs/receivables.md) for boundaries and data design and [Development](docs/development.md) for workflow details.
