import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SyncEngine } from '../src/index.js';
import {
  createDb,
  disposeDb,
  enableSync,
  FakeTransport,
  populateStore,
} from './helpers.js';

describe('cloud kiosk offline sync behavior', () => {
  it('keeps a locally completed sale when cloud transport is unavailable', async () => {
    const { db, file } = createDb();
    enableSync(db);
    const catalog = populateStore(db);
    const sale = db.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId: catalog.productId, quantity: 1, barcodeUsed: null }],
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'cloud-kiosk-offline',
      },
    });
    const before = db.pendingSyncEventCount();
    const transport = new FakeTransport();
    transport.failOnCall = [1];

    const result = await new SyncEngine(db, transport).syncNow();

    expect(result.error).toContain('simulated push failure');
    expect(db.pendingSyncEventCount()).toBeGreaterThanOrEqual(before);
    expect(db.getSale(sale.id).status).toBe('completed');
    disposeDb(db, file);
  });

  it('pushes events with the kiosk device identity and ignores its own pull echo', async () => {
    const { db, file } = createDb();
    enableSync(db);
    const deviceId = db.getSyncConfigRecord().deviceId;
    populateStore(db);
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport);

    await engine.syncNow();
    const pushed = [...transport.events.values()];

    expect(deviceId).toBeTruthy();
    expect(pushed.length).toBeGreaterThan(0);
    expect(new Set(pushed.map((event) => event.deviceId))).toEqual(
      new Set([deviceId]),
    );
    expect((await engine.pullCycle()).pulled).toBe(0);
    disposeDb(db, file);
  });
});
