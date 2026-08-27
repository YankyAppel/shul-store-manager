import type { CloudEvent, ConnectionTestResult } from '@shul-store/shared';

/** Result of pushing one batch of events to the cloud. */
export interface PushAck {
  /** Event ids the server durably acknowledged. The outbox marks these pushed. */
  acknowledgedEventIds: string[];
}

/**
 * Network transport abstraction. The real implementation talks to a Supabase
 * PostgREST endpoint over HTTPS from the Electron main process; tests inject a
 * fake. All network activity is confined to implementations of this interface —
 * the sync engine itself performs no I/O.
 */
export interface SyncTransport {
  /**
   * Push a batch of events. Must be idempotent on `event_id` (the cloud treats
   * re-pushed event ids as no-ops). Resolves with the event ids the server
   * acknowledged; rejects on network/HTTP failure so the engine retries the
   * whole batch next cycle.
   */
  pushEvents(events: CloudEvent[]): Promise<PushAck>;

  /** Lightweight connectivity + table-existence check for the "Test connection"
   *  button. Never throws — returns a structured result. */
  testConnection(): Promise<ConnectionTestResult>;

  /** Fetch every event for the store at or after `afterSequence`, in ascending
   *  sequence order, for restore onto a fresh install. */
  listEvents(storeId: string, afterSequence: number): Promise<CloudEvent[]>;

  /** Fetch one server-arrival-ordered page for account-based two-way sync. */
  listEventsSince?(
    storeId: string,
    pullCursor: number,
    deviceId: string,
  ): Promise<CloudEvent[]>;
}
