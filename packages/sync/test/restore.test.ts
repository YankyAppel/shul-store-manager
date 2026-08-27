import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  syncEntityTypeSchema,
  type CloudEvent,
  type RefundPayload,
} from '@shul-store/shared';
import {
  parseRestoreEvent,
  restoreFromCloud,
  PAYLOAD_SCHEMA_BY_TYPE,
} from '../src/index.js';
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
  it('keeps a payload schema for every sync entity type', () => {
    for (const entityType of syncEntityTypeSchema.options) {
      expect(PAYLOAD_SCHEMA_BY_TYPE[entityType]).toBeDefined();
    }
  });
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

  it('accepts legacy device-setting keys but ignores them during restore', async () => {
    const { db, file } = createDb();
    const settings = db.getSettings();
    const event: CloudEvent = {
      eventId: randomUUID(),
      storeId: TEST_STORE_ID,
      sequence: 1,
      entityType: 'settings',
      entityId: 'settings',
      operation: 'upsert',
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        ...settings,
        storeName: 'Restored Shul',
        cardProcessorConfigJson: '{"secret":"must-ignore"}',
        updateFeedUrl: 'https://attacker.example/feed',
        automaticUpdatesEnabled: false,
      } as never,
    };
    const parsed = parseRestoreEvent(event);
    expect(parsed.payload).not.toHaveProperty('cardProcessorConfigJson');
    expect(parsed.payload).not.toHaveProperty('updateFeedUrl');
    expect(parsed.payload).not.toHaveProperty('automaticUpdatesEnabled');
    const transport = new FakeTransport();
    transport.seed([event]);
    const result = await restoreFromCloud(db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(true);
    expect(db.getSettings().storeName).toBe('Restored Shul');
    expect(db.getDeviceSettings()).toEqual({
      updateFeedUrl: null,
      automaticUpdatesEnabled: true,
      idleLockMinutes: 5,
      staffModeEnabled: false,
    });
    expect(db.getCardProcessorConfigStatus().configured).toBe(false);
    disposeDb(db, file);
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
    source.db.updateDeviceSettings({
      ...source.db.getDeviceSettings(),
      automaticUpdatesEnabled: false,
    });
    source.db.backfillOutbox(); // ensure settings + everything is captured
    const ids = populateStore(source.db);
    // A couple of extra writes after backfill still reach the cloud via enqueue.
    source.db.createCategory({ name: 'Extra Category' });
    const accountSale = source.db
      .listSales()
      .find((sale) => sale.payment.method === 'account')!;
    source.db.recordRefund({
      operationId: randomUUID(),
      saleId: accountSale.id,
      items: [
        {
          saleItemId: accountSale.items[0]!.id,
          quantity: 1,
          restocked: true,
        },
      ],
      reason: 'Cloud round-trip return',
    });

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
    expect(result.summary!.refunds).toBe(1);
    expect(result.summary!.integrityChecks.length).toBeGreaterThan(0);

    // 3. Compare source and target business state.
    expect(target.db.getSettings().storeName).toBe('Test Shul');
    expect(target.db.getDeviceSettings().automaticUpdatesEnabled).toBe(true);
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
    expect(target.db.listRefunds(accountSale.id)).toHaveLength(1);

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

  it('restores kiosk identity, kiosk sale, and card attribution without dangling references', async () => {
    const source = createDb();
    enableSync(source.db);
    source.db.updateSettings({
      ...source.db.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    const category = source.db.createCategory({ name: 'Drinks' });
    const product = source.db.createProduct({
      categoryId: category.id,
      name: 'Water',
      purchaseCostCents: 50,
      sellingPriceCents: 100,
      taxable: false,
      lowStockThreshold: 1,
      barcodes: ['WATER-1'],
    });
    source.db.addInventoryMovement({
      productId: product.id,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    const kioskId = randomUUID();
    source.db.createKiosk(kioskId, 'Front kiosk', 'token-hash', 'pin-hash');
    const chargeReference = randomUUID();
    const idempotencyKey = randomUUID();
    const snapshot = {
      lines: [
        {
          productId: product.id,
          quantity: 1,
          barcodeUsed: 'WATER-1',
          productName: 'Water',
          secondaryName: null,
          unitSellingPriceCents: 100,
          unitPurchaseCostCents: 50,
          taxable: false,
          unitPriceCents: 100,
          subtotalCents: 100,
          taxCents: 0,
          totalCents: 100,
        },
      ],
      totals: { subtotalCents: 100, taxCents: 0, totalCents: 100 },
    };
    source.db.createPaymentTransaction(
      chargeReference,
      'simulated',
      100,
      JSON.stringify(snapshot),
      idempotencyKey,
      kioskId,
      [{ productId: product.id, quantity: 1 }],
    );
    await source.db.getProcessorStorage().set(chargeReference, {
      status: 'approved',
      processorTransactionId: 'processor-1',
      cardBrand: 'Visa',
      cardLast4: '1111',
    });
    await source.db.runStartupReconciliation();
    source.db.backfillOutbox();

    const events = outboxToCloudEvents(source.db.exportOutboxSnapshot());
    const kioskEvent = events.find((event) => event.entityType === 'kiosk');
    expect(kioskEvent).toBeDefined();
    expect(
      events.some(
        (event) =>
          event.entityType === 'payment_transaction' &&
          event.payload.kioskId === kioskId,
      ),
    ).toBe(true);
    expect(kioskEvent!.payload).not.toHaveProperty('tokenHash');
    expect(kioskEvent!.payload).not.toHaveProperty('adminPinHash');
    expect(kioskEvent!.payload).not.toHaveProperty('token_hash');
    expect(kioskEvent!.payload).not.toHaveProperty('admin_pin_hash');

    const target = createDb();
    const transport = new FakeTransport();
    transport.seed(events);
    const result = await restoreFromCloud(target.db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(true);
    expect(result.summary?.kiosks).toBe(1);
    expect(target.db.listKiosks()[0]).toMatchObject({
      id: kioskId,
      name: 'Front kiosk',
      revokedAt: expect.any(String),
      lastSeenAt: null,
    });
    expect(target.db.findKioskByTokenHash('token-hash')).toBeUndefined();
    expect(target.db.listSales()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'kiosk', kioskId }),
      ]),
    );
    expect(target.db.getPaymentTransaction(chargeReference)?.kiosk_id).toBe(
      kioskId,
    );
    expect(result.summary?.integrityChecks).toContain(
      'foreign_key_check: no violations',
    );

    disposeDb(source.db, source.file);
    disposeDb(target.db, target.file);
  });

  it('restores when the sale sequence precedes the kiosk sequence', async () => {
    const source = createDb();
    enableSync(source.db);
    const category = source.db.createCategory({ name: 'Drinks' });
    const product = source.db.createProduct({
      categoryId: category.id,
      name: 'Water',
      purchaseCostCents: 50,
      sellingPriceCents: 100,
      taxable: false,
      lowStockThreshold: 1,
      barcodes: ['WATER-1'],
    });
    source.db.addInventoryMovement({
      productId: product.id,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    const kioskId = randomUUID();
    source.db.createKiosk(kioskId, 'Front kiosk', 'token-hash', 'pin-hash');
    source.db.completeSale(
      {
        completionKey: randomUUID(),
        lines: [{ productId: product.id, quantity: 1, barcodeUsed: 'WATER-1' }],
        payment: { method: 'cash', cashReceivedCents: 100 },
      },
      undefined,
      kioskId,
    );
    source.db.backfillOutbox();
    const events = outboxToCloudEvents(source.db.exportOutboxSnapshot());
    const reordered = events
      .filter(
        (event) => event.entityType !== 'kiosk' && event.entityType !== 'sale',
      )
      .concat(
        events.filter((event) => event.entityType === 'sale'),
        events.filter((event) => event.entityType === 'kiosk'),
      )
      .map((event, index) => ({ ...event, sequence: index + 1 }));

    const target = createDb();
    const transport = new FakeTransport();
    transport.seed(reordered);
    const result = await restoreFromCloud(target.db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(true);
    expect(target.db.listSales()[0]?.kioskId).toBe(kioskId);
    disposeDb(source.db, source.file);
    disposeDb(target.db, target.file);
  });

  it('rolls back when a refund points at a missing sale', async () => {
    const source = createDb();
    enableSync(source.db);
    const ids = populateStore(source.db);
    const sale = source.db
      .listSales()
      .find((item) => item.payment.method === 'cash')!;
    source.db.recordRefund({
      operationId: randomUUID(),
      saleId: sale.id,
      items: [
        {
          saleItemId: sale.items[0]!.id,
          quantity: 1,
          restocked: true,
        },
      ],
      reason: 'Dangling refund test',
    });
    source.db.backfillOutbox();
    const events = outboxToCloudEvents(source.db.exportOutboxSnapshot()).map(
      (event) =>
        event.entityType === 'refund'
          ? {
              ...event,
              payload: { ...event.payload, saleId: randomUUID() },
            }
          : event,
    );
    const target = createDb();
    const transport = new FakeTransport();
    transport.seed(events);
    const result = await restoreFromCloud(target.db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rolled back/i);
    expect(target.db.listRefunds(sale.id)).toHaveLength(0);
    expect(target.db.isRestoreAllowed()).toBe(true);
    expect(ids.productId).toBeTruthy();
    disposeDb(source.db, source.file);
    disposeDb(target.db, target.file);
  });

  it('rolls back when a refund points at a missing sale item, product, or customer', async () => {
    const mutations = [
      {
        name: 'sale item',
        apply: (payload: RefundPayload) => ({
          ...payload,
          items: payload.items.map((item, index) =>
            index === 0 ? { ...item, saleItemId: randomUUID() } : item,
          ),
        }),
      },
      {
        name: 'product',
        apply: (payload: RefundPayload) => ({
          ...payload,
          items: payload.items.map((item, index) =>
            index === 0 ? { ...item, productId: randomUUID() } : item,
          ),
        }),
      },
      {
        name: 'customer',
        apply: (payload: RefundPayload) => ({
          ...payload,
          customerId: randomUUID(),
          ledgerEntry: payload.ledgerEntry
            ? { ...payload.ledgerEntry, customerId: randomUUID() }
            : null,
        }),
      },
    ];
    for (const mutation of mutations) {
      const source = createDb();
      const target = createDb();
      try {
        enableSync(source.db);
        populateStore(source.db);
        const sale = source.db
          .listSales()
          .find((item) => item.payment.method === 'account')!;
        source.db.recordRefund({
          operationId: randomUUID(),
          saleId: sale.id,
          items: [
            {
              saleItemId: sale.items[0]!.id,
              quantity: 1,
              restocked: true,
            },
          ],
          reason: `Dangling ${mutation.name} test`,
        });
        source.db.backfillOutbox();
        const events = outboxToCloudEvents(
          source.db.exportOutboxSnapshot(),
        ).map((event) =>
          event.entityType === 'refund'
            ? { ...event, payload: mutation.apply(event.payload) }
            : event,
        );
        const transport = new FakeTransport();
        transport.seed(events);
        const result = await restoreFromCloud(
          target.db,
          transport,
          TEST_STORE_ID,
        );
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/rolled back/i);
        expect(target.db.isRestoreAllowed()).toBe(true);
      } finally {
        disposeDb(source.db, source.file);
        disposeDb(target.db, target.file);
      }
    }
  });

  it('rolls back when a kiosk reference has no kiosk event', async () => {
    const source = createDb();
    enableSync(source.db);
    const category = source.db.createCategory({ name: 'Drinks' });
    const product = source.db.createProduct({
      categoryId: category.id,
      name: 'Water',
      purchaseCostCents: 50,
      sellingPriceCents: 100,
      taxable: false,
      lowStockThreshold: 1,
      barcodes: ['WATER-1'],
    });
    source.db.addInventoryMovement({
      productId: product.id,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    const kioskId = randomUUID();
    source.db.createKiosk(kioskId, 'Front kiosk', 'token-hash', 'pin-hash');
    source.db.completeSale(
      {
        completionKey: randomUUID(),
        lines: [{ productId: product.id, quantity: 1, barcodeUsed: 'WATER-1' }],
        payment: { method: 'cash', cashReceivedCents: 100 },
      },
      undefined,
      kioskId,
    );
    source.db.backfillOutbox();
    const events = outboxToCloudEvents(source.db.exportOutboxSnapshot()).filter(
      (event) => event.entityType !== 'kiosk',
    );

    const target = createDb();
    const transport = new FakeTransport();
    transport.seed(events);
    const result = await restoreFromCloud(target.db, transport, TEST_STORE_ID);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rolled back/i);
    expect(target.db.isRestoreAllowed()).toBe(true);
    expect(target.db.listSales()).toHaveLength(0);
    expect(target.db.pendingSyncEventCount()).toBe(0);
    disposeDb(source.db, source.file);
    disposeDb(target.db, target.file);
  });
});
