import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let customerId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  customerId = store.createCustomer({
    name: 'Reuven',
    accountNumber: '1001',
  }).id;
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
        ) VALUES (?, ?, ?, 500, 'sale_charge', ?, NULL, NULL, NULL, 'Test charge', 1)`,
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
    // sale_charge must be positive
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, -100, 'sale_charge', ?, 'Invalid', 1)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();

    // payment must be negative
    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 100, 'payment', ?, 'Invalid', 1)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();

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
          ) VALUES (?, ?, ?, 0, 'sale_charge', ?, 'Zero', 1)`,
        )
        .run(randomUUID(), randomUUID(), customerId, new Date().toISOString()),
    ).toThrow();
  });

  it('rejects duplicate operation IDs in the ledger', () => {
    const opId = randomUUID();
    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 500, 'sale_charge', ?, 'First', 1)`,
      )
      .run(randomUUID(), opId, customerId, new Date().toISOString());

    expect(() =>
      store.connection
        .prepare(
          `INSERT INTO customer_ledger (
            id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
          ) VALUES (?, ?, ?, 500, 'sale_charge', ?, 'Duplicate', 2)`,
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
        ) VALUES (?, ?, ?, 1000, 'sale_charge', ?, 'Sale 1', 1)`,
      )
      .run(randomUUID(), randomUUID(), customerId, t1);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, -400, 'payment', ?, 'Payment 1', 2)`,
      )
      .run(randomUUID(), randomUUID(), customerId, t2);

    store.connection
      .prepare(
        `INSERT INTO customer_ledger (
          id, operation_id, customer_id, amount_cents, entry_type, occurred_at, notes, sequence
        ) VALUES (?, ?, ?, 250, 'sale_charge', ?, 'Sale 2', 3)`,
      )
      .run(randomUUID(), randomUUID(), customerId, t3);

    expect(store.getCustomerBalance(customerId)).toBe(850);

    const history = store.listCustomerLedger(customerId);
    expect(
      history.map((h) => [h.notes, h.amountCents, h.resultingBalanceCents]),
    ).toEqual([
      ['Sale 2', 250, 850],
      ['Payment 1', -400, 600],
      ['Sale 1', 1000, 1000],
    ]);
  });
});
