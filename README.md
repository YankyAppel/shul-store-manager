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

## Milestone 3: Barcode label printing & printer settings

- Dependency-free Code 128 (subsets B and C) SVG rendering in `@shul-store/shared`
- Product labels with name, secondary name, price, barcode bars, and human-readable digits
- Thermal roll templates (40×30 mm, 57×32 mm) and Avery 5160 Letter sheets (30-up)
- Single-product and batch label printing with preview, quantities, and barcode choice
- Offline generation of an internal barcode when a product has none
- Persisted receipt/label printer preferences, 58/80 mm receipt width, and silent printing with dialog fallback

See [Label printing](docs/labels.md) for templates, printer behavior, and the desktop scan checklist.

## Optional cloud backup & sync

- **Optional, offline-first** Supabase cloud backup — the local SQLite database stays the single source of truth and all operations work with sync disabled or offline
- Transactional **append-only outbox** captures every write (migration 6); events are pushed in strict sequence order with idempotent cloud upserts
- Encrypted credential storage via Electron `safeStorage`; the renderer only ever sees a masked key hint
- Background sync engine: pushes on start + every 5 minutes + manual "Sync now", with exponential backoff and single-flight execution
- **Restore onto a fresh install** from the cloud (refused on a non-empty database), with Zod-validated payloads and integrity verification
- No new heavy runtime dependencies — plain HTTPS/PostgREST, no `supabase-js` SDK

See [Cloud sync](docs/cloud-sync.md) for architecture, the outbox design, cloud-side DDL + RLS, setup, restore, failure modes, and the desktop test checklist.

See [Local backups](docs/backups.md) for automatic verified SQLite backups,
rotation, migration safeguards, and local restore.

See [Daily reports](docs/reports.md) for end-of-day reporting, cash
reconciliation, and immutable local closes.

See [Returns and refunds](docs/refunds.md) for partial returns, tender rules,
account credits, and refund safeguards.

See [Windows packaging](docs/packaging.md) for installer builds, upgrades,
uninstallation, releases, and automatic update configuration.

## Requirements

- Node.js 22.13 or newer (use the version declared in `.nvmrc`)
- npm 10 or newer

Electron ships its own compatible Node runtime for the desktop application. Repository commands—tests, migrations, type checking, and builds—run in the host Node.js runtime and require Node 22.13+ because the database package uses `node:sqlite`.

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

See [Architecture](docs/architecture.md), [Checkout foundation](docs/checkout.md), [Receivables & Customer accounts](docs/receivables.md), and [Label printing](docs/labels.md) for boundaries and data design and [Development](docs/development.md) for workflow details.

## Milestone 4: "Pay now" Tender — Processor-Agnostic Payment Framework with Simulated Processor

- A crash-safe, write-ahead-logging (WAL) inspired charge lifecycle that guarantees no money is lost and no customer is double-charged.
- Support for "Pay now" integrated card tender in checkout and sales history.
- Integrated processor-agnostic `PaymentProcessor` adapter boundary that enforces PCI isolation.
- Simulated card processor implementation with deterministic responses (.01 decline, .02 error, .03 pending) for training and integration testing.
- Automatic recovery/reconciliation mechanism for unknown/pending charges via stored idempotency keys and cart snapshots.
- Dedicated `payment_transactions` tracking table fully integrated into the sync layer.
