import { describe, expect, it } from 'vitest';
import type { CloudEvent } from '@shul-store/shared';
import {
  SyncEngine,
  computeBackoffDelay,
  DEFAULT_BATCH_SIZE,
  parseRestoreEvent,
} from '../src/index.js';
import {
  createDb,
  createDeferred,
  disposeDb,
  enableSync,
  FakeTransport,
  populateStore,
  SharedCloudTransport,
  TEST_STORE_ID,
} from './helpers.js';

describe('sync engine push cycle', () => {
  it('pulls validated remote events, skips invalid rows, and advances the cursor', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    enableSync(db);
    const category = {
      eventId: '00000000-0000-0000-0000-000000000011',
      storeId: TEST_STORE_ID,
      deviceId: '00000000-0000-0000-0000-000000000099',
      cloudId: 2,
      sequence: 1,
      entityType: 'category' as const,
      entityId: '00000000-0000-0000-0000-000000000012',
      operation: 'upsert' as const,
      payload: {
        id: '00000000-0000-0000-0000-000000000012',
        name: 'Remote',
        secondaryName: null,
        imageId: null,
        active: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    transport.seed([
      {
        ...category,
        cloudId: 1,
        payload: { nope: true },
        eventId: '00000000-0000-0000-0000-000000000010',
      },
      category,
    ]);
    const engine = new SyncEngine(db, transport);

    const result = await engine.pullCycle();
    expect(result.error).toBeNull();
    expect(result.pulled).toBe(1);
    expect(db.listCategories().map((row) => row.name)).toContain('Remote');
    expect(db.getSyncConfigRecord().pullCursor).toBe(2);
    expect(transport.pullCallCount).toBe(1);
    disposeDb(db, file);
  });

  it('allocates a low local receipt after pulling another device range', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    enableSync(db);
    const category = db.createCategory({ name: 'Remote sale category' });
    const product = db.createProduct({
      categoryId: category.id,
      name: 'Remote sale product',
      purchaseCostCents: 100,
      sellingPriceCents: 200,
      taxable: false,
      lowStockThreshold: 1,
      barcodes: [],
    });
    db.addInventoryMovement({
      productId: product.id,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    const saleId = '00000000-0000-0000-0000-000000000061';
    transport.seed([
      parseRestoreEvent({
        cloudId: 1,
        eventId: '00000000-0000-0000-0000-000000000062',
        storeId: TEST_STORE_ID,
        deviceId: '00000000-0000-0000-0000-000000000063',
        sequence: 1,
        entityType: 'sale',
        entityId: saleId,
        operation: 'append',
        createdAt: '2024-01-01T00:00:00.000Z',
        payload: {
          id: saleId,
          receiptNumber: 2_000_001,
          completionKey: '00000000-0000-0000-0000-000000000064',
          status: 'completed',
          subtotalCents: 200,
          taxCents: 0,
          totalCents: 200,
          createdAt: '2024-01-01T00:00:00.000Z',
          completedAt: '2024-01-01T00:00:00.000Z',
          customerId: null,
          customerName: null,
          customerAccountNumber: null,
          customerBalanceBeforeCents: null,
          customerBalanceAfterCents: null,
          tenderType: 'cash',
          items: [
            {
              id: '00000000-0000-0000-0000-000000000065',
              productId: product.id,
              productName: product.name,
              secondaryName: null,
              barcodeUsed: null,
              quantity: 1,
              unitSellingPriceCents: 200,
              unitPurchaseCostCents: 100,
              taxable: false,
              taxCents: 0,
              lineSubtotalCents: 200,
              lineTotalCents: 200,
            },
          ],
          payment: {
            method: 'cash',
            amountCents: 200,
            cashReceivedCents: 200,
            changeDueCents: 0,
            terminalReference: null,
            externalApproved: null,
          },
          inventoryMovements: [],
          ledgerEntry: null,
        },
      }),
    ]);

    const pulled = await new SyncEngine(db, transport).pullCycle();
    expect(pulled.error).toBeNull();
    const localSale = db.completeSale({
      completionKey: '00000000-0000-0000-0000-000000000066',
      lines: [{ productId: product.id, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 200 },
    });
    expect(localSale.receiptNumber).toBe(1);
    disposeDb(db, file);
  });

  it('round-trips sales between two stores without duplicates or ledger drift', async () => {
    const first = createDb();
    const second = createDb();
    enableSync(first.db);
    enableSync(second.db);
    const firstDeviceId = '00000000-0000-0000-0000-000000000071';
    const secondDeviceId = '00000000-0000-0000-0000-000000000072';
    first.db.connection
      .prepare('UPDATE sync_settings SET device_id = ? WHERE singleton_id = 1')
      .run(firstDeviceId);
    second.db.connection
      .prepare('UPDATE sync_settings SET device_id = ? WHERE singleton_id = 1')
      .run(secondDeviceId);
    const populated = populateStore(first.db);
    const cloud = { nextId: 1, events: [] as CloudEvent[] };
    const firstEngine = new SyncEngine(
      first.db,
      new SharedCloudTransport(cloud, firstDeviceId),
    );
    const secondEngine = new SyncEngine(
      second.db,
      new SharedCloudTransport(cloud, secondDeviceId),
    );

    await firstEngine.pushCycle();
    await secondEngine.pullCycle();
    expect(second.db.listSales()).toHaveLength(2);
    expect(second.db.getCustomerBalance(populated.customerId)).toBe(0);

    second.db.completeSale({
      completionKey: '00000000-0000-0000-0000-000000000073',
      lines: [
        { productId: populated.productId, quantity: 1, barcodeUsed: null },
      ],
      payment: {
        method: 'account',
        customerId: populated.customerId,
        confirmed: true,
      },
    });
    await secondEngine.pushCycle();
    await firstEngine.pullCycle();
    await firstEngine.pullCycle();
    await secondEngine.pullCycle();

    expect(first.db.listSales()).toHaveLength(3);
    expect(second.db.listSales()).toHaveLength(3);
    expect(first.db.getCustomerBalance(populated.customerId)).toBe(399);
    expect(second.db.getCustomerBalance(populated.customerId)).toBe(399);
    expect(new Set(first.db.listSales().map((sale) => sale.id)).size).toBe(3);
    expect(new Set(second.db.listSales().map((sale) => sale.id)).size).toBe(3);
    disposeDb(first.db, first.file);
    disposeDb(second.db, second.file);
  });

  it('does not let an older remote upsert overwrite local data', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    enableSync(db);
    const local = db.createCategory({ name: 'Local' });
    const event = {
      eventId: '00000000-0000-0000-0000-000000000021',
      cloudId: 1,
      storeId: TEST_STORE_ID,
      deviceId: '00000000-0000-0000-0000-000000000099',
      sequence: 1,
      entityType: 'category' as const,
      entityId: local.id,
      operation: 'upsert' as const,
      payload: {
        id: local.id,
        name: 'Old remote',
        secondaryName: null,
        imageId: null,
        active: true,
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      },
      createdAt: '2023-01-01T00:00:00.000Z',
    };
    transport.seed([event]);
    await new SyncEngine(db, transport).pullCycle();
    expect(db.listCategories().find((row) => row.id === local.id)?.name).toBe(
      'Local',
    );
    expect(
      (
        db.connection.prepare('SELECT source FROM sync_conflicts').get() as {
          source: string;
        }
      ).source,
    ).toBe('remote');
    disposeDb(db, file);
  });

  it('never clears a local kiosk revocation with a newer remote copy', () => {
    const { db, file } = createDb();
    enableSync(db);
    const kioskId = '00000000-0000-0000-0000-000000000031';
    db.createKiosk(kioskId, 'Front kiosk', 'local-token', 'local-pin');
    db.revokeKiosk(kioskId);
    const outboxBefore = db.pendingSyncEventCount();
    const event = parseRestoreEvent({
      cloudId: 1,
      eventId: '00000000-0000-0000-0000-000000000032',
      storeId: TEST_STORE_ID,
      deviceId: '00000000-0000-0000-0000-000000000099',
      sequence: 1,
      entityType: 'kiosk',
      entityId: kioskId,
      operation: 'upsert',
      createdAt: '2024-01-01T00:00:00.000Z',
      payload: {
        id: kioskId,
        name: 'Renamed elsewhere',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z',
        revokedAt: null,
      },
    });

    db.applyPulledEvents([event]);
    expect(db.listKiosks()[0].revokedAt).not.toBeNull();
    expect(db.listKiosks()[0].name).toBe('Front kiosk');
    expect(db.pendingSyncEventCount()).toBe(outboxBefore);
    disposeDb(db, file);
  });

  it('always applies a remote kiosk revocation, even with an older timestamp', () => {
    const { db, file } = createDb();
    enableSync(db);
    const kioskId = '00000000-0000-0000-0000-000000000041';
    db.createKiosk(kioskId, 'Front kiosk', 'local-token', 'local-pin');
    const event = parseRestoreEvent({
      cloudId: 1,
      eventId: '00000000-0000-0000-0000-000000000042',
      storeId: TEST_STORE_ID,
      deviceId: '00000000-0000-0000-0000-000000000099',
      sequence: 1,
      entityType: 'kiosk',
      entityId: kioskId,
      operation: 'upsert',
      createdAt: '2024-01-01T00:00:00.000Z',
      payload: {
        id: kioskId,
        name: 'Front kiosk',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        revokedAt: '2024-01-01T00:00:00.000Z',
      },
    });

    db.applyPulledEvents([event]);
    expect(db.listKiosks()[0].revokedAt).toBe('2024-01-01T00:00:00.000Z');
    disposeDb(db, file);
  });

  it('pushes events strictly in sequence order in bounded batches', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport, { batchSize: 2 });
    enableSync(db);

    // Five categories -> five ordered outbox events (seq 1..5).
    for (let i = 0; i < 5; i += 1) db.createCategory({ name: `Cat ${i}` });
    expect(db.pendingSyncEventCount()).toBe(5);

    const r1 = await engine.pushCycle();
    expect(r1.pushed).toBe(2);
    expect(r1.remaining).toBe(3);
    const r2 = await engine.pushCycle();
    expect(r2.pushed).toBe(2);
    expect(r2.remaining).toBe(1);
    const r3 = await engine.pushCycle();
    expect(r3.pushed).toBe(1);
    expect(r3.remaining).toBe(0);

    // No further work.
    const r4 = await engine.pushCycle();
    expect(r4.pushed).toBe(0);

    // All events were received in ascending sequence order.
    const all = db.exportOutboxSnapshot();
    const receivedSequences = transport.receivedEventIds.map(
      (id) => all.find((e) => e.eventId === id)!.sequence,
    );
    expect(receivedSequences).toEqual([1, 2, 3, 4, 5]);
    disposeDb(db, file);
  });

  it('marks nothing on a failed batch and resumes from the same sequence', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport, { batchSize: 10 });
    enableSync(db);

    for (let i = 0; i < 3; i += 1) db.createCategory({ name: `Cat ${i}` });
    transport.failOnCall = [1]; // first push fails

    const failed = await engine.pushCycle();
    expect(failed.error).not.toBeNull();
    expect(failed.pushed).toBe(0);
    expect(db.pendingSyncEventCount()).toBe(3); // nothing marked
    expect(db.getSyncConfigRecord().lastError).not.toBeNull();

    transport.failOnCall = [];
    const ok1 = await engine.pushCycle();
    expect(ok1.pushed).toBe(3);
    expect(db.pendingSyncEventCount()).toBe(0);
    expect(db.getSyncConfigRecord().lastError).toBeNull();
    expect(db.getSyncConfigRecord().lastSyncAt).not.toBeNull();
    disposeDb(db, file);
  });

  it('re-pushing already-acknowledged events does not duplicate', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport);
    enableSync(db);

    db.createCategory({ name: 'Once' });
    await engine.pushCycle();
    expect(transport.events.size).toBe(1);
    expect(db.pendingSyncEventCount()).toBe(0);

    // Simulate a crash between acknowledgement and marking: re-queue the event
    // by clearing pushed_at (the only mutable outbox column).
    const raw = db.connection as unknown as {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };
    raw.prepare('UPDATE sync_outbox SET pushed_at = NULL').run();

    const pushedAtBefore = (
      db.connection
        .prepare('SELECT pushed_at FROM sync_outbox WHERE sequence = 1')
        .get() as { pushed_at: string | null }
    ).pushed_at;
    expect(pushedAtBefore).toBeNull();

    await engine.pushCycle(); // re-pushes the same event id
    expect(transport.events.size).toBe(1); // cloud still has exactly one
    const pushedAtAfter = (
      db.connection
        .prepare('SELECT pushed_at FROM sync_outbox WHERE sequence = 1')
        .get() as { pushed_at: string | null }
    ).pushed_at;
    expect(pushedAtAfter).not.toBeNull(); // marked (not regressed)
    disposeDb(db, file);
  });

  it('no-ops when sync is disabled or unconfigured', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport);
    // Not configured: no store id / credentials.
    db.createCategory({ name: 'X' });
    const result = await engine.pushCycle();
    expect(result.pushed).toBe(0);
    expect(transport.pushCallCount).toBe(0);
    disposeDb(db, file);
  });

  it('keeps queued events while entitlement pauses sync and resumes later', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    let allowed = false;
    const engine = new SyncEngine(db, transport, {
      canSync: () => allowed,
    });
    enableSync(db);
    db.createCategory({ name: 'Queued offline' });

    const paused = await engine.pushCycle();
    expect(paused.error).toContain('subscription');
    expect(paused.pushed).toBe(0);
    expect(db.pendingSyncEventCount()).toBe(1);
    expect(transport.pushCallCount).toBe(0);

    allowed = true;
    const resumed = await engine.pushCycle();
    expect(resumed.pushed).toBe(1);
    expect(db.pendingSyncEventCount()).toBe(0);
    disposeDb(db, file);
  });

  it('keeps legacy pasted sync credentials active before cloud onboarding', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    enableSync(db);
    db.createCategory({ name: 'Legacy configured' });
    const engine = new SyncEngine(db, transport, { canSync: () => true });

    const result = await engine.pushCycle();
    expect(result.pushed).toBe(1);
    expect(db.pendingSyncEventCount()).toBe(0);
    disposeDb(db, file);
  });

  it('respects single-flight: a concurrent syncNow is skipped', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const gate = createDeferred<void>();
    transport.pushGate = gate.promise;
    const engine = new SyncEngine(db, transport);
    enableSync(db);
    db.createCategory({ name: 'Concurrent' });

    const inFlight = engine.pushCycle(); // blocks on the gate
    const concurrent = await engine.syncNow(); // must not run concurrently
    expect(concurrent.skipped).toBe(true);

    gate.resolve();
    const result = await inFlight;
    expect(result.pushed).toBe(1);
    disposeDb(db, file);
  });
});

describe('backoff scheduling', () => {
  it('grows exponentially, caps at the interval, and applies jitter', () => {
    const base = 30_000;
    const max = 5 * 60 * 1000;
    expect(
      computeBackoffDelay(1, { baseMs: base, maxMs: max, random: () => 0 }),
    ).toBe(base);
    expect(
      computeBackoffDelay(2, { baseMs: base, maxMs: max, random: () => 0 }),
    ).toBe(base * 2);
    expect(
      computeBackoffDelay(3, { baseMs: base, maxMs: max, random: () => 0 }),
    ).toBe(base * 4);
    // Capped at maxMs plus up to one base of jitter.
    const capped = computeBackoffDelay(20, {
      baseMs: base,
      maxMs: max,
      random: () => 0.5,
    });
    expect(capped).toBe(max + Math.floor(0.5 * base));
    // Bounds with full jitter.
    const hi = computeBackoffDelay(1, {
      baseMs: base,
      maxMs: max,
      random: () => 0.999,
    });
    const lo = computeBackoffDelay(1, {
      baseMs: base,
      maxMs: max,
      random: () => 0,
    });
    expect(lo).toBe(base);
    expect(hi).toBeLessThan(base + base);
  });

  it('uses sensible engine defaults', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(200);
    const delay = computeBackoffDelay(1, { random: () => 0 });
    expect(delay).toBeGreaterThan(0);
  });
});
