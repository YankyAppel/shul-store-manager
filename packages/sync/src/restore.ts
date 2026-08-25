import type { StoreDatabase } from '@shul-store/database';
import type { ValidatedRestoreEvent } from '@shul-store/database';
import {
  accountPaymentPayloadSchema,
  auditEventPayloadSchema,
  categoryPayloadSchema,
  customerPayloadSchema,
  inventoryMovementPayloadSchema,
  kioskPayloadSchema,
  paymentTransactionPayloadSchema,
  productPayloadSchema,
  salePayloadSchema,
  settingsPayloadSchema,
  syncEntityTypeSchema,
} from '@shul-store/shared';
import type {
  CloudEvent,
  RestoreResult,
  RestoreSummary,
  SyncEntityType,
} from '@shul-store/shared';
import type { SyncTransport } from './transport.js';

type PayloadSchema =
  | typeof settingsPayloadSchema
  | typeof categoryPayloadSchema
  | typeof productPayloadSchema
  | typeof inventoryMovementPayloadSchema
  | typeof paymentTransactionPayloadSchema
  | typeof kioskPayloadSchema
  | typeof customerPayloadSchema
  | typeof salePayloadSchema
  | typeof accountPaymentPayloadSchema
  | typeof auditEventPayloadSchema;

export const PAYLOAD_SCHEMA_BY_TYPE: Record<SyncEntityType, PayloadSchema> = {
  settings: settingsPayloadSchema,
  category: categoryPayloadSchema,
  product: productPayloadSchema,
  inventory_movement: inventoryMovementPayloadSchema,
  customer: customerPayloadSchema,
  sale: salePayloadSchema,
  account_payment: accountPaymentPayloadSchema,
  payment_transaction: paymentTransactionPayloadSchema,
  kiosk: kioskPayloadSchema,
  audit_event: auditEventPayloadSchema,
};

const ENTITY_TYPE_SCHEMA = syncEntityTypeSchema;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): RestoreResult {
  return { ok: false, message, summary: null };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Parse and Zod-validate every field of an untrusted cloud event before it is
 * allowed near the database. Throws a descriptive error on the first malformed
 * event so the whole restore aborts cleanly (no partial application).
 */
export function parseRestoreEvent(event: CloudEvent): ValidatedRestoreEvent {
  if (typeof event.eventId !== 'string' || !UUID_RE.test(event.eventId)) {
    throw new Error('Cloud event has an invalid event id.');
  }
  const sequence = Number(event.sequence);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Cloud event ${event.eventId} has an invalid sequence.`);
  }
  const entityType = ENTITY_TYPE_SCHEMA.safeParse(event.entityType);
  if (!entityType.success) {
    throw new Error(`Cloud event ${event.eventId} has an invalid entity type.`);
  }
  if (typeof event.entityId !== 'string' || event.entityId.length === 0) {
    throw new Error(`Cloud event ${event.eventId} has an invalid entity id.`);
  }
  if (event.operation !== 'upsert' && event.operation !== 'append') {
    throw new Error(`Cloud event ${event.eventId} has an invalid operation.`);
  }
  if (typeof event.createdAt !== 'string' || event.createdAt.length === 0) {
    throw new Error(`Cloud event ${event.eventId} has an invalid timestamp.`);
  }
  const schema = PAYLOAD_SCHEMA_BY_TYPE[entityType.data];
  if (!schema) {
    throw new Error(
      `Cloud event ${event.eventId} has an unknown entity type "${entityType.data}".`,
    );
  }
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = first
      ? `${first.path.join('.') || 'payload'}: ${first.message}`
      : 'payload failed validation';
    throw new Error(
      `Cloud event ${event.eventId} (${entityType.data}) rejected: ${detail}`,
    );
  }
  return {
    sequence,
    eventId: event.eventId,
    entityType: entityType.data,
    entityId: event.entityId,
    operation: event.operation,
    payload: parsed.data,
    createdAt: event.createdAt,
  };
}

export function parseRestoreEvents(
  events: CloudEvent[],
): ValidatedRestoreEvent[] {
  return events.map(parseRestoreEvent);
}

function toSummary(
  eventsReplayed: number,
  outcome: {
    counts: {
      settings: number;
      categories: number;
      products: number;
      customers: number;
      sales: number;
      kiosks: number;
      accountPayments: number;
      inventoryMovements: number;
      ledgerEntries: number;
      auditEvents: number;
    };
    integrityChecks: string[];
  },
): RestoreSummary {
  return {
    ok: true,
    message: 'Restore completed successfully.',
    eventsReplayed,
    settings: outcome.counts.settings,
    categories: outcome.counts.categories,
    products: outcome.counts.products,
    customers: outcome.counts.customers,
    sales: outcome.counts.sales,
    kiosks: outcome.counts.kiosks,
    accountPayments: outcome.counts.accountPayments,
    inventoryMovements: outcome.counts.inventoryMovements,
    ledgerEntries: outcome.counts.ledgerEntries,
    auditEvents: outcome.counts.auditEvents,
    integrityChecks: outcome.integrityChecks,
  };
}

/**
 * Restore a fresh install from the cloud. Validates connectivity, downloads all
 * events for the store in sequence order, Zod-validates every payload, replays
 * them transactionally, and verifies financial integrity. Refuses if the local
 * database already contains business data (no merging in this milestone).
 */
export async function restoreFromCloud(
  db: StoreDatabase,
  transport: SyncTransport,
  storeId: string,
): Promise<RestoreResult> {
  if (!db.isRestoreAllowed()) {
    return fail(
      'Restore from cloud is only available on a fresh installation with no local business data. This database already contains data.',
    );
  }

  let events: CloudEvent[];
  try {
    events = await transport.listEvents(storeId, 0);
  } catch (error) {
    return fail(`Could not download cloud events: ${errorMessage(error)}`);
  }

  if (events.length === 0) {
    return fail('No cloud events were found for this store id.');
  }

  events.sort((a, b) => a.sequence - b.sequence);

  let validated: ValidatedRestoreEvent[];
  try {
    validated = parseRestoreEvents(events);
  } catch (error) {
    return fail(`Cloud data validation failed: ${errorMessage(error)}`);
  }

  try {
    const outcome = db.replayValidatedEvents(validated);
    return {
      ok: true,
      message: 'Restore completed successfully.',
      summary: toSummary(validated.length, outcome),
    };
  } catch (error) {
    return fail(`Restore failed and was rolled back: ${errorMessage(error)}`);
  }
}
