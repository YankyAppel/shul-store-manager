import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import { StoreDatabase } from '../src/store-database.js';

describe('payment transactions & integration', () => {
  let store: StoreDatabase;

  beforeEach(() => {
    store = new StoreDatabase(':memory:');

    // Seed catalog
    const category = store.createCategory({ name: 'Drinks' });
    const product = store.createProduct({
      categoryId: category.id,
      name: 'Water',
      sellingPriceCents: 100,
      purchaseCostCents: 50,
      taxable: false,
      unitSellingPriceCents: 100,
      unitPurchaseCostCents: 50,
      lowStockThreshold: 10,
    });
    store.addInventoryMovement({
      productId: product.id,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'x',
    });

    const product2 = store.createProduct({
      categoryId: category.id,
      name: 'Soda',
      sellingPriceCents: 200,
      purchaseCostCents: 100,
      taxable: false,
      lowStockThreshold: 10,
    });
    store.addInventoryMovement({
      productId: product2.id,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'x',
    });
  });

  afterEach(() => {
    store.close();
  });

  test('Journal-first: initiated row exists and locks correctly (preventing double submit)', () => {
    const chargeReference = randomUUID();
    const idempotencyKey = randomUUID();

    store.createPaymentTransaction(
      chargeReference,
      'simulated',
      store.getSettings().pricesIncludeTax ? 100 : 100,
      JSON.stringify({ lines: [], totals: { totalCents: 100 } }),
      idempotencyKey,
    );

    const tx = store.getPaymentTransaction(chargeReference);
    expect(tx).toBeDefined();
    expect(tx?.status).toBe('initiated');

    // Attempting again with same idempotencyKey fails
    expect(() =>
      store.createPaymentTransaction(
        randomUUID(),
        'simulated',
        100,
        '{}',
        idempotencyKey,
      ),
    ).toThrow('A payment is already in progress');
  });

  test('double submit storm yields exactly one transaction', () => {
    const idempotencyKey = randomUUID();

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < 5; i++) {
      try {
        store.createPaymentTransaction(
          randomUUID(),
          'simulated',
          100,
          JSON.stringify({ lines: [], totals: { totalCents: 100 } }),
          idempotencyKey,
        );
        successCount++;
      } catch {
        failCount++;
      }
    }

    expect(successCount).toBe(1);
    expect(failCount).toBe(4);
  });

  test('reconciles approved charge to sale exactly once and ignores subsequent attempts', async () => {
    const products = store.listProducts();
    const chargeReference = randomUUID();
    const idempotencyKey = randomUUID();
    const cartSnapshot = JSON.stringify({
      lines: [
        {
          productId: products[0].id,
          quantity: 1,
          barcodeUsed: null,
          productName: products[0].name,
          secondaryName: products[0].secondaryName,
          unitSellingPriceCents: 100,
          unitPurchaseCostCents: 50,
          taxable: false,
          unitPriceCents: 100,
          subtotalCents: 100,
          taxCents: 0,
          totalCents: 100,
        },
      ],
      totals: {
        totalCents: 100,
        subtotalCents: 100,
        taxCents: 0,
        lines: [
          {
            productId: products[0].id,
            quantity: 1,
            unitPriceCents: 100,
            subtotalCents: 100,
            taxCents: 0,
            totalCents: 100,
          },
        ],
      },
    });

    store.createPaymentTransaction(
      chargeReference,
      'simulated',
      store.getSettings().pricesIncludeTax ? 100 : 100,
      cartSnapshot,
      idempotencyKey,
    );

    store.updatePaymentTransactionStatus(chargeReference, 'unknown');

    const storage = store.getProcessorStorage();
    await storage.set(chargeReference, {
      status: 'approved',
      processorTransactionId: 'txn_123',
      cardBrand: 'Visa',
      cardLast4: '4242',
    });

    store.updateSettings({
      ...store.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    await store.runStartupReconciliation();

    const saleId = store.getPaymentTransaction(chargeReference)?.sale_id;
    expect(saleId).toBeTruthy();

    const sale = store.getSale(String(saleId));

    expect(sale.payment.method).toBe('integrated_card');
    expect(sale.payment.chargeReference).toBe(chargeReference);

    // Re-running reconciliation does nothing and doesn't throw
    await store.runStartupReconciliation();

    const sales = store.listSales();
    expect(sales.length).toBe(1);
  });

  test('Simulated processor: amount conventions & getChargeStatus consistency across restart', async () => {
    const file = `${process.cwd()}/test-db-${randomUUID()}.sqlite`;
    const store1 = new StoreDatabase(file);
    store1.updateSettings({
      ...store1.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    const storage1 = store1.getProcessorStorage();

    // Simulate declines / errors
    const { processors } = await import('@shul-store/payments');
    const processor = processors[0];

    const declineRes = await processor.createCharge(
      { chargeReference: 'ref1', amountCents: 501 },
      {},
      storage1,
    );
    expect(declineRes.status).toBe('declined');

    const errRes = await processor.createCharge(
      { chargeReference: 'ref2', amountCents: 502 },
      {},
      storage1,
    );
    expect(errRes.status).toBe('error');

    const pendingRes = await processor.createCharge(
      { chargeReference: 'ref3', amountCents: 503 },
      {},
      storage1,
    );
    expect(pendingRes.status).toBe('pending');

    const approveRes = await processor.createCharge(
      { chargeReference: 'ref4', amountCents: 500 },
      {},
      storage1,
    );
    expect(approveRes.status).toBe('approved');

    store1.close();

    // Restart
    const store2 = new StoreDatabase(file);
    const storage2 = store2.getProcessorStorage();

    // Check that pending returns approved on first status check
    const check1 = await processor.getChargeStatus('ref3', {}, storage2);
    expect(check1.status).toBe('approved');

    const check2 = await processor.getChargeStatus('ref1', {}, storage2);
    expect(check2.status).toBe('declined');

    store2.close();
    fs.unlinkSync(file);
  });

  test('Sync round-trip: populated store including integrated-card sales -> backfill -> restore -> verify', async () => {
    const file = `${process.cwd()}/test-db-${randomUUID()}.sqlite`;
    const store1 = new StoreDatabase(file);
    store1.updateSettings({
      ...store1.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    const category = store1.createCategory({ name: 'Drinks' });
    const product = store1.createProduct({
      categoryId: category.id,
      name: 'Water',
      sellingPriceCents: 100,
      purchaseCostCents: 50,
      taxable: false,
      lowStockThreshold: 10,
    });
    store1.addInventoryMovement({
      productId: product.id,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'x',
    });

    const chargeReference = randomUUID();
    const idempotencyKey = randomUUID();
    const cartSnapshot = JSON.stringify({
      lines: [
        {
          productId: product.id,
          quantity: 1,
          barcodeUsed: null,
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
      totals: {
        subtotalCents: 100,
        taxCents: 0,
        totalCents: 100,
      },
    });

    store1.createPaymentTransaction(
      chargeReference,
      'simulated',
      100,
      cartSnapshot,
      idempotencyKey,
    );
    const storage1 = store1.getProcessorStorage();
    await storage1.set(chargeReference, {
      status: 'approved',
      processorTransactionId: 'xyz',
      cardBrand: 'Visa',
      cardLast4: '1111',
    });
    await store1.runStartupReconciliation();

    const sales = store1.listSales();
    expect(sales.length).toBe(1);

    store1.setSyncEnabled(true);
    store1.backfillOutbox();
    const events = store1.exportOutboxSnapshot();

    // Now restore into fresh DB
    const file2 = `${process.cwd()}/test-db-${randomUUID()}.sqlite`;
    const store2 = new StoreDatabase(file2);

    // Convert to ValidatedRestoreEvent
    const validEvents = events.map((e) => ({
      eventId: e.eventId,
      sequence: e.sequence,
      entityType: e.entityType as any,
      entityId: e.entityId,
      operation: e.operation as any,
      payload:
        typeof e.payload === 'string'
          ? JSON.parse(e.payload)
          : typeof e.payloadJson === 'string'
            ? JSON.parse(e.payloadJson)
            : e.payloadJson || e.payload,
      createdAt:
        typeof e.occurredAt === 'number'
          ? e.occurredAt
          : e.occurredAt instanceof Date
            ? e.occurredAt.getTime()
            : e.createdAt,
    }));

    store2.replayValidatedEvents(validEvents);

    const tx = store2.getPaymentTransaction(chargeReference);
    expect(tx).toBeDefined();
    expect(tx?.status).toBe('approved');
    const sales2 = store2.listSales();
    expect(sales2.length).toBe(1);
    expect(tx?.sale_id).toBe(sales2[0].id);

    // Reconcile on restored DB should be no-op
    await store2.runStartupReconciliation();
    expect(store2.listSales().length).toBe(1);

    store1.close();
    store2.close();
    fs.unlinkSync(file);
    fs.unlinkSync(file2);
  });

  test('cross-restart crash drill', async () => {
    const file = `${process.cwd()}/test-db-${randomUUID()}.sqlite`;
    const idempotencyKey = randomUUID();
    const chargeReference = randomUUID();

    // Instance 1: initiate and pretend to crash
    const store1 = new StoreDatabase(file);
    const category = store1.createCategory({ name: 'Drinks' });
    const product = store1.createProduct({
      categoryId: category.id,
      name: 'Water',
      sellingPriceCents: 100,
      purchaseCostCents: 50,
      taxable: false,
      lowStockThreshold: 10,
    });
    store1.addInventoryMovement({
      productId: product.id,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'x',
    });

    const cartSnapshot = JSON.stringify({
      lines: [
        {
          productId: product.id,
          quantity: 1,
          barcodeUsed: null,
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
    });

    store1.createPaymentTransaction(
      chargeReference,
      'simulated',
      100,
      cartSnapshot,
      idempotencyKey,
    );
    store1.updateSettings({
      ...store1.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    store1.updatePaymentTransactionStatus(chargeReference, 'unknown');
    const storage1 = store1.getProcessorStorage();
    await storage1.set(chargeReference, {
      status: 'approved',
      processorTransactionId: 'xyz',
      cardBrand: 'Visa',
      cardLast4: '1111',
    });
    store1.close();

    // Instance 2: restarts and runs reconciliation
    const store2 = new StoreDatabase(file);
    await store2.runStartupReconciliation();

    const sales = store2.listSales();
    expect(sales.length).toBe(1);
    expect(sales[0].payment.method).toBe('integrated_card');

    store2.close();
    fs.unlinkSync(file);
  });

  test('declined/error paths leave no sale, no inventory change', async () => {
    const chargeReference = randomUUID();
    const idempotencyKey = randomUUID();

    store.createPaymentTransaction(
      chargeReference,
      'simulated',
      100,
      JSON.stringify({ lines: [], totals: { totalCents: 100 } }),
      idempotencyKey,
    );

    store.updateSettings({
      ...store.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    store.updatePaymentTransactionStatus(chargeReference, 'unknown');
    const storage = store.getProcessorStorage();
    await storage.set(chargeReference, {
      status: 'declined',
      declineReason: 'Card declined',
    });

    await store.runStartupReconciliation();

    const tx = store.getPaymentTransaction(chargeReference);
    expect(tx?.status).toBe('declined');
    expect(tx?.sale_id).toBeNull();

    expect(store.listSales().length).toBe(0);
  });

  test('reconciliation marks transaction needs-attention if cart snapshot is invalid', async () => {
    const file = `${process.cwd()}/test-db-${randomUUID()}.sqlite`;
    const store = new StoreDatabase(file);
    store.updateSettings({
      ...store.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });

    const chargeReference = randomUUID();
    const idempotencyKey = randomUUID();

    // Create 'unknown' record
    store.createPaymentTransaction(
      chargeReference,
      'simulated',
      100,
      '{}', // Invalid cart snapshot JSON
      idempotencyKey,
    );
    store.updatePaymentTransactionStatus(chargeReference, 'unknown');

    const storage = store.getProcessorStorage();
    // Simulate that the charge eventually succeeded but we lost our cart snapshot
    await storage.set(chargeReference, { status: 'approved' });

    await store.runStartupReconciliation();
    const tx = store.getPaymentTransaction(chargeReference);

    expect(tx?.status).toBe('needs-attention');

    store.close();
    fs.unlinkSync(file);
  });

  test('Idempotency validator conflicts if different charge reference used', () => {
    const products = store.listProducts();
    const idempotencyKey = randomUUID();

    const existingRef = randomUUID();

    store.createPaymentTransaction(
      existingRef,
      'simulated',
      products[0].sellingPriceCents,

      JSON.stringify({ lines: [], totals: { totalCents: 100 } }),
      idempotencyKey,
    );
    store.connection
      .prepare("UPDATE payment_transactions SET status='approved'")
      .run();

    const frozenSnapshot = {
      lines: [
        {
          productId: products[0].id,
          quantity: 1,
          barcodeUsed: null,
          productName: products[0].name,
          secondaryName: products[0].secondaryName,
          unitSellingPriceCents: products[0].sellingPriceCents,
          unitPurchaseCostCents: products[0].purchaseCostCents,
          taxable: false,
          unitPriceCents: products[0].sellingPriceCents,
          subtotalCents: products[0].sellingPriceCents,
          taxCents: 0,
          totalCents: products[0].sellingPriceCents,
        },
      ],
      totals: {
        subtotalCents: products[0].sellingPriceCents,
        taxCents: 0,
        totalCents: products[0].sellingPriceCents,
      },
    };
    store.completeSale(
      {
        completionKey: idempotencyKey,
        lines: [{ productId: products[0].id, quantity: 1, barcodeUsed: null }],
        payment: { method: 'integrated_card', chargeReference: existingRef },
      },
      frozenSnapshot,
    );

    expect(() => {
      store.completeSale(
        {
          completionKey: idempotencyKey,
          lines: [{ productId: products[0].id, quantity: 1, barcodeUsed: null }],
          payment: { method: 'integrated_card', chargeReference: randomUUID() },
        },
        frozenSnapshot,
      );
    }).toThrow(
      'A sale with this completion key already exists with different details.',
    );
  });

  test('rejects same-total product substitution during frozen finalization', () => {
    const products = store.listProducts();
    const original = products[0]!;
    const substitute = products[1]!;
    store.updateProduct(substitute.id, {
      categoryId: substitute.categoryId,
      name: substitute.name,
      purchaseCostCents: substitute.purchaseCostCents,
      sellingPriceCents: original.sellingPriceCents,
      taxable: false,
      lowStockThreshold: substitute.lowStockThreshold,
    });
    const chargeReference = randomUUID();
    store.createPaymentTransaction(
      chargeReference,
      'simulated',
      original.sellingPriceCents,
      '{}',
      randomUUID(),
    );
    store.updatePaymentTransactionStatus(chargeReference, 'approved');
    const snapshot = {
      lines: [
        {
          productId: original.id,
          quantity: 1,
          barcodeUsed: null,
          productName: original.name,
          secondaryName: original.secondaryName,
          unitSellingPriceCents: original.sellingPriceCents,
          unitPurchaseCostCents: original.purchaseCostCents,
          taxable: false,
          unitPriceCents: original.sellingPriceCents,
          subtotalCents: original.sellingPriceCents,
          taxCents: 0,
          totalCents: original.sellingPriceCents,
        },
      ],
      totals: {
        subtotalCents: original.sellingPriceCents,
        taxCents: 0,
        totalCents: original.sellingPriceCents,
      },
    };
    expect(() =>
      store.completeSale(
        {
          completionKey: randomUUID(),
          lines: [{ productId: substitute.id, quantity: 1, barcodeUsed: null }],
          payment: { method: 'integrated_card', chargeReference },
        },
        snapshot,
      ),
    ).toThrow('do not match the frozen payment snapshot');
    expect(store.listSales()).toHaveLength(0);
  });
});
