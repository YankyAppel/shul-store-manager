import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase, migrations } from '../src/index.js';

function tempFile(): string {
  return path.join(tmpdir(), `shul-sync-${randomUUID()}.sqlite`);
}

let store: StoreDatabase;
let file: string;

beforeEach(() => {
  file = tempFile();
  store = new StoreDatabase(file);
});

afterEach(() => {
  store.close();
  rmSync(file, { force: true });
});

describe('sync outbox migration & append-only guarantees', () => {
  it('adds sync_outbox and sync_settings tables with safe defaults on a fresh database', () => {
    expect(store.schemaVersion()).toBe(migrations.at(-1)?.version);
    const tables = store.connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_outbox','sync_settings')",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      'sync_outbox',
      'sync_settings',
    ]);

    const settings = store.connection
      .prepare('SELECT * FROM sync_settings WHERE singleton_id = 1')
      .get() as Record<string, unknown>;
    expect(settings).toMatchObject({
      enabled: 0,
      backfill_completed: 0,
      api_key_encrypted: 0,
      store_id: null,
      supabase_url: null,
      api_key_secret: null,
    });
  });

  it('enqueues events atomically with committed business writes', () => {
    const category = store.createCategory({ name: 'Bakery' });
    // createCategory enqueues a single category upsert (categories do not audit).
    expect(store.pendingSyncEventCount()).toBe(1);
    const events = store.exportOutboxSnapshot();
    expect(events[0]!.entityType).toBe('category');
    expect(events[0]!.entityId).toBe(category.id);

    const product = store.createProduct({
      categoryId: category.id,
      name: 'Challah',
      purchaseCostCents: 200,
      sellingPriceCents: 450,
      taxable: false,
      lowStockThreshold: 2,
      barcodes: ['CHALLAH-1'],
    });
    // product upsert + audit append.
    expect(store.pendingSyncEventCount()).toBe(3);
    const productEvent = store
      .exportOutboxSnapshot()
      .find((e) => e.entityType === 'product');
    expect(productEvent?.entityId).toBe(product.id);
    expect(productEvent?.operation).toBe('upsert');
    const auditEvent = store
      .exportOutboxSnapshot()
      .find((e) => e.entityType === 'audit_event');
    expect(auditEvent?.operation).toBe('append');
  });

  it('a failed business transaction enqueues no event (atomic rollback)', () => {
    const category = store.createCategory({ name: 'Drinks' });
    store.createProduct({
      categoryId: category.id,
      name: 'Juice',
      purchaseCostCents: 100,
      sellingPriceCents: 200,
      taxable: false,
      lowStockThreshold: 0,
      barcodes: ['JUICE-1'],
    });
    const before = store.pendingSyncEventCount();

    // Attempt a sale with no stock on hand -> the transaction must roll back,
    // leaving no sale/ledger/movement events.
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [
          {
            productId: store.listProducts()[0]!.id,
            quantity: 1,
            barcodeUsed: 'JUICE-1',
          },
        ],
        payment: { method: 'cash', cashReceivedCents: 500 },
      }),
    ).toThrow();

    expect(store.pendingSyncEventCount()).toBe(before);
    expect(
      store.exportOutboxSnapshot().some((e) => e.entityType === 'sale'),
    ).toBe(false);
  });

  it('makes the outbox append-only (no delete, no update except pushed_at)', () => {
    store.createCategory({ name: 'Books' });
    const raw = store.connection as unknown as DatabaseSync;
    expect(() =>
      raw.exec('DELETE FROM sync_outbox WHERE sequence = 1'),
    ).toThrow();
    expect(() =>
      raw.exec(
        "UPDATE sync_outbox SET entity_type = 'tampered' WHERE sequence = 1",
      ),
    ).toThrow();
    // Setting pushed_at is the only allowed mutation.
    expect(() =>
      raw.exec(
        "UPDATE sync_outbox SET pushed_at = '2026-01-01T00:00:00.000Z' WHERE sequence = 1",
      ),
    ).not.toThrow();
  });
});

describe('sync backfill', () => {
  it('snapshots all pre-existing data exactly once and is idempotent', () => {
    // Populate business data via raw SQL so nothing is enqueued yet — this
    // simulates rows that existed before the outbox migration (or before sync
    // was enabled). Backfill must capture each exactly once.
    const raw = store.connection as unknown as DatabaseSync;
    const t = '2026-01-01T00:00:00.000Z';
    const catId = randomUUID();
    raw
      .prepare(
        'INSERT INTO categories (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
      )
      .run(catId, 'Seforim', t, t);
    const prodId = randomUUID();
    raw
      .prepare(
        `INSERT INTO products (id, category_id, name, purchase_cost_cents, selling_price_cents, taxable, low_stock_threshold, active, created_at, updated_at) VALUES (?, ?, ?, 100, 300, 0, 0, 1, ?, ?)`,
      )
      .run(prodId, catId, 'Tehillim', t, t);
    raw
      .prepare(
        'INSERT INTO product_barcodes (id, product_id, value, kind, position, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      )
      .run(randomUUID(), prodId, 'TEH-1', 'EXTERNAL', t);
    raw
      .prepare(
        `INSERT INTO inventory_movements (id, operation_id, product_id, quantity_change, reason, occurred_at, notes, sequence) VALUES (?, ?, ?, 10, 'stock_received', ?, 'Opening', 1)`,
      )
      .run(randomUUID(), randomUUID(), prodId, t);
    // update settings so a settings snapshot exists
    store.updateSettings({
      ...store.getSettings(),
      storeName: 'My Shul Store',
    });

    expect(store.pendingSyncEventCount()).toBe(1); // only the settings update enqueued

    const enqueued = store.backfillOutbox();
    // category + product + inventory_movement (settings already enqueued, skipped;
    // audit_event table is empty here)
    expect(enqueued).toBe(3);
    expect(store.getSyncConfigRecord().backfillCompleted).toBe(true);

    const types = store
      .exportOutboxSnapshot()
      .map((e) => e.entityType)
      .sort();
    expect(types).toEqual(
      ['category', 'inventory_movement', 'product', 'settings'].sort(),
    );
    const settingsEvent = store
      .exportOutboxSnapshot()
      .find((event) => event.entityType === 'settings')!;
    expect(settingsEvent.payload).not.toHaveProperty('cardProcessorConfigJson');
    expect(settingsEvent.payload).not.toHaveProperty('updateFeedUrl');
    expect(settingsEvent.payload).not.toHaveProperty('automaticUpdatesEnabled');

    // Calling backfill again enqueues nothing (idempotent + completed flag).
    expect(store.backfillOutbox()).toBe(0);
  });
});
