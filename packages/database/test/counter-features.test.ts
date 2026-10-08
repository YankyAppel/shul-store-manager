import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { encodeWeighBarcode } from '@shul-store/shared';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;
let weightProductId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Grocery' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Challah',
    purchaseCostCents: 200,
    sellingPriceCents: 499,
    taxable: true,
    lowStockThreshold: 1,
    barcodes: ['CH123'],
  }).id;
  weightProductId = store.createProduct({
    categoryId,
    name: 'Deli Sliced Turkey',
    purchaseCostCents: 500,
    sellingPriceCents: 1299,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: [],
    soldBy: 'weight',
    unit: 'lb',
  }).id;
});
afterEach(() => store.close());

describe('sale prices', () => {
  it('creates, resolves on product listing, and removes a sale', () => {
    const now = new Date();
    const sale = store.createSalePrice({
      productId,
      priceCents: 399,
      percentOffBps: null,
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      endsAt: new Date(now.getTime() + 60_000).toISOString(),
      label: 'Shabbos',
    });
    expect(sale.priceCents).toBe(399);
    const product = store.listProducts().find((p) => p.id === productId)!;
    expect(product.salePriceCents).toBe(399);
    expect(product.saleLabel).toBe('Shabbos');
    store.deleteSalePrice(sale.id);
    expect(
      store.listProducts().find((p) => p.id === productId)!.salePriceCents,
    ).toBeNull();
  });

  it('does not resolve a future or expired sale', () => {
    const now = new Date();
    store.createSalePrice({
      productId,
      priceCents: 100,
      percentOffBps: null,
      startsAt: new Date(now.getTime() + 86_400_000).toISOString(),
      endsAt: new Date(now.getTime() + 172_800_000).toISOString(),
      label: null,
    });
    expect(
      store.listProducts().find((p) => p.id === productId)!.salePriceCents,
    ).toBeNull();
  });
});

describe('suspended sales', () => {
  it('parks, lists, resumes, and discards a suspended sale', () => {
    const parked = store.parkSale({
      label: 'Customer forgot wallet',
      customerId: null,
      lines: [{ productId, quantity: 2, barcodeUsed: 'CH123' }],
    });
    expect(parked.lines).toHaveLength(1);
    expect(store.listSuspendedSales()).toHaveLength(1);

    const resumed = store.resumeSuspendedSale(parked.id);
    expect(resumed.lines[0]!.productId).toBe(productId);
    expect(resumed.lines[0]!.quantity).toBe(2);
    expect(store.listSuspendedSales()).toHaveLength(0);

    const again = store.parkSale({
      label: null,
      customerId: null,
      lines: [
        {
          productId: weightProductId,
          quantity: 1.5,
          barcodeUsed: null,
          priceOverrideCents: 1234,
        },
      ],
    });
    expect(store.getSuspendedSale(again.id).lines[0]!.priceOverrideCents).toBe(
      1234,
    );
    store.discardSuspendedSale(again.id);
    expect(store.listSuspendedSales()).toHaveLength(0);
  });
});

describe('quick keys', () => {
  it('pins, orders, and unpins quick keys', () => {
    store.pinQuickKey(productId);
    store.pinQuickKey(weightProductId);
    const keys = store.listQuickKeys();
    expect(keys.map((k) => k.productId)).toEqual([productId, weightProductId]);
    store.pinQuickKey(productId); // idempotent
    expect(store.listQuickKeys()).toHaveLength(2);
    store.unpinQuickKey(productId);
    expect(store.listQuickKeys()).toHaveLength(1);
  });
});

describe('weigh labels', () => {
  it('assigns monotonically increasing PLUs and resolves weigh barcodes', () => {
    const plu1 = store.ensureProductPlu(weightProductId);
    const plu2 = store.ensureProductPlu(productId);
    expect(plu1).toBeGreaterThan(0);
    expect(plu2).toBeGreaterThan(plu1);
    expect(store.ensureProductPlu(weightProductId)).toBe(plu1);

    const priceCode = encodeWeighBarcode(plu1, { priceCents: 2345 });
    const hit = store.lookupCheckoutBarcode(priceCode);
    expect(hit?.product.id).toBe(weightProductId);
    expect(hit?.weigh).toEqual({
      mode: 'price',
      plu: plu1,
      priceCents: 2345,
      milliQty: null,
    });

    // weight-embedded only resolves after switching the device mode
    store.updateDeviceSettings({ weighBarcodeMode: 'weight' });
    const weightCode = encodeWeighBarcode(plu1, { milliQty: 1250 });
    const weighed = store.lookupCheckoutBarcode(weightCode);
    expect(weighed?.weigh?.milliQty).toBe(1250);
    expect(weighed?.product.id).toBe(weightProductId);
  });

  it('still finds normal barcodes and returns null for unknown digits', () => {
    expect(store.lookupCheckoutBarcode('CH123')?.product.id).toBe(productId);
    expect(store.lookupCheckoutBarcode('029999999999')).toBeNull();
    expect(store.lookupCheckoutBarcode('XYZ')).toBeNull();
  });
});

describe('stock counts', () => {
  it('runs a count, snapshots expected, and applies variance corrections', () => {
    store.addInventoryMovement({
      productId,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'opening',
    });
    const count = store.startStockCount();
    expect(count.status).toBe('open');
    store.recordStockCountLine(count.id, productId, 7);
    const finished = store.finishStockCount(count.id);
    const line = finished.lines.find((l) => l.productId === productId)!;
    expect(line.expectedUnits).toBe(10);
    expect(line.countedUnits).toBe(7);

    store.applyStockCount(count.id);
    const product = store.getProduct(productId)!;
    expect(product.stockQuantity).toBe(7);
    const movements = store.listInventoryMovements(productId);
    expect(movements.some((m) => m.reason === 'stock_count_correction')).toBe(
      true,
    );
  });

  it('cancels an open count without touching stock', () => {
    store.addInventoryMovement({
      productId,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'opening',
    });
    const count = store.startStockCount();
    store.recordStockCountLine(count.id, productId, 3);
    store.cancelStockCount(count.id);
    expect(store.getProduct(productId)!.stockQuantity).toBe(5);
    expect(store.getStockCount(count.id).count.status).toBe('cancelled');
  });
});

describe('cash drawer', () => {
  it('records pay-in/out/drop and includes them in the daily close', () => {
    store.recordCashMovement({
      kind: 'pay_in',
      amountCents: 5000,
      reason: 'change fund',
    });
    store.recordCashMovement({
      kind: 'pay_out',
      amountCents: 1500,
      reason: 'bread delivery',
    });
    store.recordCashMovement({
      kind: 'drop',
      amountCents: 20000,
      reason: 'safe drop',
    });
    const movements = store.listCashMovements();
    expect(movements).toHaveLength(3);

    const report = store.dailyReport(new Date().toISOString().slice(0, 10)!, 0);
    // expected cash = float 0 + sales 0 + pay-in 5000 − pay-out/drop 21500
    expect(report.expectedCashCents).toBe(-16500);
  });
});

describe('expiring stock', () => {
  it('aggregates remaining quantity by expiry date (FEFO order)', () => {
    const soon = new Date(Date.now() + 5 * 86_400_000)
      .toISOString()
      .slice(0, 10)!;
    const later = new Date(Date.now() + 20 * 86_400_000)
      .toISOString()
      .slice(0, 10)!;
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)!;
    store.addInventoryMovement({
      productId,
      quantityChange: 4,
      reason: 'stock_received',
      notes: 'batch A',
      expiresOn: soon,
    });
    store.addInventoryMovement({
      productId,
      quantityChange: 6,
      reason: 'stock_received',
      notes: 'batch B',
      expiresOn: later,
    });
    store.addInventoryMovement({
      productId,
      quantityChange: 2,
      reason: 'stock_received',
      notes: 'old',
      expiresOn: past,
    });
    const expiring = store.expiringStock(14);
    // already-expired + soon-expiring batches both surface; 20-day batch does not
    expect(expiring).toHaveLength(2);
    expect(expiring[0]!.expiresOn).toBe(past); // FEFO order
    expect(expiring[1]!.expiresOn).toBe(soon);
    expect(expiring.every((b) => b.productId === productId)).toBe(true);
    expect(expiring.reduce((sum, b) => sum + b.remainingUnits, 0)).toBe(6);
  });

  it('carries expires_on through insertInventoryMovement', () => {
    store.addInventoryMovement({
      productId,
      quantityChange: 3,
      reason: 'stock_received',
      notes: 'n',
      expiresOn: '2026-12-31',
    });
    const movement = store.listInventoryMovements(productId)[0]!;
    expect(movement.expiresOn).toBe('2026-12-31');
  });
});
