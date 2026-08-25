import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  calculateCart,
  calculateCashChange,
  completeSaleInputSchema,
  parseUsdToCents,
} from '@shul-store/shared';
import { migrations, StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let productId: string;
let categoryId: string;
const key = () => randomUUID();
const cash = (completionKey = key(), received = 2000) => ({
  completionKey,
  lines: [{ productId, quantity: 2, barcodeUsed: 'ABC' }],
  payment: { method: 'cash' as const, cashReceivedCents: received },
});

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Food' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Cookie',
    secondaryName: 'קיכל',
    purchaseCostCents: 100,
    sellingPriceCents: 333,
    taxable: true,
    lowStockThreshold: 2,
    barcodes: ['ABC', 'DEF'],
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 10,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
});
afterEach(() => store.close());

describe('migrations', () => {
  it('upgrades a migration-1 database through the checkout schema', () => {
    const filename = path.join(tmpdir(), `shul-${randomUUID()}.sqlite`);
    const db = new DatabaseSync(filename);
    db.exec(migrations[0]!.sql);
    db.exec('PRAGMA user_version=1');
    db.close();
    const upgraded = new StoreDatabase(filename);
    expect(upgraded.schemaVersion()).toBe(migrations.at(-1)?.version);
    expect(
      upgraded.connection
        .prepare("SELECT name FROM sqlite_master WHERE name='sales'")
        .get(),
    ).toBeTruthy();
    upgraded.close();
    rmSync(filename);
  });
  it('creates every schema on a fresh database', () =>
    expect(store.schemaVersion()).toBe(migrations.at(-1)?.version));
});

describe('lookup and calculations', () => {
  it('looks up any assigned barcode and excludes inactive products', () => {
    expect(store.lookupProductByBarcode('def')?.id).toBe(productId);
    store.setProductActive(productId, false);
    expect(store.lookupProductByBarcode('DEF')).toBeNull();
  });
  it('calculates tax-exclusive totals with half-up rounding', () => {
    const product = store.listProducts()[0]!;
    const total = calculateCart([{ product, quantity: 3 }], {
      taxRateBps: 887,
      pricesIncludeTax: false,
    });
    expect(total).toMatchObject({
      subtotalCents: 999,
      taxCents: 89,
      totalCents: 1088,
    });
  });
  it('calculates tax-inclusive totals and extracts included tax', () => {
    const product = store.listProducts()[0]!;
    const total = calculateCart([{ product, quantity: 3 }], {
      taxRateBps: 887,
      pricesIncludeTax: true,
    });
    expect(total).toMatchObject({
      subtotalCents: 918,
      taxCents: 81,
      totalCents: 999,
    });
  });
  it('does not tax non-taxable products', () => {
    const product = { ...store.listProducts()[0]!, taxable: false };
    expect(
      calculateCart([{ product, quantity: 1 }], {
        taxRateBps: 1000,
        pricesIncludeTax: false,
      }).taxCents,
    ).toBe(0);
  });

  it('uses bigint intermediates for a large valid tax-exclusive calculation', () => {
    const product = {
      ...store.listProducts()[0]!,
      sellingPriceCents: 800_000_000_000,
    };
    expect(
      calculateCart([{ product, quantity: 10_000 }], {
        taxRateBps: 500,
        pricesIncludeTax: false,
      }),
    ).toMatchObject({
      subtotalCents: 8_000_000_000_000_000,
      taxCents: 400_000_000_000_000,
      totalCents: 8_400_000_000_000_000,
    });
  });

  it('uses bigint intermediates for a large valid tax-inclusive calculation', () => {
    const product = {
      ...store.listProducts()[0]!,
      sellingPriceCents: 800_000_000_000,
    };
    expect(
      calculateCart([{ product, quantity: 10_000 }], {
        taxRateBps: 10_000,
        pricesIncludeTax: true,
      }),
    ).toMatchObject({
      subtotalCents: 4_000_000_000_000_000,
      taxCents: 4_000_000_000_000_000,
      totalCents: 8_000_000_000_000_000,
    });
  });

  it('rejects unsafe line and cart totals instead of losing precision', () => {
    const product = {
      ...store.listProducts()[0]!,
      sellingPriceCents: Number.MAX_SAFE_INTEGER,
      taxable: false,
    };
    expect(() =>
      calculateCart([{ product, quantity: 2 }], {
        taxRateBps: 0,
        pricesIncludeTax: false,
      }),
    ).toThrow(/safe integer range/);
    const half = { ...product, sellingPriceCents: 4_600_000_000_000_000 };
    expect(() =>
      calculateCart(
        [
          { product: half, quantity: 1 },
          { product: { ...half, id: randomUUID() }, quantity: 1 },
        ],
        { taxRateBps: 0, pricesIncludeTax: false },
      ),
    ).toThrow(/Cart subtotal exceeds/);
  });

  it('parses cash without floating point and rejects unsafe values', () => {
    expect(parseUsdToCents('20')).toBe(2000);
    expect(parseUsdToCents('20.05')).toBe(2005);
    expect(() => parseUsdToCents('1.005')).toThrow(/valid amount/);
    expect(() => parseUsdToCents('90071992547409.92')).toThrow(/safe integer/);
  });

  it('calculates safe cash change and rejects unsafe cash values', () => {
    expect(calculateCashChange(733, 2000)).toBe(1267);
    expect(calculateCashChange(0, Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => calculateCashChange(0, Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /safe integer/,
    );
    expect(
      completeSaleInputSchema.safeParse({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: {
          method: 'cash',
          cashReceivedCents: Number.MAX_SAFE_INTEGER + 1,
        },
      }).success,
    ).toBe(false);
  });
});

describe('sale completion', () => {
  beforeEach(() =>
    store.updateSettings({
      storeName: 'Test Store',
      contactLines: ['1 Main St'],
      currency: 'USD',
      taxRateBps: 1000,
      pricesIncludeTax: false,
      receiptFooter: 'Thank you',
    }),
  );
  it('completes cash, calculates change, snapshots values, and deducts stock', () => {
    const sale = store.completeSale(cash());
    expect(sale).toMatchObject({
      status: 'completed',
      subtotalCents: 666,
      taxCents: 67,
      totalCents: 733,
    });
    expect(sale.payment).toMatchObject({
      method: 'cash',
      cashReceivedCents: 2000,
      changeDueCents: 1267,
    });
    expect(sale.items[0]).toMatchObject({
      productName: 'Cookie',
      secondaryName: 'קיכל',
      unitSellingPriceCents: 333,
      unitPurchaseCostCents: 100,
      barcodeUsed: 'ABC',
    });
    expect(store.listProducts()[0]?.stockQuantity).toBe(8);
    store.updateProduct(productId, {
      categoryId,
      name: 'Changed',
      purchaseCostCents: 500,
      sellingPriceCents: 900,
      taxable: false,
      lowStockThreshold: 0,
      barcodes: ['ABC'],
    });
    expect(store.getSale(sale.id).items[0]?.productName).toBe('Cookie');
  });
  it('maps sale origin metadata and defaults legacy values to manager', () => {
    const sale = store.completeSale(cash());
    expect(sale).toMatchObject({ channel: 'manager', kioskId: null });

    const kioskId = randomUUID();
    store.createKiosk(kioskId, 'Front kiosk', 'token-hash', 'pin-hash');
    store.connection
      .prepare("UPDATE sales SET channel='kiosk', kiosk_id=? WHERE id=?")
      .run(kioskId, sale.id);
    expect(store.getSale(sale.id)).toMatchObject({
      channel: 'kiosk',
      kioskId,
    });

    store.connection
      .prepare("UPDATE sales SET channel='manager', kiosk_id=NULL WHERE id=?")
      .run(sale.id);
    expect(store.getSale(sale.id)).toMatchObject({
      channel: 'manager',
      kioskId: null,
    });
  });
  it('rejects insufficient cash without writes', () => {
    expect(() => store.completeSale(cash(key(), 100))).toThrow(/less than/);
    expect(store.listSales()).toHaveLength(0);
    expect(store.listProducts()[0]?.stockQuantity).toBe(10);
  });
  it('completes an approved external-terminal sale with optional reference', () => {
    const sale = store.completeSale({
      completionKey: key(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'TERM-9',
      },
    });
    expect(sale.payment).toMatchObject({
      method: 'external_terminal',
      terminalReference: 'TERM-9',
      externalApproved: true,
    });
  });
  it('accepts no external reference but requires explicit approval', () => {
    expect(
      store.completeSale({
        completionKey: key(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: {
          method: 'external_terminal',
          approved: true,
          terminalReference: null,
        },
      }).payment.terminalReference,
    ).toBeNull();
    expect(() =>
      store.completeSale({
        completionKey: key(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: {
          method: 'external_terminal',
          approved: false,
          terminalReference: null,
        },
      } as never),
    ).toThrow();
  });
  it('returns the same sale for a retried completion key without duplicate deductions', () => {
    const completionKey = key();
    const first = store.completeSale(cash(completionKey));
    const retry = store.completeSale(cash(completionKey));
    expect(retry.id).toBe(first.id);
    expect(store.listSales()).toHaveLength(1);
    expect(store.listProducts()[0]?.stockQuantity).toBe(8);
  });
  it('rolls back items and inventory if payment insertion fails', () => {
    store.connection.exec(
      "CREATE TRIGGER fail_payment BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT,'payment failed'); END",
    );
    expect(() => store.completeSale(cash())).toThrow(/payment failed/);
    expect(store.listSales()).toHaveLength(0);
    expect(store.listProducts()[0]?.stockQuantity).toBe(10);
    expect(
      (
        store.connection
          .prepare('SELECT COUNT(*) AS count FROM sale_items')
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
  it('rejects inactive products and insufficient stock', () => {
    store.setProductActive(productId, false);
    expect(() => store.completeSale(cash())).toThrow(/inactive/);
    store.setProductActive(productId, true);
    expect(() =>
      store.completeSale({
        ...cash(),
        lines: [{ productId, quantity: 11, barcodeUsed: null }],
      }),
    ).toThrow(/Insufficient stock/);
  });
  it('builds receipt data and records retries without changing the sale', () => {
    const sale = store.completeSale(cash());
    const receipt = {
      sale: store.getSale(sale.id),
      settings: store.getSettings(),
    };
    expect(receipt).toMatchObject({
      settings: { storeName: 'Test Store', receiptFooter: 'Thank you' },
      sale: { receiptNumber: 1 },
    });
    store.recordPrintAttempt(sale.id, false, 'printer offline');
    store.recordPrintAttempt(sale.id, true, null);
    expect(store.listSales()).toHaveLength(1);
    expect(
      (
        store.connection
          .prepare('SELECT COUNT(*) AS count FROM print_attempts')
          .get() as { count: number }
      ).count,
    ).toBe(2);
  });
});
