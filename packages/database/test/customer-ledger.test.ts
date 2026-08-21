import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let customerId: string;
let categoryId: string;
let productId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  customerId = store.createCustomer({
    name: 'Reuven',
    accountNumber: '1001',
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

  it('enforces cross-table constraints on sale_charge and payment entry types', () => {
    // sale_charge without matching sale fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, 1000, 'sale_charge', ?, ?, NULL, 'Fake sale', 1)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          randomUUID(),
        ),
    ).toThrow(/sale_charge ledger entry must match an existing account sale/);

    // payment without matching account payment fails
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
            related_sale_id, related_account_payment_id, notes, sequence
          ) VALUES (?, ?, ?, -500, 'payment', ?, NULL, ?, 'Fake payment', 1)`,
        )
        .run(
          randomUUID(),
          randomUUID(),
          customerId,
          new Date().toISOString(),
          randomUUID(),
        ),
    ).toThrow(/payment ledger entry must match an existing account payment/);
  });

  it('rejects duplicate operation IDs in the ledger', () => {
    const opId = randomUUID();
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 500, 'manual_debit_adjustment', ?, 'First', 1)`,
      )
      .run(randomUUID(), opId, customerId, new Date().toISOString());

    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 500, 'manual_debit_adjustment', ?, 'Duplicate', 2)`,
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
