# Optional Supabase Cloud Backup & Sync

Cloud backup is an **optional** feature. The application is offline-first: the
local SQLite database is always the single source of truth, and every existing
feature (checkout, payments, statements, label printing) works identically with
sync disabled, with sync enabled but the network down, and while a sync is in
progress. No user-facing operation ever blocks on, waits for, or fails because of
network or sync activity.

This milestone covers **single-manager-device** cloud backup and restore onto a
fresh install. It deliberately does **not** implement multi-device merge,
conflict resolution, or kiosk pairing (those are later, separate milestones).

## How it works (architecture)

```
 React renderer  ──IPC (typed, Zod-validated)──▶  Electron main process
   Settings:                                            │
   - enable / credentials                              ├──▶ StoreDatabase (local SQLite = source of truth)
   - status / sync now / restore                       │      └─ sync_outbox (append-only events)
   - restore (fresh install only)                      │
                                                       ├──▶ SyncEngine (background loop, single-flight)
                                                       │      └─ push in sequence order, bounded batches,
                                                       │         exponential backoff + jitter, marks pushed
                                                       │         only after the server acknowledges
                                                       │
                                                       └──▶ SupabaseTransport (HTTPS / PostgREST only)
                                                              └─ upsert idempotent on event_id;
                                                                 ordered read for restore
                                                                 Cloud: sync_events (JSONB event log)
```

- **All network activity happens in the Electron main process.** The renderer
  never makes network calls and never receives the API key in plaintext — it gets
  a boolean `configured`, a masked hint (`••••WXYZ`), and sanitized status.
- The renderer talks to the main process through the existing constrained,
  Zod-validated IPC surface (no arbitrary SQL, filesystem, or shell).
- Sandbox (`sandbox: true`), `contextIsolation: true`, `nodeIntegration: false`,
  and `webSecurity: true` are unchanged. The preload stays CommonJS (`.cjs`) and
  the `verify-preload` guard still passes.

## The outbox (transactional, append-only)

A new `sync_outbox` table (migration 6) captures every durable change as an
ordered event:

| column         | type   | notes                                                                                                                       |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `sequence`     | int pk | monotonically increasing local ordering key                                                                                 |
| `event_id`     | uuid   | globally unique; the cloud idempotency key                                                                                  |
| `entity_type`  | text   | `settings` \| `category` \| `product` \| `inventory_movement` \| `customer` \| `sale` \| `account_payment` \| `audit_event` |
| `entity_id`    | text   | the entity's id (`settings` for the singleton)                                                                              |
| `operation`    | text   | `upsert` (mutable entities) or `append` (immutable ledgers)                                                                 |
| `payload_json` | text   | JSON snapshot of the entity                                                                                                 |
| `created_at`   | text   | UTC ISO-8601                                                                                                                |
| `pushed_at`    | text?  | NULL until the cloud acknowledges                                                                                           |

### Atomicity with business writes

Each business write enqueues its outbox event(s) **inside the same SQLite
transaction** as the underlying write (`completeSale`, `recordAccountPayment`,
`addInventoryMovement`, product/category/customer mutations, settings, and the
`addAudit` call that accompanies them). Because the transaction is atomic, **an
event is enqueued if and only if the business write commits** — a failed
transaction (e.g. insufficient stock) leaves no event. SQLite runs with
`BEGIN IMMEDIATE`, WAL journaling, and a busy timeout, so commit order is
well-defined and the sequence reflects real commit order.

The outbox is append-only: database triggers reject `DELETE` and reject any
`UPDATE` that changes anything other than `pushed_at`. Replay and backfill are
idempotent.

### Event shape (what is captured)

Each logical business operation is one event whose payload is the full snapshot
of the resulting entity, including its atomic side effects:

- A **sale** event bundles the sale row, its immutable line items, its payment
  row (cash/terminal), the stock-deduction inventory movements, and (for account
  sales) the `sale_charge` ledger entry.
- An **account payment** event bundles the payment row and its `payment` ledger
  entry.
- Products include their barcodes; settings is the full store settings snapshot.

`sale_items`, `payments`, customer ledger entries, and inventory movements are
therefore represented inside their parent event (not as separate events). This
keeps each atomic operation as one replayable unit; restore reapplies the side
effects in dependency order so all foreign keys and triggers are satisfied.

### Backfill

The first time sync is enabled, `backfillOutbox()` snapshots **all** existing
data (settings, categories, products, customers, inventory movements, sales,
account payments, audit events) in dependency order in a single transaction that
also sets `backfill_completed`. It is idempotent: rows already in the outbox
(captured by enqueue-on-write) are skipped, so historical rows reach the cloud
exactly once. After backfill, new writes are captured automatically by
enqueue-on-write — even while sync is disabled — so re-enabling later pushes the
full backlog without losing anything.

> Images are explicitly **out of scope** for cloud sync. To preserve foreign-key
> integrity, restore inserts metadata-only image _stubs_ (the image protocol
> already returns 404 for missing files); the actual image files are not
> transferred.

## The sync engine

`SyncEngine` (in `@shul-store/sync`) runs entirely in the main process:

- **Loop:** when enabled, attempts a push every 5 minutes and immediately after
  app start; a manual **Sync now** action is also exposed.
- **Ordering & batching:** reads the oldest unpushed events in strict `sequence`
  order, bounded to 200 per cycle, and pushes them in that order.
- **Mark-after-ack:** marks `pushed_at` only after the server acknowledges. On
  failure the batch marks nothing, so the next cycle resumes from the same
  sequence — order is always preserved.
- **Idempotency:** the cloud upsert is idempotent on `event_id`
  (`on_conflict=event_id` + `Prefer: resolution=ignore-duplicates`), and
  `markOutboxPushed` only sets `pushed_at` when it is NULL. A crash between
  acknowledgement and marking is safe: the next cycle re-pushes and the cloud
  ignores the duplicates.
- **Retry:** exponential backoff with jitter (`computeBackoffDelay`) on failure,
  capped at the normal interval.
- **Single-flight:** at most one cycle runs at a time; concurrent triggers skip.
- **Never crashes, never blocks the UI** (the renderer is a separate process).

Status is exposed over IPC: enabled/disabled, last successful sync time, pending
event count, and a sanitized last error (no secrets).

## Restore onto a fresh install

Available **only** when the local database has no business rows. It:

1. validates connectivity and downloads all events for the store in sequence
   order;
2. **Zod-validates every payload** against the same schemas used for local writes
   before it touches the database (cloud data is untrusted);
3. replays events transactionally through **guarded inserts** that respect every
   foreign key, CHECK constraint, and trigger (`ON CONFLICT(id) DO NOTHING` for
   idempotency, but CHECK/FK/unique violations still raise and abort);
4. verifies integrity afterwards (foreign-key check, and recomputes each
   customer's ledger running balance, cross-checking it against the sale/account
   payment balance snapshots);
5. refuses with a clear message if local business data already exists — **no
   merging** in this milestone.

On success the restored device adopts the source store id and credentials, seeds
its local outbox with the restored events (marked already pushed), and resumes
pushing new changes from the restored sequence.

## Cloud-side schema (apply in your Supabase project)

Run this in the Supabase dashboard **SQL editor**. This milestone uses an
**events-only** log (a single append-only `sync_events` table). Trade-off: the
cloud stores the authoritative event stream, which is simple, fully idempotent,
and trivial to reason about, at the cost of not providing pre-normalized query
tables. Restore reconstructs normalized state by replaying events. If you later
need cloud-side analytics, add materialized/normalized tables populated from
`sync_events` without changing this contract.

```sql
create table if not exists sync_events (
  event_id   uuid primary key,                 -- cloud idempotency key
  store_id   uuid not null,                    -- the originating store
  sequence   bigint not null,                  -- local commit order
  entity_type text not null,
  entity_id  text not null,
  operation  text not null check (operation in ('upsert','append')),
  payload    jsonb not null,                   -- full entity snapshot
  created_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index if not exists sync_events_store_sequence_idx
  on sync_events (store_id, sequence);
```

### Row Level Security guidance

The simplest secure setup for this milestone is **one Supabase project per
store**, using a project API key (anon or service role) kept secret. Enable RLS
and allow that key to manage its events:

```sql
alter table sync_events enable row level security;

create policy "store manages its sync events"
  on sync_events for all
  using (true)
  with check (true);
```

The boundary is the dedicated project plus the secret key. Never expose the key
in the renderer or in version control.

For **multiple stores sharing one project**, do **not** use `using (true)`.
Instead scope rows to the store: mint a per-store API key/JWT that carries the
`store_id` as a custom claim, and write an RLS policy such as:

```sql
create policy "store reads its events" on sync_events
  for select using (auth.jwt() ->> 'store_id' = store_id::text);

create policy "store inserts its events" on sync_events
  for insert with check (auth.jwt() ->> 'store_id' = store_id::text);
```

(Use the `anon`/`service_role` key appropriate to your setup; the manager always
sends `apikey` and `Authorization: Bearer <key>` headers.)

## Setup walkthrough

1. **Create a Supabase project** at <https://supabase.com> (one project per
   store is recommended).
2. **Apply the DDL** above in the project's SQL editor.
3. **Copy the project URL** (Settings → API → Project URL) and an **API key**
   (Settings → API → `anon` or `service_role` key). Keep the key secret.
4. In the manager app, open **Settings → Cloud backup (optional)**, paste the
   URL and key, click **Test connection**, then **Save credentials** and enable
   automatic backup. The first enable backfills all existing data to the cloud.

The API key is encrypted at rest with Electron `safeStorage` when the OS
keychain is available. If encryption is unavailable, the key is stored as
plaintext and the UI warns you. The key is **never** logged and **never** sent to
the renderer in plaintext after entry.

## Restore procedure (fresh install)

On a new machine with a freshly installed, empty database:

1. Open **Settings → Cloud backup → Restore from cloud** (shown only when the
   local database is empty).
2. Enter the Supabase URL, API key, and the **Store ID** of the backup (shown in
   Settings on the original device).
3. Click **Restore from cloud**. The app downloads, validates, and replays the
   events, then verifies integrity and reports a summary.

After a successful restore the device becomes the active manager and resumes
pushing from the restored sequence.

## Failure modes

- **Network down / project unreachable:** pushes fail with backoff; the local
  store and all operations are unaffected. Events accumulate in the outbox and
  push when connectivity returns.
- **Authentication rejected / table missing:** the **Test connection** result and
  the sanitized last-error explain the cause; no data is lost.
- **Partial push then crash:** the cloud upsert is idempotent on `event_id`, so
  re-pushing is safe. `pushed_at` is only ever set (never cleared), so it never
  regresses.
- **Malformed/hostile cloud payload on restore:** Zod validation rejects it
  before the database is touched; if a payload is shape-valid but violates a
  database invariant, the replay transaction aborts and rolls back, leaving the
  database untouched. Integrity is re-verified after replay.
- **Restore attempted on a non-empty database:** refused with a clear message; no
  data is merged or overwritten.

## Manual desktop test checklist

Perform these on a real desktop build with a real Supabase project before
relying on cloud backup:

- [ ] **Enable:** Settings → Cloud backup. Enter URL + key, **Test connection**
      succeeds, **Save credentials**, enable. A Store ID appears.
- [ ] **Backfill:** after enabling on a store that already has data, all existing
      categories/products/customers/sales appear in the Supabase
      `sync_events` table (check via the Supabase table editor / SQL:
      `select entity_type, count(*) from sync_events group by entity_type;`).
- [ ] **Sync:** add a product and complete a sale. Click **Sync now** (or wait for
      the 5-minute cycle). The new events appear in the cloud; **pending events**
      returns to 0 and **Last successful sync** updates.
- [ ] **Offline:** disable the machine's network, complete several sales and
      payments, and confirm checkout/statements/label printing all work. The
      outbox accumulates pending events.
- [ ] **Kill network mid-sync:** with a large backlog, disconnect mid-push and
      reconnect. Sync resumes from the correct sequence with no duplicates
      (`count(distinct event_id) = count(*)` in the cloud).
- [ ] **Idempotency:** force a re-push of already-acknowledged events (e.g. clear
      `pushed_at` is not exposed in the UI; verify via the engine tests) — the
      cloud row count does not increase.
- [ ] **Fresh-install restore:** install the app on a clean machine (empty
      database). Use **Restore from cloud** with the URL, key, and Store ID.
      Confirm the catalog, customers, sales, statements, and **balances** match
      the original exactly. Confirm the restored device resumes pushing new
      changes.
- [ ] **Restore refused:** attempt restore on a machine that already has data —
      it is refused with a clear message and nothing changes.
- [ ] **Disable:** turn off cloud backup; confirm all operations still work and
      nothing is pushed.

Store settings sync contains only store-wide operational settings. It never
carries processor credentials, the update-feed URL, or the automatic-update
setting: these values are device-local and are not restored from cloud events.
