import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let productId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Original' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Product',
    purchaseCostCents: 100,
    sellingPriceCents: 200,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['111'],
  }).id;
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
});

describe('catalog updates', () => {
  it('updates, deactivates, and reactivates categories', () => {
    expect(
      store.updateCategory(categoryId, {
        name: 'Updated',
        secondaryName: 'צווייטע',
      }).name,
    ).toBe('Updated');
    store.setCategoryActive(categoryId, false);
    expect(store.listCategories()).toHaveLength(0);
    store.setCategoryActive(categoryId, true);
    expect(store.listCategories()[0]?.active).toBe(true);
  });

  it('updates, deactivates, and reactivates products', () => {
    const updated = store.updateProduct(productId, {
      categoryId,
      name: 'Updated product',
      purchaseCostCents: 150,
      sellingPriceCents: 275,
      taxable: true,
      lowStockThreshold: 3,
      barcodes: ['222', '333'],
    });
    expect(updated).toMatchObject({
      name: 'Updated product',
      sellingPriceCents: 275,
      taxable: true,
    });
    store.setProductActive(productId, false);
    expect(store.listProducts()).toHaveLength(0);
    store.setProductActive(productId, true);
    expect(store.listProducts()[0]?.active).toBe(true);
  });
});

describe('movement directions', () => {
  const valid = [
    ['stock_received', 1],
    ['customer_return', 1],
    ['manual_increase', 1],
    ['damaged', -1],
    ['manual_decrease', -1],
    ['sale', -1],
    ['stock_count_correction', 2],
    ['stock_count_correction', -2],
  ] as const;
  const invalid = [
    ['stock_received', -1],
    ['customer_return', -1],
    ['manual_increase', -1],
    ['damaged', 1],
    ['manual_decrease', 1],
    ['sale', 1],
    ['stock_count_correction', 0],
  ] as const;

  it.each(valid)('accepts %s with quantity %i', (reason, quantityChange) => {
    expect(
      store.addInventoryMovement({
        productId,
        reason,
        quantityChange,
        notes: 'Test',
      }).quantityChange,
    ).toBe(quantityChange);
  });
  it.each(invalid)('rejects %s with quantity %i', (reason, quantityChange) => {
    expect(() =>
      store.addInventoryMovement({
        productId,
        reason,
        quantityChange,
        notes: 'Test',
      }),
    ).toThrow();
  });

  it('orders identical timestamps deterministically and calculates each resulting balance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    store.addInventoryMovement({
      productId,
      reason: 'stock_received',
      quantityChange: 10,
      notes: 'First',
    });
    store.addInventoryMovement({
      productId,
      reason: 'stock_count_correction',
      quantityChange: -3,
      notes: 'Second',
    });
    store.addInventoryMovement({
      productId,
      reason: 'stock_count_correction',
      quantityChange: 2,
      notes: 'Third',
    });
    const history = store.listInventoryMovements(productId);
    expect(
      history.map((movement) => [movement.notes, movement.resultingStock]),
    ).toEqual([
      ['Third', 9],
      ['Second', 7],
      ['First', 10],
    ]);
    expect(
      history.every(
        (movement) =>
          movement.operationId.length > 0 &&
          movement.deviceId === null &&
          movement.relatedSaleId === null,
      ),
    ).toBe(true);
  });
});

describe('image cleanup', () => {
  function image(id = randomUUID()) {
    store.registerImage({
      id,
      relativePath: `${id}.png`,
      originalName: 'test.png',
      mimeType: 'image/png',
      byteSize: 10,
      sha256: 'abc',
    });
    return id;
  }
  it('removes an unreferenced image row', () => {
    const id = image();
    expect(store.removeImageIfUnreferenced(id)).toBe(`${id}.png`);
    expect(store.getImagePath(id)).toBeNull();
  });
  it('never removes a referenced image and allows cleanup after replacement', () => {
    const id = image();
    const replacement = image();
    store.updateCategory(categoryId, { name: 'Original', imageId: id });
    expect(store.removeImageIfUnreferenced(id)).toBeNull();
    store.updateCategory(categoryId, {
      name: 'Original',
      imageId: replacement,
    });
    expect(store.removeImageIfUnreferenced(id)).toBe(`${id}.png`);
    expect(store.removeImageIfUnreferenced(replacement)).toBeNull();
  });
});
