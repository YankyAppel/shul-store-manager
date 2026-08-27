import type { StoreDatabase } from '@shul-store/database';
import type { OutboxEvent } from '@shul-store/database';
import type { CloudEvent } from '@shul-store/shared';
import type { PushAck, SyncTransport } from './transport.js';

export interface SyncEngineOptions {
  /** Maximum events pushed per cycle (default 200). */
  batchSize?: number;
  /** Normal interval between cycles in milliseconds (default 5 minutes). */
  intervalMs?: number;
  canSync?: () => boolean;
}

export interface PushCycleResult {
  /** Events acknowledged and marked pushed this cycle. */
  pushed: number;
  /** Events still awaiting push after this cycle. */
  remaining: number;
  /** Sanitised error message if the cycle failed, else null. */
  error: string | null;
  /** Consecutive failure count (for backoff). */
  consecutiveFailures: number;
  /** True if a run was already in progress (single-flight skip). */
  skipped: boolean;
}

export const DEFAULT_BATCH_SIZE = 200;
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Compute the delay before the next cycle after `consecutiveFailures` failures,
 * with exponential backoff capped at the normal interval and a random jitter to
 * avoid thundering-herd retries. Pure and deterministic given `random`.
 */
export function computeBackoffDelay(
  consecutiveFailures: number,
  options?: { baseMs?: number; maxMs?: number; random?: () => number },
): number {
  const baseMs = options?.baseMs ?? 30_000;
  const maxMs = options?.maxMs ?? 5 * 60 * 1000;
  const random = options?.random ?? Math.random;
  const exponent = Math.max(0, consecutiveFailures - 1);
  const raw = baseMs * 2 ** exponent;
  const capped = Math.min(maxMs, raw);
  const jitter = Math.floor(random() * baseMs);
  return capped + jitter;
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Sync failed for an unknown reason.';
}

/**
 * Background sync engine. Runs entirely in the Electron main process. A cycle
 * reads the oldest unpushed outbox events (in strict sequence order, bounded by
 * `batchSize`), pushes them, and marks them pushed only after the server
 * acknowledges. A failed batch marks nothing, so the next cycle resumes from the
 * same sequence — order is always preserved and re-pushing is idempotent.
 *
 * Single-flight: at most one cycle runs at a time. `syncNow` and the periodic
 * scheduler both route through `pushCycle`, which no-ops while busy. The engine
 * never blocks the renderer (separate process) and never throws out of a cycle.
 */
export class SyncEngine {
  private readonly db: StoreDatabase;
  private readonly transport: SyncTransport;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly canSync: () => boolean;
  private inFlight = false;
  private consecutiveFailures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    db: StoreDatabase,
    transport: SyncTransport,
    options?: SyncEngineOptions,
  ) {
    this.db = db;
    this.transport = transport;
    this.batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.canSync = options?.canSync ?? (() => true);
  }

  /** One push cycle. Safe to call directly (tests) or via the scheduler. */
  async pushCycle(): Promise<PushCycleResult> {
    if (this.inFlight) {
      return {
        pushed: 0,
        remaining: this.db.pendingSyncEventCount(),
        error: null,
        consecutiveFailures: this.consecutiveFailures,
        skipped: true,
      };
    }
    this.inFlight = true;
    try {
      const config = this.db.getSyncConfigRecord();
      if (!this.canSync()) {
        return {
          pushed: 0,
          remaining: this.db.pendingSyncEventCount(),
          error:
            'Cloud sync is paused until the Store Manager subscription is active.',
          consecutiveFailures: 0,
          skipped: false,
        };
      }
      if (
        !config.enabled ||
        !config.storeId ||
        !config.supabaseUrl ||
        !config.apiKeySecret
      ) {
        return {
          pushed: 0,
          remaining: this.db.pendingSyncEventCount(),
          error: null,
          consecutiveFailures: 0,
          skipped: false,
        };
      }
      const batch = this.db.pendingSyncEvents(this.batchSize);
      if (batch.length === 0) {
        this.consecutiveFailures = 0;
        return {
          pushed: 0,
          remaining: 0,
          error: null,
          consecutiveFailures: 0,
          skipped: false,
        };
      }
      const cloudEvents = batch.map((event) =>
        toCloudEvent(event, config.storeId!),
      );
      let ack: PushAck;
      try {
        ack = await this.transport.pushEvents(cloudEvents);
      } catch (error) {
        this.consecutiveFailures += 1;
        const message = sanitizeError(error);
        this.db.recordSyncResult(false, message);
        return {
          pushed: 0,
          remaining: this.db.pendingSyncEventCount(),
          error: message,
          consecutiveFailures: this.consecutiveFailures,
          skipped: false,
        };
      }
      // Mark pushed only after acknowledgement. Marking is idempotent
      // (pushed_at is set only when NULL), so a crash between ack and mark is
      // safe — the next cycle re-pushes and the cloud ignores duplicates.
      this.db.markSyncEventsPushed(ack.acknowledgedEventIds);
      this.consecutiveFailures = 0;
      this.db.recordSyncResult(true, null);
      return {
        pushed: ack.acknowledgedEventIds.length,
        remaining: this.db.pendingSyncEventCount(),
        error: null,
        consecutiveFailures: 0,
        skipped: false,
      };
    } finally {
      this.inFlight = false;
    }
  }

  /** Manual "Sync now". Respects single-flight (returns skipped if busy). */
  async syncNow(): Promise<PushCycleResult> {
    return this.pushCycle();
  }

  /** Start the background loop: an immediate cycle, then periodic cycles with
   *  backoff on failure. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runAndSchedule(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async runAndSchedule(delayMs: number): Promise<void> {
    this.timer = setTimeout(() => {
      void (async () => {
        const result = await this.pushCycle();
        if (!this.started) return;
        const nextDelay = result.error
          ? computeBackoffDelay(result.consecutiveFailures)
          : this.intervalMs;
        void this.runAndSchedule(nextDelay);
      })();
    }, delayMs);
  }
}

function toCloudEvent(event: OutboxEvent, storeId: string): CloudEvent {
  return {
    eventId: event.eventId,
    storeId,
    sequence: event.sequence,
    entityType: event.entityType,
    entityId: event.entityId,
    operation: event.operation,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}
