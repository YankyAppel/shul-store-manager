import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase, type ValidatedRestoreEvent } from '../src/index.js';

function tempFile(): string {
  return path.join(tmpdir(), `shul-restore-${randomUUID()}.sqlite`);
}

let store: StoreDatabase;
let file: string;

beforeEach(() => {
  file = tempFile();
  store = new StoreDatabase(file);
});

afterEach(() => {
  store.close();
  rmSync(file, { force: true });
});

describe('restore guards', () => {
  it('is only allowed on a fresh database with no business data', () => {
    expect(store.isRestoreAllowed()).toBe(true);
    store.createCategory({ name: 'Anything' });
    expect(store.isRestoreAllowed()).toBe(false);
  });

  it('allows cloud restore when the only local row is a paired kiosk', () => {
    store.createKiosk(randomUUID(), 'Front kiosk', 'token-hash', 'pin-hash');
    expect(store.isRestoreAllowed()).toBe(true);
  });

  it('rolls back the whole replay when a database invariant is violated', () => {
    // A standalone inventory_movement event whose productId does not exist must
    // be rejected by the foreign-key constraint, aborting the transaction and
    // leaving the database untouched.
    const hostileEvent: ValidatedRestoreEvent = {
      sequence: 1,
      eventId: randomUUID(),
      entityType: 'inventory_movement',
      entityId: randomUUID(),
      operation: 'append',
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        id: randomUUID(),
        operationId: randomUUID(),
        productId: randomUUID(), // nonexistent product -> FK violation
        quantityChange: 5,
        reason: 'stock_received',
        occurredAt: '2026-01-01T00:00:00.000Z',
        deviceId: null,
        relatedSaleId: null,
        notes: 'hostile',
        sequence: 1,
      },
    };

    expect(() => store.replayValidatedEvents([hostileEvent])).toThrow();
    // Nothing was applied and the database is still considered fresh.
    expect(store.isRestoreAllowed()).toBe(true);
    expect(store.pendingSyncEventCount()).toBe(0);
  });

  it('rejects a structurally valid payload that violates a CHECK constraint', () => {
    const category = store.createCategory({ name: 'Cat' });
    const product = store.createProduct({
      categoryId: category.id,
      name: 'Thing',
      purchaseCostCents: 0,
      sellingPriceCents: 0,
      taxable: false,
      lowStockThreshold: 0,
      barcodes: [],
    });
    // quantity_change of 0 violates the inventory_movements CHECK constraint.
    const badMovement: ValidatedRestoreEvent = {
      sequence: 1,
      eventId: randomUUID(),
      entityType: 'inventory_movement',
      entityId: randomUUID(),
      operation: 'append',
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        id: randomUUID(),
        operationId: randomUUID(),
        productId: product.id,
        quantityChange: 0, // CHECK (quantity_change <> 0)
        reason: 'stock_received',
        occurredAt: '2026-01-01T00:00:00.000Z',
        deviceId: null,
        relatedSaleId: null,
        notes: 'hostile',
        sequence: 1,
      },
    };

    expect(() => store.replayValidatedEvents([badMovement])).toThrow();
    // The product existed before; the hostile movement was not applied.
    expect(store.listInventoryMovements(product.id)).toHaveLength(0);
  });
});
