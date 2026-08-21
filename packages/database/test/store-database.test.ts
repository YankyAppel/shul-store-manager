import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase, migrations } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Kiddush' }).id;
});

afterEach(() => store.close());

const productInput = (barcodes: string[] = ['012345678905']) => ({
  categoryId,
  name: 'Grape Juice',
  purchaseCostCents: 375,
  sellingPriceCents: 599,
  taxable: false,
  lowStockThreshold: 4,
  barcodes,
});

describe('migrations', () => {
  it('runs every migration on a new database and enables foreign keys', () => {
    expect(store.schemaVersion()).toBe(migrations.at(-1)?.version);
    expect(store.connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      store.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_movements'",
        )
        .get(),
    ).toBeTruthy();
  });
});

describe('catalog', () => {
  it('creates a category', () => {
    expect(store.listCategories()).toEqual([
      expect.objectContaining({
        id: categoryId,
        name: 'Kiddush',
        active: true,
      }),
    ]);
  });

  it('creates a product with integer-cent prices', () => {
    const product = store.createProduct(productInput());
    expect(product).toMatchObject({
      name: 'Grape Juice',
      purchaseCostCents: 375,
      sellingPriceCents: 599,
      stockQuantity: 0,
    });
  });

  it('rejects a duplicate barcode and rolls back product creation', () => {
    store.createProduct(productInput());
    expect(() =>
      store.createProduct({ ...productInput(), name: 'Duplicate' }),
    ).toThrow(/already assigned/);
    expect(store.listProducts()).toHaveLength(1);
  });

  it('allows multiple unique barcodes on one product', () => {
    const product = store.createProduct(
      productInput(['012345678905', '998877665544']),
    );
    expect(product.barcodes.map((barcode) => barcode.value)).toEqual([
      '012345678905',
      '998877665544',
    ]);
  });
});

describe('inventory ledger', () => {
  it('receives stock and calculates totals from positive and negative adjustments', () => {
    const product = store.createProduct(productInput());
    store.addInventoryMovement({
      productId: product.id,
      quantityChange: 24,
      reason: 'stock_received',
      notes: 'Initial case',
    });
    store.addInventoryMovement({
      productId: product.id,
      quantityChange: -2,
      reason: 'manual_decrease',
      notes: 'Count correction',
    });
    store.addInventoryMovement({
      productId: product.id,
      quantityChange: 1,
      reason: 'manual_increase',
      notes: 'Found one unit',
    });
    expect(store.listProducts()[0]?.stockQuantity).toBe(23);
    expect(store.listInventoryMovements(product.id)).toHaveLength(3);
  });

  it('rolls back an inventory transaction when a related write fails', () => {
    const product = store.createProduct(productInput());
    store.connection.exec(`
      CREATE TRIGGER test_fail_inventory_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'inventory.movement_added'
      BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END;
    `);
    expect(() =>
      store.addInventoryMovement({
        productId: product.id,
        quantityChange: 5,
        reason: 'stock_received',
        notes: 'Box',
        operationId: randomUUID(),
      }),
    ).toThrow(/simulated audit failure/);
    expect(store.listInventoryMovements(product.id)).toHaveLength(0);
    expect(store.listProducts()[0]?.stockQuantity).toBe(0);
  });

  it('enforces append-only inventory at the database layer', () => {
    const product = store.createProduct(productInput());
    const movement = store.addInventoryMovement({
      productId: product.id,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'Box',
    });
    expect(() =>
      store.connection
        .prepare('DELETE FROM inventory_movements WHERE id = ?')
        .run(movement.id),
    ).toThrow(/append-only/);
  });

  it('deactivates a product without destroying inventory history', () => {
    const product = store.createProduct(productInput());
    store.addInventoryMovement({
      productId: product.id,
      quantityChange: 8,
      reason: 'stock_received',
      notes: 'Delivery',
    });
    store.setProductActive(product.id, false);
    expect(store.listProducts()).toHaveLength(0);
    expect(store.listProducts(true)[0]).toMatchObject({
      id: product.id,
      active: false,
      stockQuantity: 8,
    });
    expect(store.listInventoryMovements(product.id)).toHaveLength(1);
  });
});
