import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let db: StoreDatabase | undefined;
let file: string | undefined;

afterEach(() => {
  db?.close();
  if (file) rmSync(file, { force: true });
  db = undefined;
  file = undefined;
});

function createStore(): StoreDatabase {
  file = path.join(tmpdir(), `shul-cloud-sync-${randomUUID()}.sqlite`);
  db = new StoreDatabase(file);
  return db;
}

function addProduct(store: StoreDatabase) {
  const category = store.createCategory({ name: 'Cloud' });
  const product = store.createProduct({
    categoryId: category.id,
    name: 'Item',
    purchaseCostCents: 100,
    sellingPriceCents: 200,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: [],
  });
  store.addInventoryMovement({
    productId: product.id,
    quantityChange: 10,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  return product;
}

describe('cloud receipt allocation', () => {
  it('preserves prefix-one sequencing and uses an independent prefixed range', () => {
    const store = createStore();
    const product = addProduct(store);
    const first = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: product.id, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 200 },
    });
    expect(first.receiptNumber).toBe(1);

    store.setDeviceReceiptPrefix(2);
    const second = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: product.id, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 200 },
    });
    expect(second.receiptNumber).toBe(2_000_001);
  });

  it('ignores pulled history in another device prefix', () => {
    const store = createStore();
    store.connection
      .prepare(
        `INSERT INTO sales
          (id, receipt_number, completion_key, status, subtotal_cents, tax_cents,
           total_cents, created_at, completed_at)
         VALUES (?, ?, ?, 'completed', 0, 0, 0, ?, ?)`,
      )
      .run(
        randomUUID(),
        1_000_000,
        randomUUID(),
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
      );
    expect(() => store.validateReceiptPrefix(1)).not.toThrow();
  });

  it('rejects prefix-one allocation when its own range is exhausted', () => {
    const store = createStore();
    const product = addProduct(store);
    store.connection
      .prepare(
        `INSERT INTO sales
          (id, receipt_number, completion_key, status, subtotal_cents, tax_cents,
           total_cents, created_at, completed_at)
         VALUES (?, ?, ?, 'completed', 0, 0, 0, ?, ?)`,
      )
      .run(
        randomUUID(),
        999_999,
        randomUUID(),
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
      );
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId: product.id, quantity: 1, barcodeUsed: null }],
        payment: { method: 'cash', cashReceivedCents: 200 },
      }),
    ).toThrow('exhausted the original receipt-number range');
  });
});
