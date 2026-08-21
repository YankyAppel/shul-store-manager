import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let customerId: string;
let secondCustomerId: string;
let categoryId: string;
let productId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  customerId = store.createCustomer({
    name: 'Reuven',
    accountNumber: '1001',
  }).id;
  secondCustomerId = store.createCustomer({
    name: 'Shimon',
    accountNumber: '1002',
  }).id;
  categoryId = store.createCategory({ name: 'General' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Siddur',
    purchaseCostCents: 500,
    sellingPriceCents: 1000,
    taxable: false,
    lowStockThreshold: 0,
    barcodes: ['BAR-1'],
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 100,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
});

afterEach(() => {
  store.close();
});

describe('customer ledger', () => {
  it('enforces append-only triggers against updates and deletes', () => {
    const opId = randomUUID();
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
          related_sale_id, related_account_payment_id, device_id, notes, sequence
        ) VALUES (?, ?, ?, 500, 'manual_debit_adjustment', ?, NULL, NULL, NULL, 'Test adjustment', 1)`,
      )
      .run(randomUUID(), opId, customerId, new Date().toISOString());

    expect(() =>
      store.connection
        .prepare(
          'UPDATE customer_ledger SET amount_cents = 600 WHERE customer_id = ?',
        )
        .run(customerId),
    ).toThrow(/append-only/);

    expect(() =>
      store.connection
        .prepare('DELETE FROM customer_ledger WHERE customer_id = ?')
        .run(customerId),
    ).toThrow(/append-only/);
  });

  it('enforces entry type direction rules and rejects zero entries', () => {
    // manual debit must be positive
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, -50, 'manual_debit_adjustment', ?, 'Invalid', 1)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();

    // manual credit must be negative
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 50, 'manual_credit_adjustment', ?, 'Invalid', 1)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();

    // zero entry is forbidden
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 0, 'manual_debit_adjustment', ?, 'Zero', 1)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();
  });

  it('enforces schema constraints on sequence and relationship mutual exclusivity', () => {
    // 1. Null sequence rejected
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 100, 'manual_debit_adjustment', ?, 'Null seq', NULL)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();

    // 2. Duplicate sequence rejected
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 100, 'manual_debit_adjustment', ?, 'Seq 1', 100)`,
      )
      .run(randomUUID(), randomUUID(), customerId, new Date().toISOString());

    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 200, 'manual_debit_adjustment', ?, 'Dup seq', 100)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();

    // 3. Both relationship columns populated rejected
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });
    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 500,
      payment: { method: 'cash', cashReceivedCents: 500 },
    });

    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, 1000, 'sale_charge', ?, ?, ?, 'Both', 200)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          sale.id,
          payment.id,
        ),
    ).toThrow();

    // 4. Manual adjustments with relationship columns rejected
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, 100, 'manual_debit_adjustment', ?, ?, NULL, 'Manual with sale', 201)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          sale.id,
        ),
    ).toThrow();

    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, -100, 'manual_credit_adjustment', ?, NULL, ?, 'Manual with payment', 202)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          payment.id,
        ),
    ).toThrow();
  });

  it('enforces cross-table trigger validations for sale_charge entries', () => {
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    const cashSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });

    // 1. Sale charge with mismatched customer fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, 1000, 'sale_charge', ?, ?, NULL, 'Wrong cust', 300)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          secondCustomerId,
          new Date().toISOString(),
          sale.id,
        ),
    ).toThrow(/must match an existing account sale for the same customer/);

    // 2. Sale charge with mismatched amount fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, 500, 'sale_charge', ?, ?, NULL, 'Wrong amt', 301)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          sale.id,
        ),
    ).toThrow(/must match an existing account sale for the same customer/);

    // 3. Sale charge linked to cash/immediate-payment sale fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, 1000, 'sale_charge', ?, ?, NULL, 'Cash sale charge', 302)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          cashSale.id,
        ),
    ).toThrow(/must match an existing account sale/);

    // 4. Duplicate charge linked to same sale fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, 1000, 'sale_charge', ?, ?, NULL, 'Dup charge', 303)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          sale.id,
        ),
    ).toThrow(/A ledger entry for this sale already exists/);
  });

  it('enforces cross-table trigger validations for payment entries', () => {
    // Complete an account sale first so customer has an outstanding balance
    store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 500,
      payment: { method: 'cash', cashReceivedCents: 500 },
    });

    // 1. Payment with mismatched customer fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, -500, 'payment', ?, NULL, ?, 'Wrong cust', 400)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          secondCustomerId,
          new Date().toISOString(),
          payment.id,
        ),
    ).toThrow(/must match an existing account payment for the same customer/);

    // 2. Payment with mismatched amount fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, -400, 'payment', ?, NULL, ?, 'Wrong amt', 401)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          payment.id,
        ),
    ).toThrow(/must match an existing account payment for the same customer/);

    // 3. Duplicate credit linked to same account payment fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, -500, 'payment', ?, NULL, ?, 'Dup credit', 402)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          payment.id,
        ),
    ).toThrow(/A ledger entry for this account payment already exists/);
  });

  it('prevents mutation of sale financial fields if linked to ledger via trigger', () => {
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });

    expect(() =>
      store.connection
        .prepare('UPDATE sales SET total_cents = 2000 WHERE id = ?')
        .run(sale.id),
    ).toThrow(
      /Cannot modify financial fields of a sale that is linked to customer ledger/,
    );

    expect(() =>
      store.connection
        .prepare('UPDATE sales SET customer_id = ? WHERE id = ?')
        .run(secondCustomerId, sale.id),
    ).toThrow(
      /Cannot modify financial fields of a sale that is linked to customer ledger/,
    );

    expect(() =>
      store.connection
        .prepare("UPDATE sales SET tender_type = 'cash' WHERE id = ?")
        .run(sale.id),
    ).toThrow(
      /Cannot modify financial fields of a sale that is linked to customer ledger/,
    );
  });

  it('rejects duplicate operation IDs in the ledger', () => {
    const opId = randomUUID();
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 500, 'manual_debit_adjustment', ?, 'First', 500)`,
      )
      .run(randomUUID(), opId, customerId, new Date().toISOString());

    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 500, 'manual_debit_adjustment', ?, 'Duplicate', 501)`,
        )
        .run(randomUUID(), opId, customerId, new Date().toISOString()),
    ).toThrow();
  });

  it('calculates deterministic running balances across chronological entries', () => {
    const t1 = '2026-01-01T10:00:00.000Z';
    const t2 = '2026-01-01T10:00:00.000Z'; // Same timestamp, ordered by sequence
    const t3 = '2026-01-02T10:00:00.000Z';

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 1000, 'manual_debit_adjustment', ?, 'Adjustment 1', 1)`,
      )
      .run(randomUUID(), randomUUID(), customerId, t1);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, -400, 'manual_credit_adjustment', ?, 'Adjustment 2', 2)`,
      )
      .run(randomUUID(), randomUUID(), customerId, t2);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 250, 'manual_debit_adjustment', ?, 'Adjustment 3', 3)`,
      )
      .run(randomUUID(), randomUUID(), customerId, t3);

    expect(store.getCustomerBalance(customerId)).toBe(850);

    const history = store.listCustomerLedger(customerId);
    expect(
      history.map((h) => [h.notes, h.amountCents, h.resultingBalanceCents]),
    ).toEqual([
      ['Adjustment 3', 250, 850],
      ['Adjustment 2', -400, 600],
      ['Adjustment 1', 1000, 1000],
    ]);
  });
});
