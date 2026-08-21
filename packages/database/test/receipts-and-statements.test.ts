import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountPaymentReceiptHtml,
  escapeHtml,
  receiptHtml,
  statementHtml,
  statementOptionsSchema,
} from '@shul-store/shared';
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
    secondaryName: 'דן & friends',
    accountNumber: '1001',
    address: '123 Main St, Apt 4B <img src=x onerror=alert(1)>',
    email: 'dan@example.com',
    notes: 'Special "VIP" customer & donor',
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
        ) VALUES (?, ?, ?, 2000, 'manual_debit_adjustment', ?, 'Old Charge', 1)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d1);

    // Entry 2 (before custom period): Payment $5
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, -500, 'manual_credit_adjustment', ?, 'Old Payment', 2)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d2);

    // Entry 3 (in period): Charge $30
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 3000, 'manual_debit_adjustment', ?, 'February Charge', 3)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d3);

    // Entry 4 (in period): Payment $10
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, -1000, 'manual_credit_adjustment', ?, 'February Payment', 4)`,
      )
      .run(randomUUID(), randomUUID(), customerId, d4);

    // Query custom period starting 2026-01-20
    const statement = store.getCustomerStatement(customerId, {
      range: 'custom',
      startDate: '2026-01-20T00:00:00.000Z',
      endDate: '2026-03-01T00:00:00.000Z',
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

  it('handles custom statement date boundaries with exact start-of-day and exclusive end-of-day', () => {
    // Four entries on critical timestamps
    const beforeStart = '2026-02-01T23:59:59.999Z';
    const atStart = '2026-02-02T00:00:00.000Z';
    const duringPeriod = '2026-02-10T12:00:00.000Z';
    const atEndOfEndDay = '2026-02-15T23:59:59.999Z';
    const atNextDayStart = '2026-02-16T00:00:00.000Z';

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 100, 'manual_debit_adjustment', ?, 'Before', 1)`,
      )
      .run(randomUUID(), randomUUID(), customerId, beforeStart);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 200, 'manual_debit_adjustment', ?, 'At Start', 2)`,
      )
      .run(randomUUID(), randomUUID(), customerId, atStart);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 300, 'manual_debit_adjustment', ?, 'Middle', 3)`,
      )
      .run(randomUUID(), randomUUID(), customerId, duringPeriod);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 400, 'manual_debit_adjustment', ?, 'End Of Day', 4)`,
      )
      .run(randomUUID(), randomUUID(), customerId, atEndOfEndDay);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 500, 'manual_debit_adjustment', ?, 'After Exclusive End', 5)`,
      )
      .run(randomUUID(), randomUUID(), customerId, atNextDayStart);

    // Range: 2026-02-02 to 2026-02-15 (exclusive upper bound 2026-02-16T00:00:00.000Z)
    const statement = store.getCustomerStatement(customerId, {
      range: 'custom',
      startDate: '2026-02-02T00:00:00.000Z',
      endDate: '2026-02-16T00:00:00.000Z',
    });

    // Opening balance includes "Before" (100)
    expect(statement.openingBalanceCents).toBe(100);

    // Entries include "At Start", "Middle", "End Of Day" (200, 300, 400 = 900)
    // Does NOT include "After Exclusive End" (500)
    expect(statement.entries.map((e) => e.notes)).toEqual([
      'At Start',
      'Middle',
      'End Of Day',
    ]);
    expect(statement.totalChargesCents).toBe(900);
    expect(statement.closingBalanceCents).toBe(1000); // 100 + 900
  });

  it('validates statement option schema constraints', () => {
    // Missing dates on custom range
    expect(() =>
      statementOptionsSchema.parse({
        range: 'custom',
        startDate: '2026-02-01T00:00:00.000Z',
      }),
    ).toThrow('Both start date and end date are required');

    expect(() =>
      statementOptionsSchema.parse({
        range: 'custom',
        endDate: '2026-02-15T00:00:00.000Z',
      }),
    ).toThrow('Both start date and end date are required');

    // Reversed dates
    expect(() =>
      statementOptionsSchema.parse({
        range: 'custom',
        startDate: '2026-02-15T00:00:00.000Z',
        endDate: '2026-02-01T00:00:00.000Z',
      }),
    ).toThrow('Start date cannot be after end date');

    // Malformed date
    expect(() =>
      statementOptionsSchema.parse({
        range: 'custom',
        startDate: 'invalid-date',
        endDate: '2026-02-15T00:00:00.000Z',
      }),
    ).toThrow('Invalid start date format');
  });

  it('escapes customer and settings strings in production HTML templates', () => {
    // Test direct helper
    expect(
      escapeHtml('Dan & Sons <script>alert("xss")</script> "test" \'quote\''),
    ).toBe(
      'Dan &amp; Sons &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &quot;test&quot; &#39;quote&#39;',
    );

    // Test production statement HTML
    const statementData = store.getCustomerStatement(customerId, {
      range: 'all_activity',
    });
    const html = statementHtml(statementData);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('דן &amp; friends');

    // Test production receipt HTML
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });
    const saleReceiptHtml = receiptHtml({
      sale: store.getSale(sale.id),
      settings: store.getSettings(),
    });
    expect(saleReceiptHtml).not.toContain('<script>');
    expect(saleReceiptHtml).toContain('&lt;script&gt;');

    // Test production account payment receipt HTML
    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 500,
      payment: { method: 'cash', cashReceivedCents: 500 },
      notes: 'Payment with <b>bold</b> & "quotes"',
    });
    const paymentReceiptHtml = accountPaymentReceiptHtml({
      payment,
      settings: store.getSettings(),
    });
    expect(paymentReceiptHtml).not.toContain('<b>bold</b>');
    expect(paymentReceiptHtml).toContain(
      '&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;',
    );
  });
});
