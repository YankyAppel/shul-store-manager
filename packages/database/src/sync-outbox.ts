import { randomUUID } from 'node:crypto';
import type { SyncEntityType, SyncOperation } from '@shul-store/shared';
import type { SqliteDatabase } from './sqlite.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

/**
 * A durable change captured in the local append-only outbox. The local database
 * is the source of truth; these events are an eventually-consistent backup. The
 * `sequence` is the local ordering key and `eventId` is the cloud idempotency
 * key. `storeId` is intentionally absent here — this database belongs to a
 * single store, and the store id (assigned on first enable) is attached to each
 * event by the sync engine at push time.
 */
export interface OutboxEvent {
  sequence: number;
  eventId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
  createdAt: string;
  pushedAt: string | null;
}

export interface EnqueueInput {
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
}

/**
 * Append one event to the outbox. Must be called from within the same database
 * transaction as the business write it documents, so the event exists if and
 * only if the business write commits. The sequence is assigned by SQLite in
 * insertion order, preserving global commit order across transactions.
 */
export function enqueueOutboxEvent(
  connection: SqliteDatabase,
  input: EnqueueInput,
): number {
  const result = connection
    .prepare(
      `INSERT INTO sync_outbox (event_id, entity_type, entity_id, operation, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.entityType,
      input.entityId,
      input.operation,
      JSON.stringify(input.payload),
      now(),
    ) as { changes: number; lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

export function pendingOutboxCount(connection: SqliteDatabase): number {
  const row = connection
    .prepare(
      'SELECT COUNT(*) AS count FROM sync_outbox WHERE pushed_at IS NULL',
    )
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function maxOutboxSequence(connection: SqliteDatabase): number {
  const row = connection
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS max FROM sync_outbox')
    .get() as { max: number } | undefined;
  return row?.max ?? 0;
}

export function listPendingOutboxEvents(
  connection: SqliteDatabase,
  limit: number,
): OutboxEvent[] {
  const rows = connection
    .prepare(
      `SELECT * FROM sync_outbox WHERE pushed_at IS NULL ORDER BY sequence ASC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(mapOutboxRow);
}

export function listAllOutboxEvents(connection: SqliteDatabase): OutboxEvent[] {
  const rows = connection
    .prepare(`SELECT * FROM sync_outbox ORDER BY sequence ASC`)
    .all() as Row[];
  return rows.map(mapOutboxRow);
}

/**
 * Mark events as acknowledged by the cloud. Only sets `pushed_at` when it is
 * still NULL, so re-pushing an already-acknowledged event never regresses the
 * timestamp and the outbox row is otherwise immutable.
 */
export function markOutboxPushed(
  connection: SqliteDatabase,
  eventIds: string[],
): void {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => '?').join(', ');
  connection
    .prepare(
      `UPDATE sync_outbox SET pushed_at = ? WHERE event_id IN (${placeholders}) AND pushed_at IS NULL`,
    )
    .run(now(), ...eventIds);
}

function mapOutboxRow(row: Row): OutboxEvent {
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    operation: String(row.operation) as SyncOperation,
    payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at),
    pushedAt: row.pushed_at === null ? null : String(row.pushed_at),
  };
}
