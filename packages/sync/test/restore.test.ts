import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CloudEvent } from '@shul-store/shared';
import { parseRestoreEvent, restoreFromCloud } from '../src/index.js';
import {
  createDb,
  disposeDb,
  enableSync,
  FakeTransport,
  outboxToCloudEvents,
  populateStore,
  TEST_STORE_ID,
} from './helpers.js';

describe('restore validation', () => {
  it('rejects malformed cloud payloads before touching the database', () => {
    const good = {
      eventId: randomUUID(),
      storeId: TEST_STORE_ID,
      sequence: 1,
      entityType: 'category' as const,
      entityId: randomUUID(),
      operation: 'upsert' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        id: randomUUID(),
        name: 'Valid',
        secondaryName: null,
        imageId: null,
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    expect(parseRestoreEvent(good).entityType).toBe('category');

    expect(() =>
      parseRestoreEvent({ ...good, eventId: 'not-a-uuid' }),
    ).toThrow();
    expect(() => parseRestoreEvent({ ...good, sequence: -1 })).toThrow();
    expect(() =>
      parseRestoreEvent({ ...good, entityType: 'bogus' as never }),
    ).toThrow();
    expect(() =>
      parseRestoreEvent({ ...good, operation: 'delete' as never }),
    ).toThrow();
    expect(() =>
      parseRestoreEvent({ ...good, payload: { ...good.payload, name: '' } }),
    ).toThrow();
    expect(() =>
      parseRestoreEvent({ ...good, payload: { wrong: 'shape' } }),
    ).toThrow();
  });

  it('refuses to restore when the local database is not empty', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    db.createCategory({ name: 'Existing' }); // makes the db non-empty
    const result = await restoreFromCloud(db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.message).toMatch(/fresh installation/i);
    disposeDb(db, file);
  });

  it('reports a clear failure when there are no cloud events', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport(); // empty
    const result = await restoreFromCloud(db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No cloud events/i);
    disposeDb(db, file);
  });

  it('aborts and rolls back when cloud data fails validation', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    transport.seed([
      {
        eventId: randomUUID(),
        storeId: TEST_STORE_ID,
        sequence: 1,
        entityType: 'category',
        entityId: randomUUID(),
        operation: 'upsert',
        createdAt: '2026-01-01T00:00:00.000Z',
        payload: { name: 'missing id and other fields' },
      },
    ]);
    const result = await restoreFromCloud(db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/validation failed/i);
    // Database remains empty / untouched.
    expect(db.isRestoreAllowed()).toBe(true);
    disposeDb(db, file);
  });
});

describe('restore round-trip', () => {
  it('reproduces catalog, customers, sales, ledgers, and balances exactly', async () => {
    // 1. Build a populated source store and capture its outbox as the "cloud".
    const source = createDb();
    enableSync(source.db);
    source.db.backfillOutbox(); // ensure settings + everything is captured
    const ids = populateStore(source.db);
    // A couple of extra writes after backfill still reach the cloud via enqueue.
    source.db.createCategory({ name: 'Extra Category' });

    const cloudEvents: CloudEvent[] = outboxToCloudEvents(
      source.db.exportOutboxSnapshot(),
    );
    expect(cloudEvents.length).toBeGreaterThan(0);

    // 2. Restore into a fresh, empty database via the fake transport.
    const target = createDb();
    const transport = new FakeTransport();
    transport.seed(cloudEvents);
    const result = await restoreFromCloud(target.db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(true);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.categories).toBeGreaterThanOrEqual(2);
    expect(result.summary!.products).toBe(1);
    expect(result.summary!.customers).toBe(1);
    expect(result.summary!.sales).toBe(2);
    expect(result.summary!.accountPayments).toBe(1);
    expect(result.summary!.integrityChecks.length).toBeGreaterThan(0);

    // 3. Compare source and target business state.
    expect(target.db.getSettings().storeName).toBe('Test Shul');
    expect(
      target.db
        .listCategories()
        .map((c) => c.name)
        .sort(),
    ).toEqual(
      source.db
        .listCategories()
        .map((c) => c.name)
        .sort(),
    );

    const srcProduct = source.db.listProducts()[0]!;
    const tgtProduct = target.db
      .listProducts()
      .find((p) => p.id === ids.productId)!;
    expect(tgtProduct).toMatchObject({
      name: 'Grape Juice',
      sellingPriceCents: 399,
      stockQuantity: srcProduct.stockQuantity, // 100 - 2 - 1 = 97
    });
    expect(tgtProduct.barcodes.map((b) => b.value)).toEqual(['GRAPE-001']);

    // Customer balance recomputed from the ledger must match the source.
    expect(target.db.getCustomerBalance(ids.customerId)).toBe(
      source.db.getCustomerBalance(ids.customerId),
    );

    // Sales reproduce exactly (cash + account tenders).
    const tgtSales = target.db.listSales();
    const srcSales = source.db.listSales();
    expect(tgtSales.length).toBe(srcSales.length);
    expect(tgtSales.map((s) => s.totalCents).sort()).toEqual(
      srcSales.map((s) => s.totalCents).sort(),
    );
    expect(tgtSales.some((s) => s.payment.method === 'account')).toBe(true);

    // Ledger entries reproduce exactly (balances recomputed from replay).
    const tgtLedger = target.db.listCustomerLedger(ids.customerId);
    const srcLedger = source.db.listCustomerLedger(ids.customerId);
    expect(tgtLedger.length).toBe(srcLedger.length);
    expect(
      tgtLedger.map((e) => ({ amount: e.amountCents, type: e.entryType })),
    ).toEqual(
      srcLedger.map((e) => ({ amount: e.amountCents, type: e.entryType })),
    );

    // 4. The restored device resumes pushing from the restored sequence and
    //    only new writes are pending.
    const restoredMaxSeq = source.db.syncOutboxMaxSequence();
    expect(target.db.syncOutboxMaxSequence()).toBe(restoredMaxSeq);
    expect(target.db.pendingSyncEventCount()).toBe(0); // restored events marked pushed
    target.db.createCategory({ name: 'After restore' });
    expect(target.db.pendingSyncEventCount()).toBeGreaterThan(0);

    disposeDb(source.db, source.file);
    disposeDb(target.db, target.file);
  });
});
