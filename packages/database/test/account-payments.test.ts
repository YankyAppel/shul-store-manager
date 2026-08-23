import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;
let customerId: string;
let secondCustomerId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'General' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Book',
    purchaseCostCents: 1000,
    sellingPriceCents: 2000,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['BOOK-1'],
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 10,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  customerId = store.createCustomer({
    name: 'Shimon',
    accountNumber: '1001',
  }).id;
  secondCustomerId = store.createCustomer({
    name: 'Levi',
    accountNumber: '1002',
  }).id;

  // Charge $20.00 to account
  store.completeSale({
    completionKey: randomUUID(),
    lines: [{ productId, quantity: 1, barcodeUsed: null }],
    payment: { method: 'account', customerId, confirmed: true },
  });
});

afterEach(() => {
  store.close();
});

describe('account payments & idempotency', () => {
  it('records cash account payment and supports identical retries idempotently', () => {
    const opId = randomUUID();
    const payment = store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 1500, // $15.00
      payment: {
        method: 'cash',
        cashReceivedCents: 2000, // $20.00 cash given
      },
      notes: 'Partial payment',
    });

    expect(payment).toMatchObject({
      receiptNumber: 1,
      customerId,
      amountCents: 1500,
      method: 'cash',
      cashReceivedCents: 2000,
      changeDueCents: 500,
      previousBalanceCents: 2000,
      newBalanceCents: 500,
    });

    // Retry with exact same details returns the same payment
    const retry = store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 1500,
      payment: {
        method: 'cash',
        cashReceivedCents: 2000,
      },
      notes: 'Partial payment',
    });

    expect(retry.id).toBe(payment.id);
    expect(store.listAccountPayments()).toHaveLength(1);
    expect(store.getCustomerBalance(customerId)).toBe(500);
  });

  it('treats trimmed equivalent notes and terminal references as idempotent matches', () => {
    const opId = randomUUID();
    const payment = store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 500,
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: '  AUTH-123  ',
      },
      notes: '  office payment  ',
    });

    const retry = store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 500,
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'AUTH-123',
      },
      notes: 'office payment',
    });

    expect(retry.id).toBe(payment.id);
    expect(store.listAccountPayments()).toHaveLength(1);
  });

  it('rejects retried operationId with different customer, amount, method, cash, terminal ref, or notes', () => {
    const opId = randomUUID();
    store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 1000,
      payment: { method: 'cash', cashReceivedCents: 1000 },
      notes: 'First note',
    });

    // Different customer
    expect(() =>
      store.recordAccountPayment({
        operationId: opId,
        customerId: secondCustomerId,
        amountCents: 1000,
        payment: { method: 'cash', cashReceivedCents: 1000 },
        notes: 'First note',
      }),
    ).toThrow(
      'An account payment with this operation ID already exists with different details.',
    );

    // Different amount
    expect(() =>
      store.recordAccountPayment({
        operationId: opId,
        customerId,
        amountCents: 1500,
        payment: { method: 'cash', cashReceivedCents: 1500 },
        notes: 'First note',
      }),
    ).toThrow(
      'An account payment with this operation ID already exists with different details.',
    );

    // Different method
    expect(() =>
      store.recordAccountPayment({
        operationId: opId,
        customerId,
        amountCents: 1000,
        payment: {
          method: 'external_terminal',
          approved: true,
          terminalReference: 'REF',
        },
        notes: 'First note',
      }),
    ).toThrow(
      'An account payment with this operation ID already exists with different details.',
    );

    // Different cash received
    expect(() =>
      store.recordAccountPayment({
        operationId: opId,
        customerId,
        amountCents: 1000,
        payment: { method: 'cash', cashReceivedCents: 2000 },
        notes: 'First note',
      }),
    ).toThrow(
      'An account payment with this operation ID already exists with different details.',
    );

    // Different notes
    expect(() =>
      store.recordAccountPayment({
        operationId: opId,
        customerId,
        amountCents: 1000,
        payment: { method: 'cash', cashReceivedCents: 1000 },
        notes: 'Different note',
      }),
    ).toThrow(
      'An account payment with this operation ID already exists with different details.',
    );

    // Conflict leaves exactly 1 account payment and 1 ledger entry
    expect(store.listAccountPayments()).toHaveLength(1);
    expect(store.listCustomerLedger(customerId)).toHaveLength(2); // 1 sale charge + 1 payment
  });

  it('rejects cash account payments with insufficient cash received', () => {
    expect(() =>
      store.recordAccountPayment({
        operationId: randomUUID(),
        customerId,
        amountCents: 1500,
        payment: {
          method: 'cash',
          cashReceivedCents: 1000,
        },
      }),
    ).toThrow(/less than/);
  });

  it('rejects overpayments when customer credits are disabled by default', () => {
    expect(() =>
      store.recordAccountPayment({
        operationId: randomUUID(),
        customerId,
        amountCents: 2500,
        payment: {
          method: 'cash',
          cashReceivedCents: 2500,
        },
      }),
    ).toThrow(/exceeds current amount owed/);
  });

  it('allows blocked and inactive customers to make account payments to settle balances', () => {
    store.setCustomerBlocked(customerId, true);
    const p1 = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 1000,
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });
    expect(p1.newBalanceCents).toBe(1000);

    store.setCustomerActive(customerId, false);
    const p2 = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 1000,
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });
    expect(p2.newBalanceCents).toBe(0);
  });

  it('prevents deletion of account payment linked to customer ledger via trigger', () => {
    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 1000,
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });

    expect(() =>
      store.connection
        .prepare('DELETE FROM account_payments WHERE id = ?')
        .run(payment.id),
    ).toThrow(
      'Cannot delete account payment that is linked to customer ledger',
    );
  });
});
