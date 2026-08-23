import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StoreDatabase, OutboxEvent } from '@shul-store/database';
import { StoreDatabase } from '@shul-store/database';
import type { CloudEvent, ConnectionTestResult } from '@shul-store/shared';
import type { PushAck, SyncTransport } from '../src/transport.js';

export const TEST_STORE_ID = '00000000-0000-0000-0000-000000000001';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function tempFile(): string {
  return path.join(tmpdir(), `shul-sync-${randomUUID()}.sqlite`);
}

export function createDb(): { db: StoreDatabase; file: string } {
  const file = tempFile();
  const db = new StoreDatabase(file);
  return { db, file };
}

export function disposeDb(db: StoreDatabase, file: string): void {
  db.close();
  rmSync(file, { force: true });
}

export function enableSync(db: StoreDatabase, storeId = TEST_STORE_ID): void {
  // Pin a specific store id for deterministic tests.
  db.applySyncCredentials({
    enabled: true,
    supabaseUrl: 'https://example.supabase.co',
    apiKeySecret: 'c2VjcmV0', // base64 of "secret"
    apiKeyEncrypted: false,
  });
  const raw = db.connection as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => void };
  };
  raw
    .prepare('UPDATE sync_settings SET store_id = ? WHERE singleton_id = 1')
    .run(storeId);
}

/** Build a populated store with catalog, customers, sales, and a payment. */
export function populateStore(db: StoreDatabase): {
  categoryId: string;
  productId: string;
  customerId: string;
} {
  db.updateSettings({
    ...db.getSettings(),
    storeName: 'Test Shul',
    taxRateBps: 0,
  });
  const category = db.createCategory({ name: 'Groceries' });
  const product = db.createProduct({
    categoryId: category.id,
    name: 'Grape Juice',
    purchaseCostCents: 200,
    sellingPriceCents: 399,
    taxable: false,
    lowStockThreshold: 3,
    barcodes: ['GRAPE-001'],
  });
  db.addInventoryMovement({
    productId: product.id,
    quantityChange: 100,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  const customer = db.createCustomer({ name: 'Berel', accountNumber: '1001' });

  // Cash sale of 2 units
  db.completeSale({
    completionKey: randomUUID(),
    lines: [{ productId: product.id, quantity: 2, barcodeUsed: 'GRAPE-001' }],
    payment: { method: 'cash', cashReceivedCents: 1000 },
  });
  // Account sale of 1 unit (creates a ledger charge)
  db.completeSale({
    completionKey: randomUUID(),
    lines: [{ productId: product.id, quantity: 1, barcodeUsed: null }],
    payment: { method: 'account', customerId: customer.id, confirmed: true },
  });
  // Account payment against the balance
  db.recordAccountPayment({
    operationId: randomUUID(),
    customerId: customer.id,
    amountCents: 399,
    payment: { method: 'cash', cashReceivedCents: 399 },
  });

  return {
    categoryId: category.id,
    productId: product.id,
    customerId: customer.id,
  };
}

export function outboxToCloudEvents(
  events: OutboxEvent[],
  storeId = TEST_STORE_ID,
): CloudEvent[] {
  return events.map((event) => ({
    eventId: event.eventId,
    storeId,
    sequence: event.sequence,
    entityType: event.entityType,
    entityId: event.entityId,
    operation: event.operation,
    payload: event.payload,
    createdAt: event.createdAt,
  }));
}

/**
 * Fake transport for deterministic engine/restore tests. Stores pushed events in
 * a Map keyed by event id (so re-pushes never duplicate), records the order of
 * receipt, and supports simulated failures and an async gate for single-flight
 * testing.
 */
export class FakeTransport implements SyncTransport {
  readonly events = new Map<string, CloudEvent>();
  readonly receivedEventIds: string[] = [];
  pushCallCount = 0;
  failOnCall: number[] = [];
  partialFailOnEventId: string | null = null;
  listShouldFail = false;
  pushGate: Promise<void> | null = null;
  private seeded: CloudEvent[] = [];

  seed(events: CloudEvent[]): void {
    this.seeded = events;
    for (const event of events) this.events.set(event.eventId, event);
  }

  async pushEvents(events: CloudEvent[]): Promise<PushAck> {
    this.pushCallCount += 1;
    if (this.failOnCall.includes(this.pushCallCount)) {
      throw new Error('FakeTransport: simulated push failure');
    }
    if (this.pushGate) await this.pushGate;
    for (const event of events) {
      if (
        this.partialFailOnEventId &&
        event.eventId === this.partialFailOnEventId
      ) {
        throw new Error('FakeTransport: simulated partial failure');
      }
      this.receivedEventIds.push(event.eventId);
      this.events.set(event.eventId, event);
    }
    return { acknowledgedEventIds: events.map((event) => event.eventId) };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: true,
      reachable: true,
      message: 'FakeTransport: connected',
    };
  }

  async listEvents(
    storeId: string,
    afterSequence: number,
  ): Promise<CloudEvent[]> {
    if (this.listShouldFail) throw new Error('FakeTransport: list failure');
    return this.seeded
      .filter(
        (event) => event.storeId === storeId && event.sequence > afterSequence,
      )
      .sort((a, b) => a.sequence - b.sequence);
  }
}
