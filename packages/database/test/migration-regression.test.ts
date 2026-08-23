import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrations, StoreDatabase } from '../src/index.js';

describe('migration upgrades and regressions', () => {
  it('upgrades a populated migration-3 database without losing data or breaking existing checkout', () => {
    const filename = path.join(tmpdir(), `shul-mig3-${randomUUID()}.sqlite`);
    const rawDb = new DatabaseSync(filename);
    rawDb.exec('PRAGMA foreign_keys = ON');

    // Run migrations 1, 2, 3 manually to simulate a production v3 database
    rawDb.exec(migrations[0]!.sql);
    rawDb.exec('PRAGMA user_version = 1');
    rawDb.exec(migrations[1]!.sql);
    rawDb.exec('PRAGMA user_version = 2');
    rawDb.exec(migrations[2]!.sql);
    rawDb.exec('PRAGMA user_version = 3');

    // Populate data on v3 schema
    const catId = randomUUID();
    const prodId = randomUUID();
    const saleId = randomUUID();
    const printAttemptId = randomUUID();
    const t = '2026-08-01T12:00:00.000Z';

    rawDb
      .prepare(
        'INSERT INTO categories (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
      )
      .run(catId, 'Bakery', t, t);

    rawDb
      .prepare(
        `INSERT INTO products
        (id, category_id, name, purchase_cost_cents, selling_price_cents, taxable, low_stock_threshold, active, created_at, updated_at)
        VALUES (?, ?, ?, 150, 300, 0, 2, 1, ?, ?)`,
      )
      .run(prodId, catId, 'Rye Bread', t, t);

    rawDb
      .prepare(
        'INSERT INTO product_barcodes (id, product_id, value, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), prodId, 'RYE-001', 'EXTERNAL', 0, t);

    rawDb
      .prepare(
        `INSERT INTO inventory_movements
        (id, operation_id, product_id, quantity_change, reason, occurred_at, notes, sequence)
        VALUES (?, ?, ?, 50, 'stock_received', ?, 'Opening Rye', 1)`,
      )
      .run(randomUUID(), randomUUID(), prodId, t);

    // Existing cash sale
    rawDb
      .prepare(
        `INSERT INTO sales
        (id, receipt_number, completion_key, status, subtotal_cents, tax_cents, total_cents, created_at, completed_at)
        VALUES (?, 1, ?, 'completed', 600, 0, 600, ?, ?)`,
      )
      .run(saleId, randomUUID(), t, t);

    rawDb
      .prepare(
        `INSERT INTO sale_items
        (id, sale_id, product_id, product_name, quantity, unit_selling_price_cents, unit_purchase_cost_cents, taxable, tax_cents, line_subtotal_cents, line_total_cents)
        VALUES (?, ?, ?, 'Rye Bread', 2, 300, 150, 0, 0, 600, 600)`,
      )
      .run(randomUUID(), saleId, prodId);

    rawDb
      .prepare(
        `INSERT INTO payments
        (id, sale_id, method, amount_cents, cash_received_cents, change_due_cents, created_at)
        VALUES (?, ?, 'cash', 600, 1000, 400, ?)`,
      )
      .run(randomUUID(), saleId, t);

    rawDb
      .prepare(
        `INSERT INTO inventory_movements
        (id, operation_id, product_id, quantity_change, reason, occurred_at, related_sale_id, notes, sequence)
        VALUES (?, ?, ?, -2, 'sale', ?, ?, 'Sale #1', 2)`,
      )
      .run(randomUUID(), randomUUID(), prodId, t, saleId);

    rawDb
      .prepare(
        `INSERT INTO print_attempts (id, sale_id, attempted_at, success, error_message) VALUES (?, ?, ?, 1, NULL)`,
      )
      .run(printAttemptId, saleId, t);

    rawDb.close();

    // Now open with StoreDatabase, which automatically runs later migrations
    const upgraded = new StoreDatabase(filename);

    expect(upgraded.schemaVersion()).toBe(migrations.at(-1)?.version);
    expect(upgraded.getSettings()).toMatchObject({
      receiptPrinterName: null,
      receiptPaperWidthMm: 80,
      labelPrinterName: null,
      defaultLabelTemplate: 'thermal_40x30',
    });

    // 1. Existing product is readable
    const products = upgraded.listProducts();
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: 'Rye Bread',
      sellingPriceCents: 300,
      stockQuantity: 48, // 50 - 2
    });

    // 2. Existing sales and receipts remain intact and readable
    const sales = upgraded.listSales();
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      receiptNumber: 1,
      totalCents: 600,
      payment: {
        method: 'cash',
        amountCents: 600,
        cashReceivedCents: 1000,
        changeDueCents: 400,
      },
    });

    // 3. Existing print attempts remain intact
    expect(
      (
        upgraded.connection
          .prepare(
            'SELECT COUNT(*) AS count FROM print_attempts WHERE sale_id = ?',
          )
          .get(saleId) as { count: number }
      ).count,
    ).toBe(1);

    // 4. Cash checkout still works after migration
    const newCashSale = upgraded.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: prodId, quantity: 1, barcodeUsed: 'RYE-001' }],
      payment: { method: 'cash', cashReceivedCents: 500 },
    });
    expect(newCashSale.receiptNumber).toBe(2);
    expect(newCashSale.payment.changeDueCents).toBe(200);
    expect(upgraded.listProducts()[0]?.stockQuantity).toBe(47);

    // 5. External-terminal checkout still works after migration
    const newTermSale = upgraded.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: prodId, quantity: 1, barcodeUsed: null }],
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'TERM-01',
      },
    });
    expect(newTermSale.receiptNumber).toBe(3);
    expect(upgraded.listProducts()[0]?.stockQuantity).toBe(46);

    // 6. New customer account & receivable features work seamlessly on upgraded database
    const customer = upgraded.createCustomer({
      name: 'Berel',
      accountNumber: '4001',
    });
    const accountSale = upgraded.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: prodId, quantity: 2, barcodeUsed: null }],
      payment: { method: 'account', customerId: customer.id, confirmed: true },
    });
    expect(accountSale.receiptNumber).toBe(4);
    expect(accountSale.payment.method).toBe('account');
    expect(upgraded.getCustomerBalance(customer.id)).toBe(600);
    expect(upgraded.listProducts()[0]?.stockQuantity).toBe(44);

    upgraded.close();
    rmSync(filename);
  });
});
