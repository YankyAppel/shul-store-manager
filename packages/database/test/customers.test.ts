import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
});

afterEach(() => {
  store.close();
});

describe('customer management', () => {
  it('creates and retrieves a customer with default credit limit', () => {
    const customer = store.createCustomer({
      name: 'Yakov Cohen',
      secondaryName: 'יעקב כהן',
      accountNumber: '1001',
      phone: '555-1234',
      email: 'yakov@example.com',
      address: '123 Main St',
      notes: 'Gabbai',
    });

    expect(customer).toMatchObject({
      name: 'Yakov Cohen',
      secondaryName: 'יעקב כהן',
      accountNumber: '1001',
      phone: '555-1234',
      email: 'yakov@example.com',
      address: '123 Main St',
      notes: 'Gabbai',
      active: true,
      blocked: false,
      creditLimitCents: null,
      effectiveCreditLimitCents: 50000,
      currentBalanceCents: 0,
      availableCreditCents: 50000,
    });
  });

  it('updates customer details and allows customer-specific credit limit override', () => {
    const customer = store.createCustomer({
      name: 'Avraham',
      accountNumber: '1002',
    });

    const updated = store.updateCustomer(customer.id, {
      name: 'Avraham Gold',
      accountNumber: '1002',
      phone: '555-9999',
      creditLimitCents: 100000,
    });

    expect(updated).toMatchObject({
      name: 'Avraham Gold',
      phone: '555-9999',
      creditLimitCents: 100000,
      effectiveCreditLimitCents: 100000,
    });
  });

  it('deactivates and reactivates customers', () => {
    const customer = store.createCustomer({
      name: 'Moshe',
      accountNumber: '1003',
    });

    store.setCustomerActive(customer.id, false);
    expect(store.listCustomers()).toHaveLength(0);
    expect(store.listCustomers(true)[0]?.active).toBe(false);

    store.setCustomerActive(customer.id, true);
    expect(store.listCustomers()).toHaveLength(1);
    expect(store.listCustomers()[0]?.active).toBe(true);
  });

  it('blocks and unblocks customer accounts', () => {
    const customer = store.createCustomer({
      name: 'David',
      accountNumber: '1004',
    });

    store.setCustomerBlocked(customer.id, true);
    expect(store.getCustomer(customer.id).blocked).toBe(true);

    store.setCustomerBlocked(customer.id, false);
    expect(store.getCustomer(customer.id).blocked).toBe(false);
  });

  it('enforces unique account numbers', () => {
    store.createCustomer({ name: 'First', accountNumber: 'ACCT-1' });
    expect(() =>
      store.createCustomer({ name: 'Second', accountNumber: 'acct-1' }),
    ).toThrow(/already in use/);
  });

  it('enforces unique non-null account barcodes while allowing multiple null barcodes', () => {
    store.createCustomer({
      name: 'First',
      accountNumber: '1005',
      accountBarcode: 'BAR-1',
    });

    expect(() =>
      store.createCustomer({
        name: 'Second',
        accountNumber: '1006',
        accountBarcode: 'bar-1',
      }),
    ).toThrow(/already assigned/);

    // Multiple null barcodes are allowed
    const c1 = store.createCustomer({ name: 'Third', accountNumber: '1007' });
    const c2 = store.createCustomer({ name: 'Fourth', accountNumber: '1008' });
    expect(c1.accountBarcode).toBeNull();
    expect(c2.accountBarcode).toBeNull();
  });

  it('searches customers by name, secondary name, phone, email, account number, and barcode', () => {
    store.createCustomer({
      name: 'Yisroel Levin',
      secondaryName: 'ישראל לוין',
      accountNumber: '2001',
      phone: '718-555-0101',
      email: 'levin@test.org',
      accountBarcode: 'SSM-CUST-111',
    });

    store.createCustomer({
      name: 'Shimon Katz',
      accountNumber: '2002',
      phone: '212-555-0202',
      email: 'katz@test.org',
      accountBarcode: 'SSM-CUST-222',
    });

    expect(store.searchCustomers('Yisroel')).toHaveLength(1);
    expect(store.searchCustomers('לוין')).toHaveLength(1);
    expect(store.searchCustomers('718-555')).toHaveLength(1);
    expect(store.searchCustomers('katz@test')).toHaveLength(1);
    expect(store.searchCustomers('2001')).toHaveLength(1);
    expect(store.searchCustomers('SSM-CUST-222')).toHaveLength(1);
  });

  it('generates sequential account numbers and Code 128 customer barcodes offline', () => {
    expect(store.generateAccountNumber()).toBe('1001');
    store.createCustomer({ name: 'A', accountNumber: '1001' });
    expect(store.generateAccountNumber()).toBe('1002');
    store.createCustomer({ name: 'B', accountNumber: '1050' });
    expect(store.generateAccountNumber()).toBe('1051');

    const barcode = store.generateCustomerBarcode();
    expect(barcode).toMatch(/^SSM-CUST-[A-Z0-9]+-[A-Z0-9]+$/);
  });

  it('looks up customer by barcode or account number case-insensitively', () => {
    const customer = store.createCustomer({
      name: 'Aharon',
      accountNumber: '3001',
      accountBarcode: 'SSM-CUST-3001',
    });

    expect(store.lookupCustomerByBarcodeOrAccount('ssm-cust-3001')?.id).toBe(
      customer.id,
    );
    expect(store.lookupCustomerByBarcodeOrAccount('3001')?.id).toBe(
      customer.id,
    );
    expect(store.lookupCustomerByBarcodeOrAccount('UNKNOWN')).toBeNull();
  });
});
