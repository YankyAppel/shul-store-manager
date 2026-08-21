import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;
let customerId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  store.updateSettings({
    ...store.getSettings(),
    allowCustomerCredit: true,
  });
  categoryId = store.createCategory({ name: 'General' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Item',
    purchaseCostCents: 100,
    sellingPriceCents: 1000,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['ITEM-1'],
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 100,
    reason: 'stock_received',
    notes: 'Stock',
  });
  customerId = store.createCustomer({
    name: 'Wealthy Benefactor',
    accountNumber: '9001',
    creditLimitCents: 100_000_000, // $1,000,000.00
  }).id;
});

afterEach(() => {
  store.close();
});

describe('financial limits and precision safety', () => {
  it('accepts large safe integer credit limits and amounts', () => {
    expect(store.getCustomer(customerId).effectiveCreditLimitCents).toBe(
      100_000_000,
    );

    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 50_000_000,
      payment: { method: 'cash', cashReceivedCents: 50_000_000 },
    });
    expect(payment.amountCents).toBe(50_000_000);
  });

  it('rejects unsafe financial values without partial writes', () => {
    // Non-safe integer payment
    expect(() =>
      store.recordAccountPayment({
        operationId: randomUUID(),
        customerId,
        amountCents: Number.MAX_SAFE_INTEGER + 1,
        payment: {
          method: 'cash',
          cashReceivedCents: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toThrow();

    expect(store.listAccountPayments()).toHaveLength(0);
  });
});
