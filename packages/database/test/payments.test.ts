import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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

  test('reconciles approved charge to sale exactly once and ignores subsequent attempts', async () => {
    const products = store.listProducts();
    const chargeReference = randomUUID();
    const idempotencyKey = randomUUID();
    const cartSnapshot = JSON.stringify({
      lines: [{ productId: products[0].id, quantity: 1, barcodeUsed: null }],
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
      100,
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
    expect(sale.totalCents).toBe(100);
    expect(sale.payment.method).toBe('integrated_card');
    expect(sale.payment.chargeReference).toBe(chargeReference);

    // Re-running reconciliation does nothing and doesn't throw
    await store.runStartupReconciliation();

    const sales = store.listSales();
    expect(sales.length).toBe(1);
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

  test('Idempotency validator conflicts if different charge reference used', () => {
    const products = store.listProducts();
    const idempotencyKey = randomUUID();

    const existingRef = randomUUID();
    const expectedTotal = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: products[0].id, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 1000 },
    }).totalCents;
    store.createPaymentTransaction(
      existingRef,
      'simulated',
      expectedTotal,

      JSON.stringify({ lines: [], totals: { totalCents: 100 } }),
      idempotencyKey,
    );
    store.connection
      .prepare("UPDATE payment_transactions SET status='approved'")
      .run();

    store.completeSale({
      completionKey: idempotencyKey,
      lines: [{ productId: products[0].id, quantity: 1, barcodeUsed: null }],
      payment: { method: 'integrated_card', chargeReference: existingRef },
    });

    expect(() => {
      store.completeSale({
        completionKey: idempotencyKey,
        lines: [{ productId: products[0].id, quantity: 1, barcodeUsed: null }],
        payment: { method: 'integrated_card', chargeReference: randomUUID() },
      });
    }).toThrow(
      'A sale with this completion key already exists with different details.',
    );
  });
});
