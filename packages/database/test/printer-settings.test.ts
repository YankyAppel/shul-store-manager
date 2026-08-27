import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { receiptHtml, storeSettingsSchema } from '@shul-store/shared';
import { migrations, StoreDatabase } from '../src/index.js';

let store: StoreDatabase;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
});

afterEach(() => store.close());

describe('printer settings', () => {
  it('migrates a new database with safe printer defaults', () => {
    expect(store.schemaVersion()).toBe(migrations.at(-1)?.version);
    expect(store.getSettings()).toMatchObject({
      receiptPrinterName: null,
      receiptPaperWidthMm: 80,
      labelPrinterName: null,
      defaultLabelTemplate: 'thermal_40x30',
    });
  });

  it('round-trips printer settings through the database', () => {
    const updated = store.updateSettings({
      ...store.getSettings(),
      receiptPrinterName: 'Star TSP143',
      receiptPaperWidthMm: 58,
      labelPrinterName: 'Zebra ZD410',
      defaultLabelTemplate: 'letter_avery_5160',
    });
    store.updateDeviceSettings({
      ...store.getDeviceSettings(),
      automaticUpdatesEnabled: false,
    });
    expect(updated).toMatchObject({
      receiptPrinterName: 'Star TSP143',
      receiptPaperWidthMm: 58,
      labelPrinterName: 'Zebra ZD410',
      defaultLabelTemplate: 'letter_avery_5160',
    });
    expect(store.getSettings()).toEqual(updated);

    const cleared = store.updateSettings({
      ...updated,
      receiptPrinterName: '',
      labelPrinterName: null,
    });
    expect(cleared.receiptPrinterName).toBeNull();
    expect(cleared.labelPrinterName).toBeNull();
  });

  it('rejects invalid printer settings and leaves stored values unchanged', () => {
    const before = store.getSettings();
    expect(() =>
      store.updateSettings({
        ...before,
        receiptPaperWidthMm: 70 as never,
      }),
    ).toThrow();
    expect(() =>
      store.updateSettings({
        ...before,
        defaultLabelTemplate: 'avery-9999' as never,
      }),
    ).toThrow();
    expect(() =>
      store.updateSettings({
        ...before,
        receiptPrinterName: 'x'.repeat(201),
      }),
    ).toThrow();
    expect(store.getSettings()).toEqual(before);
    expect(
      storeSettingsSchema.safeParse({
        ...before,
        receiptPaperWidthMm: 70,
      }).success,
    ).toBe(false);
  });

  it('keeps device settings and processor secrets out of store settings', () => {
    store.updateDeviceSettings({
      updateFeedUrl: 'https://updates.example.test/feed',
      automaticUpdatesEnabled: false,
    });
    store.setCardProcessorConfigJson('{"token":"secret"}');
    const updated = store.updateSettings({
      ...store.getSettings(),
      storeName: 'Local Settings',
    });
    expect(updated).not.toHaveProperty('updateFeedUrl');
    expect(updated).not.toHaveProperty('automaticUpdatesEnabled');
    expect(updated).not.toHaveProperty('cardProcessorConfigJson');
    expect(store.getDeviceSettings()).toEqual({
      updateFeedUrl: 'https://updates.example.test/feed',
      automaticUpdatesEnabled: false,
      idleLockMinutes: 5,
      staffModeEnabled: false,
    });
    expect(store.getCardProcessorConfigJson()).toBe('{"token":"secret"}');
    expect(
      store.connection
        .prepare(
          'SELECT card_processor_config_json, update_feed_url, automatic_updates_enabled FROM store_settings WHERE singleton_id = 1',
        )
        .get(),
    ).toEqual({
      card_processor_config_json: null,
      update_feed_url: null,
      automatic_updates_enabled: 1,
    });
  });

  it('records whether the processor secret store encrypts configuration', () => {
    const encrypted = {
      available: true,
      encrypt(value: string) {
        return `encrypted:${value}`;
      },
      decrypt(value: string) {
        return value.replace(/^encrypted:/, '');
      },
    };
    const secureStore = new StoreDatabase(':memory:', encrypted);
    try {
      expect(
        secureStore.setCardProcessorConfigJson('{"token":"secure"}'),
      ).toEqual({ configured: true, encrypted: true });
      expect(secureStore.getCardProcessorConfigJson()).toBe(
        '{"token":"secure"}',
      );
      expect(
        secureStore.connection
          .prepare(
            'SELECT card_processor_config_secret FROM device_settings WHERE singleton_id = 1',
          )
          .get(),
      ).toEqual({
        card_processor_config_secret: 'encrypted:{"token":"secure"}',
      });
    } finally {
      secureStore.close();
    }
  });

  it.each([
    ['http://updates.example.test/feed', false],
    ['file:///tmp/updates', false],
    ['junk', false],
    ['https://updates.example.test/feed', true],
  ])('validates device update feed URL %s', (updateFeedUrl, valid) => {
    if (valid) {
      store.updateDeviceSettings({
        updateFeedUrl,
        automaticUpdatesEnabled: true,
      });
      expect(store.getDeviceSettings().updateFeedUrl).toBe(updateFeedUrl);
    } else {
      expect(() =>
        store.updateDeviceSettings({
          updateFeedUrl,
          automaticUpdatesEnabled: true,
        }),
      ).toThrow();
    }
  });

  it('changes receipt CSS width from paper settings without altering sale text', () => {
    const categoryId = store.createCategory({ name: 'Food' }).id;
    const productId = store.createProduct({
      categoryId,
      name: 'Cookie',
      purchaseCostCents: 100,
      sellingPriceCents: 250,
      taxable: false,
      lowStockThreshold: 0,
      barcodes: ['CK-1'],
    }).id;
    store.addInventoryMovement({
      productId,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'Case',
    });
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: 'CK-1' }],
      payment: { method: 'cash', cashReceivedCents: 250 },
    });

    store.updateSettings({
      ...store.getSettings(),
      receiptPaperWidthMm: 58,
    });
    const narrow = receiptHtml({
      sale: store.getSale(sale.id),
      settings: store.getSettings(),
    });
    store.updateSettings({
      ...store.getSettings(),
      receiptPaperWidthMm: 80,
    });
    const wide = receiptHtml({
      sale: store.getSale(sale.id),
      settings: store.getSettings(),
    });
    expect(narrow).toContain('data-paper-width="58"');
    expect(wide).toContain('data-paper-width="80"');
    expect(narrow).toContain('Cookie');
    expect(wide).toContain('Cookie');
    expect(narrow).toContain('width:58mm');
    expect(wide).toContain('width:80mm');
  });

  it('upgrades a populated v4 database with printer defaults and keeps sales', () => {
    const filename = path.join(tmpdir(), `shul-mig4-${randomUUID()}.sqlite`);
    const rawDb = new DatabaseSync(filename);
    rawDb.exec('PRAGMA foreign_keys = ON');
    for (const migration of migrations.filter((item) => item.version <= 4)) {
      rawDb.exec(migration.sql);
      rawDb.exec(`PRAGMA user_version = ${migration.version}`);
    }
    const t = '2026-08-01T12:00:00.000Z';
    const catId = randomUUID();
    const prodId = randomUUID();
    const saleId = randomUUID();
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
        `INSERT INTO sales
        (id, receipt_number, completion_key, status, subtotal_cents, tax_cents, total_cents, created_at, completed_at)
        VALUES (?, 1, ?, 'completed', 300, 0, 300, ?, ?)`,
      )
      .run(saleId, randomUUID(), t, t);
    rawDb
      .prepare(
        `INSERT INTO sale_items
        (id, sale_id, product_id, product_name, quantity, unit_selling_price_cents, unit_purchase_cost_cents, taxable, tax_cents, line_subtotal_cents, line_total_cents)
        VALUES (?, ?, ?, 'Rye Bread', 1, 300, 150, 0, 0, 300, 300)`,
      )
      .run(randomUUID(), saleId, prodId);
    rawDb
      .prepare(
        `INSERT INTO payments
        (id, sale_id, method, amount_cents, cash_received_cents, change_due_cents, created_at)
        VALUES (?, ?, 'cash', 300, 300, 0, ?)`,
      )
      .run(randomUUID(), saleId, t);
    rawDb.close();

    const upgraded = new StoreDatabase(filename);
    expect(upgraded.schemaVersion()).toBe(migrations.at(-1)?.version);
    expect(upgraded.getSettings()).toMatchObject({
      receiptPrinterName: null,
      receiptPaperWidthMm: 80,
      labelPrinterName: null,
      defaultLabelTemplate: 'thermal_40x30',
    });
    expect(upgraded.listProducts()[0]?.name).toBe('Rye Bread');
    expect(upgraded.listSales()[0]?.receiptNumber).toBe(1);
    upgraded.close();
    rmSync(filename);
  });
});
