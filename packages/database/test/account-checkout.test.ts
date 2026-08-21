import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;
let freeProductId: string;
let customerId: string;

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
    barcodes: ['CHALLAH-1'],
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
});

afterEach(() => {
  store.close();
});

describe('put on account checkout', () => {
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

    // Inventory deduction check
    expect(
      store.listProducts().find((p) => p.id === productId)?.stockQuantity,
    ).toBe(8);

    // Customer balance check
    expect(store.getCustomerBalance(customerId)).toBe(1000);
    const updatedCustomer = store.getCustomer(customerId);
    expect(updatedCustomer.currentBalanceCents).toBe(1000);
    expect(updatedCustomer.availableCreditCents).toBe(1000); // 2000 - 1000

    // Check ledger entry
    const ledger = store.listCustomerLedger(customerId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      amountCents: 1000,
      entryType: 'sale_charge',
      relatedSaleId: sale.id,
      resultingBalanceCents: 1000,
    });

    // No fake payment created in payments table
    expect(
      (
        store.connection
          .prepare('SELECT COUNT(*) AS count FROM payments WHERE sale_id = ?')
          .get(sale.id) as { count: number }
      ).count,
    ).toBe(0);
  });

  it('rejects account sales for zero-total carts but allows cash/terminal checkout', () => {
    // Account tender on zero-total sale must be disallowed
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

    // No sales or ledger entries created
    expect(store.listSales()).toHaveLength(0);
    expect(store.getCustomerBalance(customerId)).toBe(0);

    // Cash sale for zero-total succeeds
    const cashSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: freeProductId, quantity: 1, barcodeUsed: 'FREE-1' }],
      payment: { method: 'cash', cashReceivedCents: 0 },
    });
    expect(cashSale.totalCents).toBe(0);
    expect(cashSale.payment.method).toBe('cash');
  });

  it('preserves historical customer snapshot even after customer is updated', () => {
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: {
        method: 'account',
        customerId,
        confirmed: true,
      },
    });

    store.updateCustomer(customerId, {
      name: 'Levi Changed',
      accountNumber: '9999',
    });

    const fetched = store.getSale(sale.id);
    expect(fetched.customer?.name).toBe('Levi');
    expect(fetched.customer?.accountNumber).toBe('1001');
    expect(fetched.payment.customerName).toBe('Levi');
    expect(fetched.payment.accountNumber).toBe('1001');
  });

  it('rejects account sales when customer accounts are disabled in settings', () => {
    store.updateSettings({
      ...store.getSettings(),
      customerAccountsEnabled: false,
    });

    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(/disabled/);

    expect(store.listSales()).toHaveLength(0);
    expect(
      store.listProducts().find((p) => p.id === productId)?.stockQuantity,
    ).toBe(10);
  });

  it('rejects account sales for inactive or blocked customers', () => {
    store.setCustomerActive(customerId, false);
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(/inactive/);

    store.setCustomerActive(customerId, true);
    store.setCustomerBlocked(customerId, true);
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(/blocked/);
  });

  it('rejects sales exceeding customer credit limit and accepts exact limit', () => {
    // Customer credit limit is 2000 cents ($20.00). Selling price is 500 cents ($5.00).
    // Purchasing 4 challahs = 2000 cents (exact limit) -> allowed.
    const sale1 = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 4, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });
    expect(sale1.totalCents).toBe(2000);
    expect(store.getCustomerBalance(customerId)).toBe(2000);

    // Purchasing 1 more challah = 500 cents -> projected 2500 > 2000 limit -> rejected!
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(/Credit limit exceeded/);

    expect(store.getCustomerBalance(customerId)).toBe(2000);
    expect(
      store.listProducts().find((p) => p.id === productId)?.stockQuantity,
    ).toBe(6);
  });

  it('returns the existing sale idempotently on completion-key retry without duplicate deductions or charges', () => {
    const key = randomUUID();
    const first = store.completeSale({
      completionKey: key,
      lines: [{ productId, quantity: 2, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    const retry = store.completeSale({
      completionKey: key,
      lines: [{ productId, quantity: 2, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    expect(retry.id).toBe(first.id);
    expect(store.listSales()).toHaveLength(1);
    expect(store.getCustomerBalance(customerId)).toBe(1000);
    expect(
      store.listProducts().find((p) => p.id === productId)?.stockQuantity,
    ).toBe(8);
  });

  it('rejects retried completion-key with conflicting payload', () => {
    const key = randomUUID();
    store.completeSale({
      completionKey: key,
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    expect(() =>
      store.completeSale({
        completionKey: key,
        lines: [{ productId, quantity: 2, barcodeUsed: null }],
        payment: { method: 'account', customerId, confirmed: true },
      }),
    ).toThrow(
      'A sale with this completion key already exists with different details.',
    );
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

  it('does not regress cash or external-terminal checkout', () => {
    const cashSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });
    expect(cashSale.payment.method).toBe('cash');
    expect(cashSale.payment.changeDueCents).toBe(500);

    const termSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'REF-1',
      },
    });
    expect(termSale.payment.method).toBe('external_terminal');
    expect(termSale.payment.terminalReference).toBe('REF-1');
  });
});
