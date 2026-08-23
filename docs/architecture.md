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
  sync/          optional Supabase cloud backup: outbox, transport, engine, restore
```

`manager`, `shared`, `database`, and `sync` contain runtime code. The `hardware` and `payments` directories document future boundaries rather than shipping unused abstractions.

## Security boundary

The React renderer runs with context isolation and the Chromium sandbox enabled, with Node integration disabled. The preload exposes only the typed `StoreApi`. Every IPC handler uses a fixed channel and validates untrusted renderer values with Zod. There is no IPC channel for arbitrary SQL, filesystem paths, shell commands, or raw payment data.

Image selection occurs in the main process through an operating-system file dialog. Accepted images are size/type checked, copied into the application data directory, hashed, and registered in SQLite. The renderer receives an opaque image ID. A custom protocol resolves only registered IDs; it cannot read arbitrary paths.

A restrictive content-security policy is defined in `index.html`. New windows are denied, and unexpected navigation is blocked.

## Local authority and persistence

The manager database is the inventory and customer ledger authority. SQLite runs with foreign keys, a busy timeout, and WAL journaling. Migrations are ordered, versioned, and each migration is atomic. IDs are UUIDs, timestamps are UTC ISO-8601 strings, and money is integer cents.

Categories, products, and customers use soft activation flags, preserving references and history. A product or customer may own globally unique barcode values. An `SSM-...` internal value is generated offline with time and random components and is classified for Code 128 rendering.

## Inventory

Stock is never stored as a mutable product field. It is calculated as:

```sql
COALESCE(SUM(inventory_movements.quantity_change), 0)
```

Every movement has a UUID, idempotency/operation UUID, product, signed integer quantity, constrained reason, UTC time, and required notes. Related writes and audit insertion share a transaction. Database triggers reject updates and deletes to the movement table, providing defense beyond the application API. Corrections must be compensating movements.

## Local checkout & Customer Receivables

Migration 3 adds store settings, sales, immutable sale-item snapshots, payments, and independent print attempts. Cash and staff-confirmed external-terminal sales complete in one idempotent transaction with their negative inventory movements and audit event. See [Checkout foundation](checkout.md) for status transitions, tax rounding, insufficient-stock policy, and printing failure behavior.

Migration 4 adds customer accounts, customer credit limits, "Put on Account" checkout, append-only customer account ledger with update/delete triggers, account payments, and customer statements. See [Customer accounts & Receivables](receivables.md) for data model details, balance conventions, credit limit enforcement, and payment rules.

Migration 5 adds receipt and label printer preferences (nullable device names, 58/80 mm receipt width, default label template). Label HTML and Code 128 SVG rendering live in `@shul-store/shared`. See [Label printing](labels.md).

## Optional cloud backup

Cloud backup (in `@shul-store/sync`) is optional and offline-first: the local SQLite database is always the single source of truth. A transactional append-only outbox (migration 6) captures every write as an ordered event with a globally unique id. A background engine in the Electron main process pushes events in strict sequence order to a user-supplied Supabase project using plain HTTPS/PostgREST with idempotent `event_id` upserts, never blocking or failing user operations. Restore onto a fresh install validates and replays cloud events through guarded paths. Credentials are encrypted with `safeStorage`; the renderer only ever sees a masked hint. Multi-device merge and kiosk LAN sync are deliberately out of scope here. See [Cloud sync](cloud-sync.md).

## Future boundaries

- Integrated payment providers will be isolated adapters and may use only certified terminals or hosted tokenized flows. Raw card data is outside this application's boundary.
- A kiosk will be a separate Electron application with its own SQLite cache and revocable device identity.
- Specialized ESC/POS raw commands and cash-drawer pulses remain out of scope; current printing uses a hidden BrowserWindow and the OS print path.
