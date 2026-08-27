import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrations, StoreDatabase } from '../src/index.js';

describe('migration upgrades and regressions', () => {
  function createV14Database(filename: string) {
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA foreign_keys = ON');
    for (const migration of migrations.filter((item) => item.version <= 14)) {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    return db;
  }

  function createV23Database(filename: string) {
    const db = createV14Database(filename);
    for (const migration of migrations.filter(
      (item) => item.version > 14 && item.version <= 23,
    )) {
      migration.before?.(db);
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    return db;
  }

  function insertPayment(
    db: DatabaseSync,
    id: string,
    key: string,
    status: string,
    createdAt: string,
  ) {
    db.prepare(
      `INSERT INTO payment_transactions
       (id, charge_reference, processor_id, amount_cents, status,
        idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'simulated', 100, ?, ?, ?, ?)`,
    ).run(id, randomUUID(), status, key, createdAt, createdAt);
  }

  it.each([
    ['declined', 'declined'],
    ['error', 'error'],
  ] as const)('repairs duplicate terminal %s idempotency keys', (status) => {
    const filename = path.join(tmpdir(), `shul-mig15-${randomUUID()}.sqlite`);
    const rawDb = createV14Database(filename);
    const key = `duplicate-${status}`;
    const first = randomUUID();
    const second = randomUUID();
    insertPayment(rawDb, first, key, status, '2026-08-01T00:00:00.000Z');
    insertPayment(rawDb, second, key, status, '2026-08-01T00:01:00.000Z');
    rawDb.close();
    const upgraded = new StoreDatabase(filename);
    try {
      expect(
        upgraded.connection
          .prepare(
            'SELECT id, idempotency_key FROM payment_transactions ORDER BY created_at',
          )
          .all(),
      ).toEqual([
        { id: first, idempotency_key: key },
        { id: second, idempotency_key: null },
      ]);
    } finally {
      upgraded.close();
      rmSync(filename, { force: true });
    }
  });

  it('aborts duplicate active idempotency repair with actionable row details', () => {
    const filename = path.join(
      tmpdir(),
      `shul-mig15-unsafe-${randomUUID()}.sqlite`,
    );
    const rawDb = createV14Database(filename);
    const key = 'unsafe-duplicate';
    const first = randomUUID();
    const second = randomUUID();
    insertPayment(rawDb, first, key, 'declined', '2026-08-01T00:00:00.000Z');
    insertPayment(rawDb, second, key, 'approved', '2026-08-01T00:01:00.000Z');
    rawDb.close();
    expect(() => new StoreDatabase(filename)).toThrow(
      new RegExp(`${key}.*${first}.*${second}`, 's'),
    );
    const check = new DatabaseSync(filename);
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 14,
      });
    } finally {
      check.close();
      rmSync(filename, { force: true });
    }
  });

  it.each([
    ['http://updates.example.test/feed', null],
    ['https://updates.example.test/feed', 'https://updates.example.test/feed'],
  ] as const)(
    'moves legacy device settings and clears the old store settings columns (%s)',
    (legacyFeedUrl, expectedFeedUrl) => {
      const filename = path.join(
        tmpdir(),
        `shul-mig24-device-${randomUUID()}.sqlite`,
      );
      const rawDb = createV23Database(filename);
      rawDb.close();
      const legacyDb = new DatabaseSync(filename);
      legacyDb
        .prepare(
          `UPDATE store_settings SET
          card_processor_config_json = ?,
          update_feed_url = ?,
          automatic_updates_enabled = 0
         WHERE singleton_id = 1`,
        )
        .run('{"apiKey":"legacy"}', legacyFeedUrl);
      legacyDb.close();
      const upgraded = new StoreDatabase(filename);
      try {
        expect(upgraded.getDeviceSettings()).toEqual({
          updateFeedUrl: expectedFeedUrl,
          automaticUpdatesEnabled: false,
          idleLockMinutes: 5,
          staffModeEnabled: false,
        });
        expect(upgraded.getCardProcessorConfigJson()).toBe(
          '{"apiKey":"legacy"}',
        );
        expect(
          upgraded.connection
            .prepare(
              'SELECT card_processor_config_json, update_feed_url, automatic_updates_enabled FROM store_settings WHERE singleton_id = 1',
            )
            .get(),
        ).toEqual({
          card_processor_config_json: null,
          update_feed_url: null,
          automatic_updates_enabled: 1,
        });
      } finally {
        upgraded.close();
        rmSync(filename, { force: true });
      }
    },
  );

  it('aborts duplicate initiated idempotency repair before creating the unique index', () => {
    const filename = path.join(
      tmpdir(),
      `shul-mig15-initiated-${randomUUID()}.sqlite`,
    );
    const rawDb = createV14Database(filename);
    const key = 'initiated-duplicate';
    const first = randomUUID();
    const second = randomUUID();
    insertPayment(rawDb, first, key, 'initiated', '2026-08-01T00:00:00.000Z');
    insertPayment(rawDb, second, key, 'error', '2026-08-01T00:01:00.000Z');
    rawDb.close();
    expect(() => new StoreDatabase(filename)).toThrow(
      new RegExp(`${key}.*${first}.*${second}`, 's'),
    );
    const check = new DatabaseSync(filename);
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 14,
      });
    } finally {
      check.close();
      rmSync(filename, { force: true });
    }
  });

  it('repairs a duplicate key when terminal rows have mixed outcomes', () => {
    const filename = path.join(
      tmpdir(),
      `shul-mig15-mixed-${randomUUID()}.sqlite`,
    );
    const rawDb = createV14Database(filename);
    const key = 'mixed-terminal-duplicate';
    const first = randomUUID();
    const second = randomUUID();
    insertPayment(rawDb, first, key, 'declined', '2026-08-01T00:00:00.000Z');
    insertPayment(rawDb, second, key, 'error', '2026-08-01T00:01:00.000Z');
    rawDb.close();
    const upgraded = new StoreDatabase(filename);
    try {
      expect(
        upgraded.connection
          .prepare(
            'SELECT id, idempotency_key FROM payment_transactions ORDER BY created_at',
          )
          .all(),
      ).toEqual([
        { id: first, idempotency_key: key },
        { id: second, idempotency_key: null },
      ]);
    } finally {
      upgraded.close();
      rmSync(filename, { force: true });
    }
  });

  it('rebuilds the customer ledger for refunds without losing rows or protections', () => {
    const filename = path.join(tmpdir(), `shul-mig18-${randomUUID()}.sqlite`);
    const rawDb = new DatabaseSync(filename);
    rawDb.exec('PRAGMA foreign_keys = ON');
    for (const migration of migrations.filter((item) => item.version <= 18)) {
      rawDb.exec(migration.sql);
      rawDb.exec(`PRAGMA user_version = ${migration.version}`);
    }
    const customerId = randomUUID();
    rawDb
      .prepare(
        `INSERT INTO customers
         (id, account_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        customerId,
        'MIGRATION-1',
        'Migration Customer',
        '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
      );
    const ledgerId = randomUUID();
    rawDb
      .prepare(
        `INSERT INTO customer_ledger
         (id, operation_id, customer_id, amount_cents, entry_type,
          occurred_at, notes, sequence)
         VALUES (?, ?, ?, -125, 'manual_credit_adjustment', ?, ?, 42)`,
      )
      .run(
        ledgerId,
        randomUUID(),
        customerId,
        '2026-08-01T00:00:00.000Z',
        'Preserved row',
      );
    rawDb.close();

    const upgraded = new StoreDatabase(filename);
    try {
      expect(
        upgraded.connection
          .prepare(
            'SELECT id, sequence, amount_cents FROM customer_ledger WHERE id = ?',
          )
          .get(ledgerId),
      ).toEqual({ id: ledgerId, sequence: 42, amount_cents: -125 });
      const indexes = upgraded.connection
        .prepare('PRAGMA index_list(customer_ledger)')
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          'customer_ledger_sale_charge_idx',
          'customer_ledger_refund_idx',
          'customer_ledger_sequence_idx',
          'customer_ledger_payment_idx',
        ]),
      );
      const triggers = upgraded.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'customer_ledger'",
        )
        .all() as Array<{ name: string }>;
      expect(triggers.map((trigger) => trigger.name)).toEqual(
        expect.arrayContaining([
          'customer_ledger_no_update',
          'customer_ledger_no_delete',
          'validate_customer_ledger_sale_charge',
          'validate_customer_ledger_payment',
          'validate_customer_ledger_sale_refund',
        ]),
      );
      expect(() =>
        upgraded.connection
          .prepare('UPDATE customer_ledger SET notes = ? WHERE id = ?')
          .run('Tampered', ledgerId),
      ).toThrow(/append-only/);
    } finally {
      upgraded.close();
      rmSync(filename, { force: true });
    }
  });

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
