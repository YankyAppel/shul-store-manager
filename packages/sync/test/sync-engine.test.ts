import { describe, expect, it } from 'vitest';
import {
  SyncEngine,
  computeBackoffDelay,
  DEFAULT_BATCH_SIZE,
} from '../src/index.js';
import {
  createDb,
  createDeferred,
  disposeDb,
  enableSync,
  FakeTransport,
} from './helpers.js';

describe('sync engine push cycle', () => {
  it('pushes events strictly in sequence order in bounded batches', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport, { batchSize: 2 });
    enableSync(db);

    // Five categories -> five ordered outbox events (seq 1..5).
    for (let i = 0; i < 5; i += 1) db.createCategory({ name: `Cat ${i}` });
    expect(db.pendingSyncEventCount()).toBe(5);

    const r1 = await engine.pushCycle();
    expect(r1.pushed).toBe(2);
    expect(r1.remaining).toBe(3);
    const r2 = await engine.pushCycle();
    expect(r2.pushed).toBe(2);
    expect(r2.remaining).toBe(1);
    const r3 = await engine.pushCycle();
    expect(r3.pushed).toBe(1);
    expect(r3.remaining).toBe(0);

    // No further work.
    const r4 = await engine.pushCycle();
    expect(r4.pushed).toBe(0);

    // All events were received in ascending sequence order.
    const all = db.exportOutboxSnapshot();
    const receivedSequences = transport.receivedEventIds.map(
      (id) => all.find((e) => e.eventId === id)!.sequence,
    );
    expect(receivedSequences).toEqual([1, 2, 3, 4, 5]);
    disposeDb(db, file);
  });

  it('marks nothing on a failed batch and resumes from the same sequence', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport, { batchSize: 10 });
    enableSync(db);

    for (let i = 0; i < 3; i += 1) db.createCategory({ name: `Cat ${i}` });
    transport.failOnCall = [1]; // first push fails

    const failed = await engine.pushCycle();
    expect(failed.error).not.toBeNull();
    expect(failed.pushed).toBe(0);
    expect(db.pendingSyncEventCount()).toBe(3); // nothing marked
    expect(db.getSyncConfigRecord().lastError).not.toBeNull();

    transport.failOnCall = [];
    const ok1 = await engine.pushCycle();
    expect(ok1.pushed).toBe(3);
    expect(db.pendingSyncEventCount()).toBe(0);
    expect(db.getSyncConfigRecord().lastError).toBeNull();
    expect(db.getSyncConfigRecord().lastSyncAt).not.toBeNull();
    disposeDb(db, file);
  });

  it('re-pushing already-acknowledged events does not duplicate', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport);
    enableSync(db);

    db.createCategory({ name: 'Once' });
    await engine.pushCycle();
    expect(transport.events.size).toBe(1);
    expect(db.pendingSyncEventCount()).toBe(0);

    // Simulate a crash between acknowledgement and marking: re-queue the event
    // by clearing pushed_at (the only mutable outbox column).
    const raw = db.connection as unknown as {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };
    raw.prepare('UPDATE sync_outbox SET pushed_at = NULL').run();

    const pushedAtBefore = (
      db.connection
        .prepare('SELECT pushed_at FROM sync_outbox WHERE sequence = 1')
        .get() as { pushed_at: string | null }
    ).pushed_at;
    expect(pushedAtBefore).toBeNull();

    await engine.pushCycle(); // re-pushes the same event id
    expect(transport.events.size).toBe(1); // cloud still has exactly one
    const pushedAtAfter = (
      db.connection
        .prepare('SELECT pushed_at FROM sync_outbox WHERE sequence = 1')
        .get() as { pushed_at: string | null }
    ).pushed_at;
    expect(pushedAtAfter).not.toBeNull(); // marked (not regressed)
    disposeDb(db, file);
  });

  it('no-ops when sync is disabled or unconfigured', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const engine = new SyncEngine(db, transport);
    // Not configured: no store id / credentials.
    db.createCategory({ name: 'X' });
    const result = await engine.pushCycle();
    expect(result.pushed).toBe(0);
    expect(transport.pushCallCount).toBe(0);
    disposeDb(db, file);
  });

  it('keeps queued events while entitlement pauses sync and resumes later', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    let allowed = false;
    const engine = new SyncEngine(db, transport, {
      canSync: () => allowed,
    });
    enableSync(db);
    db.createCategory({ name: 'Queued offline' });

    const paused = await engine.pushCycle();
    expect(paused.error).toContain('subscription');
    expect(paused.pushed).toBe(0);
    expect(db.pendingSyncEventCount()).toBe(1);
    expect(transport.pushCallCount).toBe(0);

    allowed = true;
    const resumed = await engine.pushCycle();
    expect(resumed.pushed).toBe(1);
    expect(db.pendingSyncEventCount()).toBe(0);
    disposeDb(db, file);
  });

  it('keeps legacy pasted sync credentials active before cloud onboarding', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    enableSync(db);
    db.createCategory({ name: 'Legacy configured' });
    const engine = new SyncEngine(db, transport, { canSync: () => true });

    const result = await engine.pushCycle();
    expect(result.pushed).toBe(1);
    expect(db.pendingSyncEventCount()).toBe(0);
    disposeDb(db, file);
  });

  it('respects single-flight: a concurrent syncNow is skipped', async () => {
    const { db, file } = createDb();
    const transport = new FakeTransport();
    const gate = createDeferred<void>();
    transport.pushGate = gate.promise;
    const engine = new SyncEngine(db, transport);
    enableSync(db);
    db.createCategory({ name: 'Concurrent' });

    const inFlight = engine.pushCycle(); // blocks on the gate
    const concurrent = await engine.syncNow(); // must not run concurrently
    expect(concurrent.skipped).toBe(true);

    gate.resolve();
    const result = await inFlight;
    expect(result.pushed).toBe(1);
    disposeDb(db, file);
  });
});

describe('backoff scheduling', () => {
  it('grows exponentially, caps at the interval, and applies jitter', () => {
    const base = 30_000;
    const max = 5 * 60 * 1000;
    expect(
      computeBackoffDelay(1, { baseMs: base, maxMs: max, random: () => 0 }),
    ).toBe(base);
    expect(
      computeBackoffDelay(2, { baseMs: base, maxMs: max, random: () => 0 }),
    ).toBe(base * 2);
    expect(
      computeBackoffDelay(3, { baseMs: base, maxMs: max, random: () => 0 }),
    ).toBe(base * 4);
    // Capped at maxMs plus up to one base of jitter.
    const capped = computeBackoffDelay(20, {
      baseMs: base,
      maxMs: max,
      random: () => 0.5,
    });
    expect(capped).toBe(max + Math.floor(0.5 * base));
    // Bounds with full jitter.
    const hi = computeBackoffDelay(1, {
      baseMs: base,
      maxMs: max,
      random: () => 0.999,
    });
    const lo = computeBackoffDelay(1, {
      baseMs: base,
      maxMs: max,
      random: () => 0,
    });
    expect(lo).toBe(base);
    expect(hi).toBeLessThan(base + base);
  });

  it('uses sensible engine defaults', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(200);
    const delay = computeBackoffDelay(1, { random: () => 0 });
    expect(delay).toBeGreaterThan(0);
  });
});
