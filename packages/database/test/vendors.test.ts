import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReorderQuantity } from '@shul-store/shared';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let vendorId: string;
let otherVendorId: string;

const product = (name: string, barcode: string, threshold = 5) =>
  store.createProduct({
    categoryId,
    name,
    purchaseCostCents: 150,
    sellingPriceCents: 300,
    taxable: false,
    lowStockThreshold: threshold,
    barcodes: [barcode],
    vendors: [{ vendorId, preferred: true }],
  });

const receive = (productId: string, quantity: number) =>
  store.addInventoryMovement({
    productId,
    quantityChange: quantity,
    reason: 'stock_received',
    notes: 'test',
  });

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Drinks' }).id;
  vendorId = store.createVendor({
    name: 'ABC Distributors',
    email: 'orders@abc.example',
    defaultReorderQty: 6,
  }).id;
  otherVendorId = store.createVendor({ name: 'Other Co' }).id;
});

afterEach(() => store.close());

describe('reorder quantity resolution', () => {
  it('prefers product override, then case size, then vendor default', () => {
    expect(
      resolveReorderQuantity({
        overrideQty: 3,
        caseSize: 12,
        minOrderQty: null,
        vendorDefaultQty: 6,
      }),
    ).toBe(3);
    expect(
      resolveReorderQuantity({
        overrideQty: null,
        caseSize: 12,
        minOrderQty: null,
        vendorDefaultQty: 6,
      }),
    ).toBe(12);
    expect(
      resolveReorderQuantity({
        overrideQty: null,
        caseSize: null,
        minOrderQty: null,
        vendorDefaultQty: 6,
      }),
    ).toBe(6);
    expect(
      resolveReorderQuantity({
        overrideQty: null,
        caseSize: null,
        minOrderQty: 24,
        vendorDefaultQty: 6,
      }),
    ).toBe(24);
  });
});

describe('vendors and product links', () => {
  it('stores links, exposes them on the product and requires one preferred', () => {
    const created = product('Cola', 'COLA-1');
    expect(created.vendors).toEqual([
      expect.objectContaining({
        vendorId,
        vendorName: 'ABC Distributors',
        preferred: true,
      }),
    ]);
    expect(() =>
      store.setProductVendors(created.id, [
        { vendorId, preferred: true },
        { vendorId: otherVendorId, preferred: true },
      ]),
    ).toThrow();
    const updated = store.setProductVendors(created.id, [
      { vendorId, preferred: false, costCents: 120 },
      { vendorId: otherVendorId, preferred: true },
    ]);
    expect(updated.vendors.map((v) => [v.vendorId, v.preferred])).toEqual([
      [otherVendorId, true],
      [vendorId, false],
    ]);
  });

  it('carries vendor links through the sync payload', () => {
    const created = product('Cola', 'COLA-1');
    const pending = store.pendingSyncEvents(50);
    const entry = pending.find((e) => e.entityId === created.id);
    const payload = entry?.payload as { vendors?: unknown[] } | undefined;
    expect(payload?.vendors).toEqual([
      expect.objectContaining({
        vendorId,
        vendorName: 'ABC Distributors',
        preferred: true,
      }),
    ]);
  });

  it('flags likely duplicate vendors', () => {
    expect(
      store.vendors.findSimilarVendors('A.B.C. Dist', null).map((v) => v.id),
    ).toEqual([vendorId]);
    expect(store.vendors.findSimilarVendors('Zed', null)).toEqual([]);
    expect(
      store.vendors
        .findSimilarVendors('abc distributors', null)
        .map((v) => v.id),
    ).toEqual([vendorId]);
    expect(
      store.vendors
        .findSimilarVendors('Zed', 'ORDERS@abc.example')
        .map((v) => v.id),
    ).toEqual([vendorId]);
  });

  it('follows catalog vendor merges across links, catalog rows and suggestions', () => {
    const cola = product('Cola', 'COLA-1');
    const both = product('Water', 'WATER-1');
    store.setProductVendors(both.id, [
      { vendorId, preferred: true, costCents: 90 },
      { vendorId: otherVendorId, preferred: false },
    ]);
    const only = product('Juice', 'JUICE-1');
    store.setProductVendors(only.id, [
      { vendorId: otherVendorId, preferred: true },
    ]);
    const stamp = new Date().toISOString();
    const row = (vendor_id: string, barcode: string, price_cents: number) => ({
      id: randomUUID(),
      vendor_id,
      barcode,
      sku: null,
      name: barcode,
      case_size: null,
      min_order_qty: null,
      price_cents,
      updated_at: stamp,
    });
    store.vendors.upsertCatalogVendorProducts([
      row(vendorId, 'cola-1', 500),
      row(vendorId, 'water-1', 100),
      row(otherVendorId, 'water-1', 120),
    ]);
    expect(store.vendors.listBuyingList(vendorId)).toHaveLength(2);
    store.markSyncEventsPushed(
      store.pendingSyncEvents(50).map((e) => e.eventId),
    );

    expect(
      store.applyCatalogVendorMerges([
        { source_id: vendorId, target_id: otherVendorId },
        { source_id: randomUUID(), target_id: otherVendorId },
      ]),
    ).toBe(1);

    expect(store.vendors.findVendor(vendorId)).toBeNull();
    expect(store.getProduct(cola.id).vendors).toEqual([
      expect.objectContaining({ vendorId: otherVendorId, preferred: true }),
    ]);
    expect(store.getProduct(both.id).vendors).toEqual([
      expect.objectContaining({
        vendorId: otherVendorId,
        preferred: true,
        costCents: 90,
      }),
    ]);
    expect(store.getProduct(only.id).vendors).toHaveLength(1);
    const lines = store.vendors.listBuyingList(otherVendorId);
    expect(lines.map((l) => l.productId).sort()).toEqual(
      [cola.id, both.id, only.id].sort(),
    );
    expect(lines.find((l) => l.productId === both.id)?.listPriceCents).toBe(
      120,
    );
    expect(lines.find((l) => l.productId === cola.id)?.listPriceCents).toBe(
      500,
    );
    const resynced = store
      .pendingSyncEvents(50)
      .filter((e) => e.entityType === 'product')
      .map((e) => e.entityId)
      .sort();
    expect(resynced).toEqual([cola.id, both.id].sort());
  });
});

describe('margin report', () => {
  it('costs each product from negotiated, catalog list, then product cost', () => {
    const cola = product('Cola', 'COLA-1');
    product('Water', 'WATER-1');
    const juice = product('Juice', 'JUICE-1');
    store.setProductVendors(cola.id, [
      { vendorId, preferred: true, costCents: 100 },
    ]);
    store.vendors.upsertCatalogVendorProducts([
      {
        id: randomUUID(),
        vendor_id: vendorId,
        barcode: 'cola-1',
        sku: null,
        name: 'Cola',
        case_size: null,
        min_order_qty: null,
        price_cents: 180,
        updated_at: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        vendor_id: vendorId,
        barcode: 'water-1',
        sku: null,
        name: 'Water',
        case_size: null,
        min_order_qty: null,
        price_cents: 200,
        updated_at: new Date().toISOString(),
      },
    ]);
    receive(cola.id, 10);
    receive(juice.id, 2);

    const report = store.vendors.marginReport();
    const byName = Object.fromEntries(
      report.lines.map((line) => [line.productName, line]),
    );
    expect(byName.Cola).toMatchObject({
      costCents: 100,
      costSource: 'negotiated',
      marginCents: 200,
      vendorName: 'ABC Distributors',
      stockQuantity: 10,
    });
    expect(byName.Water).toMatchObject({
      costCents: 200,
      costSource: 'catalog',
      marginCents: 100,
    });
    expect(byName.Juice).toMatchObject({
      costCents: 150,
      costSource: 'product',
      marginCents: 150,
      marginRatio: 0.5,
    });
    expect(report.retailValueCents).toBe(12 * 300);
    expect(report.costValueCents).toBe(10 * 100 + 2 * 150);
    expect(report.missingCostCount).toBe(0);
  });
});

describe('buying list', () => {
  it('suggests a product once stock reaches its threshold and clears it when restocked', () => {
    const cola = product('Cola', 'COLA-1', 5);
    receive(cola.id, 20);
    expect(store.vendors.listBuyingList(vendorId)).toEqual([]);

    store.addInventoryMovement({
      productId: cola.id,
      quantityChange: -15,
      reason: 'manual_decrease',
      notes: 'sold out',
    });
    const [line] = store.vendors.listBuyingList(vendorId);
    expect(line).toMatchObject({
      productId: cola.id,
      vendorId,
      stockQuantity: 5,
      quantity: 6,
      unitCostCents: 150,
      status: 'open',
    });

    const summary = store.vendors
      .listVendorSummaries()
      .find((v) => v.id === vendorId);
    expect(summary).toMatchObject({
      openLineCount: 1,
      openQuantity: 6,
      estimatedTotalCents: 900,
      linkedProductCount: 1,
    });

    receive(cola.id, 10);
    expect(store.vendors.listBuyingList(vendorId)).toEqual([]);
  });

  it('uses the vendor catalog case size and negotiated cost', () => {
    const cola = product('Cola', 'COLA-1', 5);
    store.vendors.upsertCatalogVendorProducts([
      {
        id: randomUUID(),
        vendor_id: vendorId,
        barcode: 'cola-1',
        sku: 'ABC-COLA',
        name: 'Cola 12pk',
        case_size: 12,
        min_order_qty: null,
        price_cents: 800,
        updated_at: new Date().toISOString(),
      },
    ]);
    let [line] = store.vendors.listBuyingList(vendorId);
    expect(line).toMatchObject({
      quantity: 12,
      unitCostCents: 800,
      listPriceCents: 800,
      vendorSku: 'ABC-COLA',
    });

    store.setProductVendors(cola.id, [
      { vendorId, preferred: true, costCents: 700, reorderQty: 24 },
    ]);
    [line] = store.vendors.listBuyingList(vendorId);
    expect(line).toMatchObject({ quantity: 24, unitCostCents: 700 });

    store.updateVendor(vendorId, {
      name: 'ABC Distributors',
      hideListPrice: true,
    });
    [line] = store.vendors.listBuyingList(vendorId);
    expect(line.listPriceCents).toBeNull();
  });

  it('honours manual quantity, dismissal and vendor switching', () => {
    const cola = product('Cola', 'COLA-1', 5);
    store.setProductVendors(cola.id, [
      { vendorId, preferred: true },
      { vendorId: otherVendorId, preferred: false },
    ]);
    let [line] = store.vendors.listBuyingList(vendorId);
    line = store.vendors.updateBuyingListLine(line.id, {
      quantityOverride: 40,
    });
    expect(line.quantity).toBe(40);

    line = store.vendors.updateBuyingListLine(line.id, {
      vendorId: otherVendorId,
    });
    expect(store.vendors.listBuyingList(vendorId)).toEqual([]);
    expect(store.vendors.listBuyingList(otherVendorId)[0]?.quantity).toBe(40);

    store.vendors.updateBuyingListLine(line.id, { status: 'dismissed' });
    expect(store.vendors.listBuyingList(otherVendorId)).toEqual([]);
    // Still low, but dismissed: refresh must not re-add it.
    expect(store.vendors.listBuyingList(undefined, ['dismissed'])).toHaveLength(
      1,
    );

    const readded = store.vendors.addBuyingListLine(cola.id, vendorId, null);
    expect(readded.status).toBe('open');
    expect(readded.quantity).toBe(40);
  });

  it('never suggests products without a preferred vendor', () => {
    store.createProduct({
      categoryId,
      name: 'No vendor',
      purchaseCostCents: 0,
      sellingPriceCents: 100,
      taxable: false,
      lowStockThreshold: 5,
      barcodes: [],
    });
    expect(store.vendors.listBuyingList()).toEqual([]);
  });
});
