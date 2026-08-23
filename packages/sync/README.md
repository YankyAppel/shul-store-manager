# Synchronization (`@shul-store/sync`)

Optional Supabase cloud backup & sync for the shul store manager.

The local SQLite database (in `@shul-store/database`) is always the single
source of truth. This package implements the cloud-side transport and the
background sync engine that durable-sends local outbox events to a user-supplied
Supabase project. It is **optional**: the app works identically with sync
disabled, offline, or mid-sync.

This package depends on `@shul-store/database` (for the outbox/restore helpers
and types) and `@shul-store/shared` (for the Zod schemas used to validate cloud
data on restore). It contains **no** third-party HTTP/Supabase SDK — only the
standard `fetch` API.

## What lives here

- `src/transport.ts` — the `SyncTransport` interface (`pushEvents`,
  `testConnection`, `listEvents`) and `SupabaseTransport`, a plain HTTPS /
  PostgREST implementation. Pushes are idempotent on `event_id`
  (`on_conflict=event_id` + `Prefer: resolution=ignore-duplicates`).
- `src/secret-store.ts` — the `SyncSecretStore` interface and a
  `PlaintextSyncSecretStore` fallback. The Electron main process supplies a
  `safeStorage`-backed implementation.
- `src/sync-engine.ts` — the background engine: pushes on start + every 5 min +
  manual trigger, bounded batches, strict sequence order, mark-after-ack,
  exponential backoff with jitter, single-flight.
- `src/restore.ts` — cloud-data validation (Zod) and orchestration that replays
  validated events onto a fresh local database through the guarded
  `@shul-store/database` restore path.

See [`docs/cloud-sync.md`](../../docs/cloud-sync.md) in the repository root for
the full architecture, outbox design, cloud-side DDL + RLS, setup, restore
procedure, failure modes, and the desktop test checklist.
