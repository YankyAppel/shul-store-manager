import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Deli' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Deli turkey',
    purchaseCostCents: 300,
    sellingPriceCents: 899,
    taxable: true,
    lowStockThreshold: 0,
    barcodes: ['TURKEY'],
  }).id;
});
afterEach(() => store.close());

describe('price tag links', () => {
  it('assigns a tag and queues the first push', () => {
    const link = store.assignPriceTag({
      productId,
      tagMac: 'a1b2c3d4e5f6',
      tagType: 0x1b,
    });
    expect(link.tagMac).toBe('A1B2C3D4E5F6');
    expect(link.pushStatus).toBe('pending');
    expect(store.getPriceTagLink(productId)?.id).toBe(link.id);
    expect(store.listPendingPriceTagPushes()).toHaveLength(1);
    expect(store.countPendingPriceTagPushes()).toBe(1);
  });

  it('one tag per product — reassigning moves to the new tag', () => {
    store.assignPriceTag({ productId, tagMac: 'AAAAAAAAAAAA' });
    const updated = store.assignPriceTag({
      productId,
      tagMac: 'BBBBBBBBBBBB',
    });
    expect(updated.tagMac).toBe('BBBBBBBBBBBB');
    expect(store.listPriceTagLinks()).toHaveLength(1);
  });

  it('one product per tag — assigning steals the tag off another product', () => {
    const otherId = store.createProduct({
      categoryId,
      name: 'Pastrami',
      purchaseCostCents: 500,
      sellingPriceCents: 1299,
      taxable: true,
      lowStockThreshold: 0,
      barcodes: ['PASTRAMI'],
    }).id;
    store.assignPriceTag({ productId, tagMac: 'CCCCCCCCCCCC' });
    store.assignPriceTag({ productId: otherId, tagMac: 'CCCCCCCCCCCC' });
    expect(store.getPriceTagLink(productId)).toBeNull();
    expect(store.getPriceTagLink(otherId)?.tagMac).toBe('CCCCCCCCCCCC');
  });

  it('rejects an invalid MAC', () => {
    expect(() =>
      store.assignPriceTag({ productId, tagMac: 'not-a-mac' }),
    ).toThrow();
  });

  it('editing the price re-queues the tag for a push', () => {
    const link = store.assignPriceTag({ productId, tagMac: 'DDDDDDDDDDDD' });
    store.recordPriceTagPush(link.id, true);
    expect(store.countPendingPriceTagPushes()).toBe(0);
    const base = {
      categoryId,
      name: 'Deli turkey',
      purchaseCostCents: 300,
      taxable: true,
      barcodes: ['TURKEY'],
    };
    store.updateProduct(productId, {
      ...base,
      sellingPriceCents: 999,
      lowStockThreshold: 0,
    });
    expect(store.getPriceTagLink(productId)!.pushStatus).toBe('pending');
    // Price edits queue; unrelated fields don't.
    store.recordPriceTagPush(link.id, true);
    store.updateProduct(productId, {
      ...base,
      sellingPriceCents: 999,
      lowStockThreshold: 5,
    });
    expect(store.getPriceTagLink(productId)!.pushStatus).toBe('synced');
  });

  it('unbinding removes the link', () => {
    store.assignPriceTag({ productId, tagMac: 'EEEEEEEEEEEE' });
    store.unbindPriceTag(productId);
    expect(store.getPriceTagLink(productId)).toBeNull();
    expect(store.listPriceTagLinks()).toHaveLength(0);
  });

  it('push failures retry then park as error', () => {
    const link = store.assignPriceTag({ productId, tagMac: 'FFFFFFFFFFFF' });
    for (let i = 0; i < 9; i += 1) {
      store.recordPriceTagPush(link.id, false, 'AP unreachable');
      expect(store.getPriceTagLink(productId)!.pushStatus).toBe('pending');
    }
    store.recordPriceTagPush(link.id, false, 'AP unreachable');
    const parked = store.getPriceTagLink(productId)!;
    expect(parked.pushStatus).toBe('error');
    expect(parked.pushError).toBe('AP unreachable');
    expect(parked.pushAttempts).toBe(10);
    expect(store.listPendingPriceTagPushes()).toHaveLength(0);
  });

  it('records a successful push with timestamp', () => {
    const link = store.assignPriceTag({ productId, tagMac: '121212121212' });
    store.recordPriceTagPush(link.id, true);
    const synced = store.getPriceTagLink(productId)!;
    expect(synced.pushStatus).toBe('synced');
    expect(synced.lastPushedAt).not.toBeNull();
    expect(synced.pushError).toBeNull();
  });
});
