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

describe('account payments', () => {
  it('records cash account payment, calculates change, credits ledger, and records snapshots', () => {
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
      customerName: 'Shimon',
      accountNumber: '1001',
      amountCents: 1500,
      method: 'cash',
      cashReceivedCents: 2000,
      changeDueCents: 500,
      previousBalanceCents: 2000,
      newBalanceCents: 500,
      notes: 'Partial payment',
    });

    expect(store.getCustomerBalance(customerId)).toBe(500);

    const ledger = store.listCustomerLedger(customerId);
    expect(ledger[0]).toMatchObject({
      amountCents: -1500,
      entryType: 'payment',
      relatedAccountPaymentId: payment.id,
      resultingBalanceCents: 500,
    });
  });

  it('rejects cash account payments with insufficient cash received', () => {
    expect(() =>
      store.recordAccountPayment({
        operationId: randomUUID(),
        customerId,
        amountCents: 1500,
        payment: {
          method: 'cash',
          cashReceivedCents: 1000, // less than 1500!
        },
      }),
    ).toThrow(/less than/);

    expect(store.getCustomerBalance(customerId)).toBe(2000);
    expect(store.listAccountPayments()).toHaveLength(0);
  });

  it('records external-terminal payment with required approval and optional reference', () => {
    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 2000,
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'CARD-AUTH-88',
      },
    });

    expect(payment).toMatchObject({
      amountCents: 2000,
      method: 'external_terminal',
      terminalReference: 'CARD-AUTH-88',
      externalApproved: true,
      previousBalanceCents: 2000,
      newBalanceCents: 0,
    });

    expect(store.getCustomerBalance(customerId)).toBe(0);
  });

  it('rejects overpayments when customer credits are disabled by default', () => {
    expect(store.getSettings().allowCustomerCredit).toBe(false);

    expect(() =>
      store.recordAccountPayment({
        operationId: randomUUID(),
        customerId,
        amountCents: 2500, // Owed is 2000
        payment: {
          method: 'cash',
          cashReceivedCents: 2500,
        },
      }),
    ).toThrow(/exceeds current amount owed/);

    expect(store.getCustomerBalance(customerId)).toBe(2000);
  });

  it('accepts overpayments resulting in negative balance when customer credits are enabled', () => {
    store.updateSettings({
      ...store.getSettings(),
      allowCustomerCredit: true,
    });

    const payment = store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 2500,
      payment: {
        method: 'cash',
        cashReceivedCents: 2500,
      },
    });

    expect(payment.newBalanceCents).toBe(-500);
    expect(store.getCustomerBalance(customerId)).toBe(-500);

    const customer = store.getCustomer(customerId);
    expect(customer.currentBalanceCents).toBe(-500);
    expect(customer.availableCreditCents).toBe(50500); // 50000 limit - (-500) balance = 50500
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

  it('returns same payment for retried operationId without duplicate credits', () => {
    const opId = randomUUID();
    const first = store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 1000,
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });

    const retry = store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 1000,
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });

    expect(retry.id).toBe(first.id);
    expect(store.listAccountPayments()).toHaveLength(1);
    expect(store.getCustomerBalance(customerId)).toBe(1000);
  });

  it('rejects retried operationId with conflicting payload details', () => {
    const opId = randomUUID();
    store.recordAccountPayment({
      operationId: opId,
      customerId,
      amountCents: 1000,
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });

    expect(() =>
      store.recordAccountPayment({
        operationId: opId,
        customerId,
        amountCents: 1500,
        payment: { method: 'cash', cashReceivedCents: 1500 },
      }),
    ).toThrow(
      'An account payment with this operation ID already exists with different details.',
    );
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

  it('rolls back completely if ledger write fails during payment', () => {
    store.connection.exec(`
      CREATE TRIGGER fail_payment_ledger_test
      BEFORE INSERT ON customer_ledger
      BEGIN SELECT RAISE(ABORT, 'forced payment ledger fail'); END;
    `);

    expect(() =>
      store.recordAccountPayment({
        operationId: randomUUID(),
        customerId,
        amountCents: 1000,
        payment: { method: 'cash', cashReceivedCents: 1000 },
      }),
    ).toThrow(/forced payment ledger fail/);

    expect(store.listAccountPayments()).toHaveLength(0);
    expect(store.getCustomerBalance(customerId)).toBe(2000);
  });
});
