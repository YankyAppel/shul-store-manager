import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readNullableSafeCents,
  readSafeCents,
  StoreDatabase,
} from '../src/index.js';

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

  it('validates readSafeCents at safe-integer boundaries and throws on unsafe values', () => {
    // Valid values
    expect(readSafeCents(0)).toBe(0);
    expect(readSafeCents(null)).toBe(0);
    expect(readSafeCents(undefined)).toBe(0);
    expect(readSafeCents(12345)).toBe(12345);
    expect(readSafeCents(-12345)).toBe(-12345);
    expect(readSafeCents(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(readSafeCents(BigInt(-Number.MAX_SAFE_INTEGER))).toBe(
      -Number.MAX_SAFE_INTEGER,
    );
    expect(readSafeCents('100000000')).toBe(100000000);
    expect(readSafeCents('-500')).toBe(-500);

    // Nullable helper
    expect(readNullableSafeCents(null)).toBeNull();
    expect(readNullableSafeCents(undefined)).toBeNull();
    expect(readNullableSafeCents(5000)).toBe(5000);

    // Unsafe or invalid values
    expect(() =>
      readSafeCents(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'cents'),
    ).toThrow(/exceeds the supported safe integer range/);
    expect(() =>
      readSafeCents(BigInt(-Number.MAX_SAFE_INTEGER) - 1n, 'cents'),
    ).toThrow(/exceeds the supported safe integer range/);
    expect(() => readSafeCents('9007199254740992', 'cents')).toThrow(
      /exceeds the supported safe integer range/,
    );
    expect(() => readSafeCents('invalid-num', 'cents')).toThrow(
      /Invalid numeric format/,
    );
    expect(() => readSafeCents(12.34, 'cents')).toThrow(
      /must be a safe integer/,
    );
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
