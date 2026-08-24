import { z } from 'zod';
import { storeSettingsSchema, type StoreSettings } from './checkout.js';
import { ledgerEntryTypeSchema } from './customers.js';

/**
 * Optional Supabase cloud backup & sync contracts.
 *
 * These types are shared between the database package (which builds the event
 * payloads and replays them) and the sync package (which transports and
 * validates them). Keeping them in `@shul-store/shared` avoids a circular
 * dependency between `@shul-store/database` and `@shul-store/sync`.
 *
 * Cloud payloads are treated as untrusted on restore and validated against the
 * schemas below before they are ever applied to a local database.
 */

export const syncOperationSchema = z.enum(['upsert', 'append']);
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncEntityTypeSchema = z.enum([
  'settings',
  'category',
  'product',
  'inventory_movement',
  'customer',
  'sale',
  'account_payment',
  'payment_transaction',
  'audit_event',
]);
export type SyncEntityType = z.infer<typeof syncEntityTypeSchema>;

const isoString = z.string().min(1);
const uuidString = z.string().uuid();
/** Integer cents constrained to the same safe range enforced by the database. */
const cents = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const nonNegativeCents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Mirrors `movementReasonSchema` (defined in the shared barrel) without a
 *  circular import. */
const movementReasonPayloadSchema = z.enum([
  'stock_received',
  'damaged',
  'customer_return',
  'manual_increase',
  'manual_decrease',
  'stock_count_correction',
  'sale',
]);

export const settingsPayloadSchema = storeSettingsSchema;
export type SettingsPayload = StoreSettings;

export const categoryPayloadSchema = z.object({
  id: uuidString,
  name: z.string().min(1).max(200),
  secondaryName: z.string().nullable(),
  imageId: uuidString.nullable(),
  active: z.boolean(),
  createdAt: isoString,
  updatedAt: isoString,
});
export type CategoryPayload = z.infer<typeof categoryPayloadSchema>;

export const productBarcodePayloadSchema = z.object({
  id: uuidString,
  value: z.string().min(1).max(100),
  kind: z.enum(['EXTERNAL', 'CODE128_INTERNAL']),
  position: z.number().int().min(0),
});
export type ProductBarcodePayload = z.infer<typeof productBarcodePayloadSchema>;

export const productPayloadSchema = z.object({
  id: uuidString,
  categoryId: uuidString,
  name: z.string().min(1).max(200),
  secondaryName: z.string().nullable(),
  imageId: uuidString.nullable(),
  purchaseCostCents: nonNegativeCents,
  sellingPriceCents: nonNegativeCents,
  taxable: z.boolean(),
  lowStockThreshold: z.number().int().min(0).max(1_000_000),
  active: z.boolean(),
  createdAt: isoString,
  updatedAt: isoString,
  barcodes: z.array(productBarcodePayloadSchema).max(50),
});
export type ProductPayload = z.infer<typeof productPayloadSchema>;

export const inventoryMovementPayloadSchema = z.object({
  id: uuidString,
  operationId: uuidString,
  productId: uuidString,
  quantityChange: z
    .number()
    .int()
    .refine((v) => v !== 0),
  reason: movementReasonPayloadSchema,
  occurredAt: isoString,
  deviceId: uuidString.nullable(),
  relatedSaleId: uuidString.nullable(),
  notes: z.string().min(1).max(1000),
  sequence: z.number().int().min(1),
});
export type InventoryMovementPayload = z.infer<
  typeof inventoryMovementPayloadSchema
>;

export const customerPayloadSchema = z.object({
  id: uuidString,
  accountNumber: z.string().min(1).max(50),
  accountBarcode: z.string().nullable(),
  name: z.string().min(1).max(200),
  secondaryName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  blocked: z.boolean(),
  creditLimitCents: nonNegativeCents.nullable(),
  createdAt: isoString,
  updatedAt: isoString,
});
export type CustomerPayload = z.infer<typeof customerPayloadSchema>;

export const saleItemPayloadSchema = z.object({
  id: uuidString,
  productId: uuidString,
  productName: z.string().min(1).max(200),
  secondaryName: z.string().nullable(),
  barcodeUsed: z.string().nullable(),
  quantity: z.number().int().min(1),
  unitSellingPriceCents: nonNegativeCents,
  unitPurchaseCostCents: nonNegativeCents,
  taxable: z.boolean(),
  taxCents: nonNegativeCents,
  lineSubtotalCents: nonNegativeCents,
  lineTotalCents: nonNegativeCents,
});
export type SaleItemPayload = z.infer<typeof saleItemPayloadSchema>;

/** Present only for cash / external_terminal sales (account sales carry no row). */
export const salePaymentPayloadSchema = z
  .object({
    method: z.enum(['cash', 'external_terminal']),
    amountCents: nonNegativeCents,
    cashReceivedCents: nonNegativeCents.nullable(),
    changeDueCents: cents.nullable(),
    terminalReference: z.string().nullable(),
    externalApproved: z.boolean().nullable(),
  })
  .nullable();
export type SalePaymentPayload = z.infer<typeof salePaymentPayloadSchema>;

export const ledgerEntryPayloadSchema = z.object({
  id: uuidString,
  operationId: uuidString,
  customerId: uuidString,
  amountCents: cents,
  entryType: ledgerEntryTypeSchema,
  occurredAt: isoString,
  relatedSaleId: uuidString.nullable(),
  relatedAccountPaymentId: uuidString.nullable(),
  deviceId: uuidString.nullable(),
  notes: z.string().min(1).max(1000),
  sequence: z.number().int().min(1),
});
export type LedgerEntryPayload = z.infer<typeof ledgerEntryPayloadSchema>;

export const salePayloadSchema = z.object({
  id: uuidString,
  receiptNumber: z.number().int().min(1),
  completionKey: uuidString,
  status: z.enum([
    'open',
    'awaiting_payment',
    'paid',
    'completed',
    'voided',
    'refunded',
  ]),
  subtotalCents: nonNegativeCents,
  taxCents: nonNegativeCents,
  totalCents: nonNegativeCents,
  createdAt: isoString,
  completedAt: isoString.nullable(),
  customerId: uuidString.nullable(),
  customerName: z.string().nullable(),
  customerAccountNumber: z.string().nullable(),
  customerBalanceBeforeCents: cents.nullable(),
  customerBalanceAfterCents: cents.nullable(),
  tenderType: z.enum([
    'cash',
    'external_terminal',
    'account',
    'immediate_payment',
  ]),
  items: z.array(saleItemPayloadSchema),
  payment: salePaymentPayloadSchema,
  inventoryMovements: z.array(inventoryMovementPayloadSchema),
  ledgerEntry: ledgerEntryPayloadSchema.nullable(),
});
export type SalePayload = z.infer<typeof salePayloadSchema>;

export const accountPaymentPayloadSchema = z.object({
  id: uuidString,
  operationId: uuidString,
  receiptNumber: z.number().int().min(1),
  customerId: uuidString,
  customerName: z.string().min(1).max(200),
  accountNumber: z.string().min(1).max(50),
  amountCents: z.number().int().min(1),
  method: z.enum(['cash', 'external_terminal']),
  cashReceivedCents: nonNegativeCents.nullable(),
  changeDueCents: cents.nullable(),
  terminalReference: z.string().nullable(),
  externalApproved: z.boolean().nullable(),
  previousBalanceCents: cents,
  newBalanceCents: cents,
  notes: z.string().nullable(),
  createdAt: isoString,
  ledgerEntry: ledgerEntryPayloadSchema,
});
export type AccountPaymentPayload = z.infer<typeof accountPaymentPayloadSchema>;

export const paymentTransactionPayloadSchema = z.object({
  id: uuidString,
  chargeReference: z.string().min(1),
  processorId: z.string().min(1),
  amountCents: z.number().int().positive(),
  status: z.enum([
    'initiated',
    'approved',
    'declined',
    'error',
    'unknown',
    'reconciled',
  ]),
  processorTransactionId: z.string().nullable(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  saleId: uuidString.nullable(),
  cartSnapshotJson: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: isoString,
  updatedAt: isoString,
});
export type PaymentTransactionPayload = z.infer<
  typeof paymentTransactionPayloadSchema
>;

export const auditEventPayloadSchema = z.object({
  id: uuidString,
  eventType: z.string().min(1).max(100),
  entityType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: isoString,
});
export type AuditEventPayload = z.infer<typeof auditEventPayloadSchema>;

/**
 * Discriminated union of every payload shape, keyed by entity type. Restore
 * validates each incoming cloud event against this before applying it.
 */
export const cloudPayloadSchema = z.discriminatedUnion('entityType', [
  z.object({
    entityType: z.literal('settings'),
    entityId: z.literal('settings'),
    payload: settingsPayloadSchema,
  }),
  z.object({
    entityType: z.literal('category'),
    entityId: uuidString,
    payload: categoryPayloadSchema,
  }),
  z.object({
    entityType: z.literal('product'),
    entityId: uuidString,
    payload: productPayloadSchema,
  }),
  z.object({
    entityType: z.literal('inventory_movement'),
    entityId: uuidString,
    payload: inventoryMovementPayloadSchema,
  }),
  z.object({
    entityType: z.literal('customer'),
    entityId: uuidString,
    payload: customerPayloadSchema,
  }),
  z.object({
    entityType: z.literal('sale'),
    entityId: uuidString,
    payload: salePayloadSchema,
  }),
  z.object({
    entityType: z.literal('account_payment'),
    entityId: uuidString,
    payload: accountPaymentPayloadSchema,
  }),
  z.object({
    entityType: z.literal('payment_transaction'),
    entityId: uuidString,
    payload: paymentTransactionPayloadSchema,
  }),
  z.object({
    entityType: z.literal('audit_event'),
    entityId: uuidString,
    payload: auditEventPayloadSchema,
  }),
]);
export type CloudPayload = z.infer<typeof cloudPayloadSchema>;

export const syncOperationFor = (entityType: SyncEntityType): SyncOperation => {
  switch (entityType) {
    case 'category':
    case 'product':
    case 'customer':
    case 'settings':
      return 'upsert';
    default:
      return 'append';
  }
};

// ---------------------------------------------------------------------------
// IPC contracts (renderer <-> main). The API key is never sent to the renderer.
// ---------------------------------------------------------------------------

export const syncConfigInputSchema = z.object({
  enabled: z.boolean(),
  supabaseUrl: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => v.startsWith('https://'), 'Supabase URL must use https://'),
  apiKey: z.string().min(1).max(500),
});
export type SyncConfigInput = z.infer<typeof syncConfigInputSchema>;

/** Sanitised view returned to the renderer: configured flag + masked hint only. */
export interface SyncConfigView {
  enabled: boolean;
  configured: boolean;
  supabaseUrl: string | null;
  storeId: string | null;
  apiKeyHint: string | null;
  apiKeyEncryptionAvailable: boolean;
  backfillCompleted: boolean;
}

export interface SyncStatus {
  enabled: boolean;
  configured: boolean;
  lastSyncAt: string | null;
  pendingEventCount: number;
  lastError: string | null;
  backfillCompleted: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  reachable: boolean;
}

export interface RestoreSummary {
  ok: boolean;
  message: string;
  eventsReplayed: number;
  settings: number;
  categories: number;
  products: number;
  customers: number;
  sales: number;
  accountPayments: number;
  inventoryMovements: number;
  ledgerEntries: number;
  auditEvents: number;
  integrityChecks: string[];
}

export interface RestoreResult {
  ok: boolean;
  message: string;
  summary: RestoreSummary | null;
}

export interface SyncNowResult {
  pushed: number;
  remaining: number;
  error: string | null;
  skipped: boolean;
}

export const restoreInputSchema = z.object({
  supabaseUrl: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => v.startsWith('https://'), 'Supabase URL must use https://'),
  apiKey: z.string().min(1).max(500),
  storeId: z.string().uuid(),
});
export type RestoreInput = z.infer<typeof restoreInputSchema>;

/** Wire format of an event as stored in / fetched from the cloud. */
export interface CloudEvent {
  eventId: string;
  storeId: string;
  sequence: number;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
  createdAt: string;
}
