import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;
let customerId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'General' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Siddur',
    secondaryName: 'סידור',
    purchaseCostCents: 800,
    sellingPriceCents: 1500,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['SIDDUR-1'],
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 10,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  customerId = store.createCustomer({
    name: 'Dan <script>alert("xss")</script>',
    secondaryName: 'דן',
    accountNumber: '1001',
  }).id;
});

afterEach(() => {
  store.close();
});

describe('receipts and statements', () => {
  it('generates account sale receipt data and preserves snapshot on customer change', () => {
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: 'SIDDUR-1' }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    const receipt = {
      sale: store.getSale(sale.id),
      settings: store.getSettings(),
    };

    expect(receipt.sale.payment.method).toBe('account');
    expect(receipt.sale.payment.customerName).toContain('Dan');
    expect(receipt.sale.payment.previousBalanceCents).toBe(0);
    expect(receipt.sale.payment.newBalanceCents).toBe(1500);

    // Modify customer
    store.updateCustomer(customerId, {
      name: 'Dan Clean',
      accountNumber: '9999',
    });

    const refreshedSale = store.getSale(sale.id);
    expect(refreshedSale.payment.customerName).toContain('Dan <script>');
    expect(refreshedSale.payment.accountNumber).toBe('1001');
  });

  it('records print attempts for sales and account payments without changing records', () => {
    // 1. Complete an account sale so customer has balance
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    store.recordPrintAttempt(sale.id, false, 'No paper');
    store.recordPrintAttempt(sale.id, true, null);

    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 500,
      payment: { method: 'cash', cashReceivedCents: 500 },
    });

    store.recordAccountPaymentPrintAttempt(
      payment.id,
      false,
      'Printer offline',
    );
    store.recordAccountPaymentPrintAttempt(payment.id, true, null);

    expect(
      (
        store.connection
          .prepare(
            'SELECT COUNT(*) AS count FROM print_attempts WHERE sale_id = ?',
          )
          .get(sale.id) as { count: number }
      ).count,
    ).toBe(2);

    expect(
      (
        store.connection
          .prepare(
            'SELECT COUNT(*) AS count FROM account_payment_print_attempts WHERE account_payment_id = ?',
          )
          .get(payment.id) as { count: number }
      ).count,
    ).toBe(2);
  });

  it('calculates customer statement with opening balance, date filtering, and running balances', () => {
    const d1 = '2026-01-01T10:00:00.000Z';
    const d2 = '2026-01-15T10:00:00.000Z';
    const d3 = '2026-02-01T10:00:00.000Z';
    const d4 = '2026-02-15T10:00:00.000Z';

    // Entry 1 (before custom period): Charge $20
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 2000, 'sale_charge', ?, 'Old Charge', 1)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d1);

    // Entry 2 (before custom period): Payment $5
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, -500, 'payment', ?, 'Old Payment', 2)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d2);

    // Entry 3 (in period): Charge $30
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 3000, 'sale_charge', ?, 'February Charge', 3)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d3);

    // Entry 4 (in period): Payment $10
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, -1000, 'payment', ?, 'February Payment', 4)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d4);

    // Query custom period starting 2026-01-20
    const statement = store.getCustomerStatement(customerId, {
      range: 'custom',
      startDate: '2026-01-20T00:00:00.000Z',
      endDate: '2026-02-28T23:59:59.000Z',
    });

    expect(statement.openingBalanceCents).toBe(1500); // 2000 - 500
    expect(statement.entries).toHaveLength(2);
    expect(statement.entries[0]).toMatchObject({
      notes: 'February Charge',
      chargeCents: 3000,
      runningBalanceCents: 4500, // 1500 + 3000
    });
    expect(statement.entries[1]).toMatchObject({
      notes: 'February Payment',
      paymentCents: 1000,
      runningBalanceCents: 3500, // 4500 - 1000
    });
    expect(statement.totalChargesCents).toBe(3000);
    expect(statement.totalPaymentsCents).toBe(1000);
    expect(statement.closingBalanceCents).toBe(3500);
  });

  it('escapes customer and settings strings in HTML representations', () => {
    const escapeHtml = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

    const malicious = '<script>alert(1)</script>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain('<script>');
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
