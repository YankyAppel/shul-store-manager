import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;
let secondProductId: string;
let freeProductId: string;
let customerId: string;
let secondCustomerId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Groceries' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Challah',
    purchaseCostCents: 200,
    sellingPriceCents: 500,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['CHALLAH-1', 'CHALLAH-ALT'],
  }).id;
  secondProductId = store.createProduct({
    categoryId,
    name: 'Grape Juice',
    purchaseCostCents: 200,
    sellingPriceCents: 500, // Same price $5.00
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['JUICE-1'],
  }).id;
  freeProductId = store.createProduct({
    categoryId,
    name: 'Free Pamphlet',
    purchaseCostCents: 0,
    sellingPriceCents: 0,
    taxable: false,
    lowStockThreshold: 0,
    barcodes: ['FREE-1'],
  }).id;

  store.addInventoryMovement({
    productId,
    quantityChange: 10,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  store.addInventoryMovement({
    productId: secondProductId,
    quantityChange: 10,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  store.addInventoryMovement({
    productId: freeProductId,
    quantityChange: 100,
    reason: 'stock_received',
    notes: 'Opening stock',
  });

  customerId = store.createCustomer({
    name: 'Levi',
    accountNumber: '1001',
    creditLimitCents: 2000,
  }).id;
  secondCustomerId = store.createCustomer({
    name: 'Yehuda',
    accountNumber: '1002',
    creditLimitCents: 2000,
  }).id;
});

afterEach(() => {
  store.close();
});

describe('put on account checkout & sale idempotency', () => {
  it('completes an account sale, records customer snapshots, adds ledger charge, and deducts inventory', () => {
    const key = randomUUID();
    const sale = store.completeSale({
      completionKey: key,
      lines: [{ productId, quantity: 2, barcodeUsed: 'CHALLAH-1' }],
      payment: {
        method: 'account',
        customerId,
        confirmed: true,
      },
    });

    expect(sale).toMatchObject({
      status: 'completed',
      totalCents: 1000,
      payment: {
        method: 'account',
        amountCents: 1000,
        customerId,
        customerName: 'Levi',
        accountNumber: '1001',
        previousBalanceCents: 0,
        newBalanceCents: 1000,
      },
      customer: {
        id: customerId,
        name: 'Levi',
        accountNumber: '1001',
        previousBalanceCents: 0,
        newBalanceCents: 1000,
      },
    });

    expect(
      store.listProducts().find((p) => p.id === productId)?.stockQuantity,
    ).toBe(8);
    expect(store.getCustomerBalance(customerId)).toBe(1000);
  });

  it('handles identical retry and reordered lines idempotently without duplicate deductions', () => {
    const key = randomUUID();
    const first = store.completeSale({
      completionKey: key,
      lines: [
        { productId, quantity: 1, barcodeUsed: 'CHALLAH-1' },
        { productId: secondProductId, quantity: 1, barcodeUsed: 'JUICE-1' },
      ],
      payment: { method: 'account', customerId, confirmed: true },
    });

    // Reordered lines retry with same completion key
    const reorderedRetry = store.completeSale({
      completionKey: key,
      lines: [
        { productId: secondProductId, quantity: 1, barcodeUsed: 'JUICE-1' },
        { productId, quantity: 1, barcodeUsed: 'CHALLAH-1' },
      ],
      payment: { method: 'account', customerId, confirmed: true },
    });

    expect(reorderedRetry.id).toBe(first.id);
    expect(store.listSales()).toHaveLength(1);
    expect(store.getCustomerBalance(customerId)).toBe(1000);
    expect(
      store.listProducts().find((p) => p.id === productId)?.stockQuantity,
    ).toBe(9);
    expect(
      store.listProducts().find((p) => p.id === secondProductId)?.stockQuantity,
    ).toBe(9);
  });

  it('rejects retried completion key with different product having equal total', () => {
    const key = randomUUID();
    // First sale: product A, total $5
    store.completeSale({
      completionKey: key,
      lines: [{ productId, quantity: 1, barcodeUsed: 'CHALLAH-1' }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    // Retry with product B (also $5)
    expect(() =>
      store.completeSale({
        completionKey: key,
        lines: [
          { productId: secondProductId, quantity: 1, barcodeUsed: 'JUICE-1' },
        ],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(
      'A sale with this completion key already exists with different details.',
    );

    // Remains 1 sale, product A stock is 9, product B stock is 10
    expect(store.listSales()).toHaveLength(1);
    expect(
      store.listProducts().find((p) => p.id === productId)?.stockQuantity,
    ).toBe(9);
    expect(
      store.listProducts().find((p) => p.id === secondProductId)?.stockQuantity,
    ).toBe(10);
  });

  it('rejects retried completion key with different barcode provenance', () => {
    const key = randomUUID();
    store.completeSale({
      completionKey: key,
      lines: [{ productId, quantity: 1, barcodeUsed: 'CHALLAH-1' }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    expect(() =>
      store.completeSale({
        completionKey: key,
        lines: [{ productId, quantity: 1, barcodeUsed: 'CHALLAH-ALT' }],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(
      'A sale with this completion key already exists with different details.',
    );
  });

  it('rejects retried completion key with different cash received or terminal reference', () => {
    const cashKey = randomUUID();
    store.completeSale({
      completionKey: cashKey,
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });

    expect(() =>
      store.completeSale({
        completionKey: cashKey,
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: { method: 'cash', cashReceivedCents: 2000 },
      }),
    ).toThrow(
      'A sale with this completion key already exists with different details.',
    );

    const termKey = randomUUID();
    store.completeSale({
      completionKey: termKey,
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'REF-1',
      },
    });

    expect(() =>
      store.completeSale({
        completionKey: termKey,
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: {
          method: 'external_terminal',
          approved: true,
          terminalReference: 'REF-2',
        },
      }),
    ).toThrow(
      'A sale with this completion key already exists with different details.',
    );
  });

  it('rejects retried completion key with different customer or tender method', () => {
    const key = randomUUID();
    store.completeSale({
      completionKey: key,
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    expect(() =>
      store.completeSale({
        completionKey: key,
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: {
          method: 'account',
          customerId: secondCustomerId,
          confirmed: true,
        },
      }),
    ).toThrow(
      'A sale with this completion key already exists with different details.',
    );

    expect(() =>
      store.completeSale({
        completionKey: key,
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: { method: 'cash', cashReceivedCents: 500 },
      }),
    ).toThrow(
      'A sale with this completion key already exists with different details.',
    );
  });

  it('rejects account sales for zero-total carts but allows cash/terminal checkout', () => {
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [
          { productId: freeProductId, quantity: 1, barcodeUsed: 'FREE-1' },
        ],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(
      'Account tender cannot be used for a $0.00 sale. Please use cash or external terminal checkout.',
    );

    const cashSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: freeProductId, quantity: 1, barcodeUsed: 'FREE-1' }],
      payment: { method: 'cash', cashReceivedCents: 0 },
    });
    expect(cashSale.totalCents).toBe(0);
  });

  it('preserves historical customer snapshot even after customer is updated', () => {
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    store.updateCustomer(customerId, {
      name: 'Levi Changed',
      accountNumber: '9999',
    });

    const fetched = store.getSale(sale.id);
    expect(fetched.customer?.name).toBe('Levi');
    expect(fetched.customer?.accountNumber).toBe('1001');
  });

  it('rejects sales exceeding customer credit limit and accepts exact limit', () => {
    const sale1 = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 4, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });
    expect(sale1.totalCents).toBe(2000);

    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(/Credit limit exceeded/);
  });

  it('prevents deletion of sales linked to customer ledger via trigger', () => {
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    expect(() =>
      store.connection.prepare('DELETE FROM sales WHERE id = ?').run(sale.id),
    ).toThrow('Cannot delete sale that is linked to customer ledger');
  });
});
