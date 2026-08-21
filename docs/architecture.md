# Architecture

## Repository layout

```text
apps/
  manager/       Electron main/preload process and React renderer
  kiosk/         reserved for the future separately deployed kiosk
packages/
  shared/        validated IPC contracts and cross-application domain types
  database/      SQLite migrations and local business operations
  hardware/      future narrowly scoped hardware adapters
  payments/      future certified/semi-integrated provider adapters
  sync/          future outbox/event synchronization
```

Only `manager`, `shared`, and `database` contain runtime code in milestone 1. The other directories document future boundaries rather than shipping unused abstractions.

## Security boundary

The React renderer runs with context isolation and the Chromium sandbox enabled, with Node integration disabled. The preload exposes only the typed `StoreApi`. Every IPC handler uses a fixed channel and validates untrusted renderer values with Zod. There is no IPC channel for arbitrary SQL, filesystem paths, shell commands, or raw payment data.

Image selection occurs in the main process through an operating-system file dialog. Accepted images are size/type checked, copied into the application data directory, hashed, and registered in SQLite. The renderer receives an opaque image ID. A custom protocol resolves only registered IDs; it cannot read arbitrary paths.

A restrictive content-security policy is defined in `index.html`. New windows are denied, and unexpected navigation is blocked.

## Local authority and persistence

The manager database is the inventory authority. SQLite runs with foreign keys, a busy timeout, and WAL journaling. Migrations are ordered, versioned, and each migration is atomic. IDs are UUIDs, timestamps are UTC ISO-8601 strings, and money is integer cents.

Categories and products use soft activation flags, preserving references and history. A product may own many globally unique barcode values. An `SSM-...` internal value is generated offline with time and random components and is classified for Code 128 rendering.

## Inventory

Stock is never stored as a mutable product field. It is calculated as:

```sql
COALESCE(SUM(inventory_movements.quantity_change), 0)
```

Every movement has a UUID, idempotency/operation UUID, product, signed integer quantity, constrained reason, UTC time, and required notes. Related writes and audit insertion share a transaction. Database triggers reject updates and deletes to the movement table, providing defense beyond the application API. Corrections must be compensating movements.

## Future boundaries

- Checkout will record immutable sale-item snapshots so later product edits cannot alter history.
- Payment providers will be isolated adapters and may use only certified terminals or hosted tokenized flows. Raw card data is outside this application's boundary.
- Sync will use a transactional local outbox, globally unique events, server acknowledgement, and idempotent consumption—not row-level last-write-wins replication.
- A kiosk will be a separate Electron application with its own SQLite cache and revocable device identity.
- Printing will be a retryable operation separate from sale and payment completion.
