import { createHash } from 'node:crypto';
import { processors } from '@shul-store/payments';
import {
  calculateCart,
  cartSnapshotSchema,
  errorMessage,
  PlaintextSecretStore,
  type CartSnapshot,
  type CartSnapshotLine,
  recordRefundInputSchema,
  type RecordRefundInput,
  type SecretStore,
  type Sale,
  type StoreSettings,
} from '@shul-store/shared';
import type { StoreDatabase } from './store-database.js';
import { validateRefundRequest } from './refunds.js';

/**
 * The single Manager/Kiosk payment service.
 *
 * Both the desktop manager (IPC) and the LAN kiosk (HTTP) drive every integrated card
 * payment through this class, so validation, snapshot freezing, reservation, authorization,
 * finalization and reconciliation cannot drift apart between the two surfaces again.
 *
 * Lifecycle for one charge reference:
 *
 *   validate  -> deterministic, writes nothing, always fails or succeeds identically
 *   persist   -> journal row + frozen snapshot digest + reservation set, one transaction
 *   authorize -> processor call, outcome recorded (pending is stored as `unknown`)
 *   finalize  -> snapshot-only sale creation, exact-once, never re-reads live prices
 *   reconcile -> per-transaction truth from the processor, then finalize when approved
 *
 * Anything that is approved by the processor but cannot be finalized lands in
 * `needs-attention` with a machine readable reason and keeps its reservations held.
 */

export type PaymentChannel = 'manager' | 'kiosk';

export const paymentFailureCodes = [
  'invalid-request',
  'card-processing-disabled',
  'processor-not-found',
  'processor-config-invalid',
  'kiosk-unknown',
  'product-not-found',
  'product-inactive',
  'barcode-mismatch',
  'insufficient-stock',
  'zero-amount',
  'in-progress',
  'charge-reference-conflict',
  'idempotency-conflict',
  'charge-not-found',
] as const;
export type PaymentFailureCode = (typeof paymentFailureCodes)[number];

export const attentionReasons = [
  'invalid-snapshot',
  'snapshot-hash-mismatch',
  'amount-mismatch',
  'processor-changed',
  'processor-config-changed',
  'frozen-config-unavailable',
  'finalization-failed',
  'reconciliation-failed',
] as const;
export type AttentionReason = (typeof attentionReasons)[number];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PaymentError extends Error {
  constructor(
    readonly code: PaymentFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export interface PaymentLineRequest {
  productId: string;
  quantity: number;
  barcodeUsed?: string | null;
}

export interface PaymentRequest {
  chargeReference: string;
  idempotencyKey: string;
  lines: PaymentLineRequest[];
}

export interface PaymentActor {
  channel: PaymentChannel;
  kioskId?: string | null;
}

export interface ProcessorIdentity {
  processorId: string;
  config: unknown;
  configHash: string;
}

export interface PaymentValidation {
  request: PaymentRequest;
  snapshot: CartSnapshot;
  snapshotJson: string;
  snapshotHash: string;
  reservations: { productId: string; quantity: number }[];
  processor: ProcessorIdentity;
  totalCents: number;
}

export type PaymentStatus =
  | 'initiated'
  | 'approved'
  | 'declined'
  | 'error'
  | 'unknown'
  | 'reconciled'
  | 'needs-attention';

export interface ChargeOutcome {
  /** `replayed` means no new authorization was attempted for this call. */
  kind: 'charged' | 'replayed';
  chargeReference: string;
  status: PaymentStatus;
  totalCents: number;
  processorTransactionId?: string;
  cardBrand?: string;
  cardLast4?: string;
  declineReason?: string;
  errorMessage?: string;
  sale?: Sale;
  attentionReason?: AttentionReason;
  receiptNumber?: number;
}

export interface NeedsAttentionEntry {
  chargeReference: string;
  status: PaymentStatus;
  totalCents: number;
  attentionReason: string | null;
  processorId: string;
  originChannel: PaymentChannel;
  kioskId: string | null;
  kioskName: string | null;
  createdAt: string;
  updatedAt: string;
  reservations: { productId: string; quantity: number }[];
}

/** Recursively sorts object keys so two equal snapshots always serialize identically. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort())
        sorted[key] = normalize(record[key]);
      return sorted;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface TransactionRow {
  id: string;
  charge_reference: string;
  processor_id: string;
  amount_cents: number;
  status: string;
  processor_transaction_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  sale_id: string | null;
  cart_snapshot_json: string | null;
  idempotency_key: string | null;
  kiosk_id: string | null;
  snapshot_hash: string | null;
  processor_config_hash: string | null;
  processor_config_secret: string | null;
  origin_channel: string;
  attention_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface RefundTransactionRow {
  processor_id: string;
  processor_config_secret: string | null;
  processor_config_hash: string | null;
}

function parseRefundTransaction(value: unknown): RefundTransactionRow | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.processor_id !== 'string') return null;
  if (
    row.processor_config_secret !== null &&
    typeof row.processor_config_secret !== 'string'
  )
    return null;
  if (
    row.processor_config_hash !== null &&
    typeof row.processor_config_hash !== 'string'
  )
    return null;
  return {
    processor_id: row.processor_id,
    processor_config_secret: row.processor_config_secret,
    processor_config_hash: row.processor_config_hash,
  };
}

export class PaymentService {
  constructor(
    private readonly db: StoreDatabase,
    private readonly secretStore: SecretStore = new PlaintextSecretStore(),
  ) {}

  // ---------------------------------------------------------------- validation

  /**
   * Deterministic validation. Runs every check in a fixed order and returns the frozen
   * snapshot without writing anything: no journal row, no reservation, no processor call.
   */
  validate(request: PaymentRequest, actor: PaymentActor): PaymentValidation {
    const parsed = this.parseRequest(request);
    const settings = this.db.getSettings();
    const processor = this.resolveProcessor(settings);

    if (actor.channel === 'kiosk') {
      if (!actor.kioskId)
        throw new PaymentError('kiosk-unknown', 'Kiosk identity is required');
      if (!this.db.getActiveKiosk(actor.kioskId))
        throw new PaymentError('kiosk-unknown', 'Kiosk is not paired');
    }

    // Lines are merged into a canonical, ordered reservation set so the same cart always
    // produces the same snapshot digest and the same reservation rows.
    const merged = new Map<
      string,
      { productId: string; quantity: number; barcodeUsed: string | null }
    >();
    for (const line of parsed.lines) {
      const barcodeUsed = line.barcodeUsed?.trim() || null;
      const key = `${line.productId}::${barcodeUsed ?? ''}`;
      const existing = merged.get(key);
      if (existing) existing.quantity += line.quantity;
      else merged.set(key, { ...line, barcodeUsed });
    }
    const canonicalLines = [...merged.values()];

    const demand = new Map<string, number>();
    const products = canonicalLines.map((line) => {
      const product = this.findProduct(line.productId);
      if (!product.active)
        throw new PaymentError(
          'product-inactive',
          `${product.name} is inactive and cannot be sold.`,
        );
      if (
        line.barcodeUsed &&
        !product.barcodes.some(
          (barcode) =>
            barcode.value.toLowerCase() === line.barcodeUsed?.toLowerCase(),
        )
      )
        throw new PaymentError(
          'barcode-mismatch',
          'Barcode does not belong to the selected product.',
        );
      demand.set(product.id, (demand.get(product.id) ?? 0) + line.quantity);
      return { product, quantity: line.quantity };
    });

    const calculated = calculateCart(products, settings);
    if (calculated.totalCents <= 0)
      throw new PaymentError('zero-amount', 'Cannot process $0.00 charge');

    const reservations = [...demand.entries()]
      .map(([productId, quantity]) => ({ productId, quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    for (const reservation of reservations) {
      const product = this.findProduct(reservation.productId);
      const available =
        product.stockQuantity -
        this.db.heldQuantityFor(reservation.productId, null);
      if (reservation.quantity > available)
        throw new PaymentError(
          'insufficient-stock',
          `Insufficient stock for ${product.name}. Available: ${available}.`,
        );
    }

    const lines: CartSnapshotLine[] = canonicalLines.map((line, index) => {
      const product = products[index]!.product;
      const calculatedLine = calculated.lines[index]!;
      return {
        productId: line.productId,
        quantity: line.quantity,
        barcodeUsed: line.barcodeUsed,
        productName: product.name,
        secondaryName: product.secondaryName,
        unitSellingPriceCents: product.sellingPriceCents,
        unitPurchaseCostCents: product.purchaseCostCents,
        taxable: product.taxable,
        unitPriceCents: calculatedLine.unitPriceCents,
        subtotalCents: calculatedLine.subtotalCents,
        taxCents: calculatedLine.taxCents,
        totalCents: calculatedLine.totalCents,
      };
    });
    const snapshot = cartSnapshotSchema.parse({
      lines,
      totals: {
        subtotalCents: calculated.subtotalCents,
        taxCents: calculated.taxCents,
        totalCents: calculated.totalCents,
      },
    });
    const snapshotJson = canonicalJson(snapshot);

    return {
      request: parsed,
      snapshot,
      snapshotJson,
      snapshotHash: sha256(snapshotJson),
      reservations,
      processor,
      totalCents: calculated.totalCents,
    };
  }

  private parseRequest(request: PaymentRequest): PaymentRequest {
    if (
      !request ||
      typeof request.chargeReference !== 'string' ||
      !uuidPattern.test(request.chargeReference) ||
      typeof request.idempotencyKey !== 'string' ||
      !uuidPattern.test(request.idempotencyKey) ||
      !Array.isArray(request.lines) ||
      request.lines.length < 1 ||
      request.lines.length > 500
    )
      throw new PaymentError('invalid-request', 'Invalid payment request');
    const lines = request.lines.map((line) => {
      if (
        typeof line.productId !== 'string' ||
        !uuidPattern.test(line.productId) ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 10000 ||
        (line.barcodeUsed !== undefined &&
          line.barcodeUsed !== null &&
          typeof line.barcodeUsed !== 'string')
      )
        throw new PaymentError('invalid-request', 'Invalid payment line');
      return {
        productId: line.productId,
        quantity: line.quantity,
        barcodeUsed: line.barcodeUsed ?? null,
      };
    });
    return {
      chargeReference: request.chargeReference,
      idempotencyKey: request.idempotencyKey,
      lines,
    };
  }

  /** `StoreDatabase.getProduct` throws for unknown ids; normalize that into a code. */
  private findProduct(productId: string) {
    try {
      return this.db.getProduct(productId);
    } catch {
      throw new PaymentError('product-not-found', 'Product not found');
    }
  }

  private resolveProcessor(settings: StoreSettings): ProcessorIdentity {
    if (!settings.cardProcessingEnabled || !settings.cardProcessorId)
      throw new PaymentError(
        'card-processing-disabled',
        'Card processing is not enabled',
      );
    const processor = processors.find((p) => p.id === settings.cardProcessorId);
    if (!processor)
      throw new PaymentError('processor-not-found', 'Processor not found');
    let config: unknown;
    try {
      config = settings.cardProcessorConfigJson
        ? processor.configSchema.parse(
            JSON.parse(settings.cardProcessorConfigJson),
          )
        : processor.configSchema.parse({});
    } catch {
      throw new PaymentError(
        'processor-config-invalid',
        'Invalid processor configuration',
      );
    }
    return {
      processorId: processor.id,
      config,
      configHash: sha256(canonicalJson(config ?? {})),
    };
  }

  // -------------------------------------------------------------- idempotency

  /**
   * Replay/conflict resolution, checked before any new work happens so a retried request
   * can never produce a second authorization or a second reservation set.
   */
  replay(request: PaymentRequest, actor: PaymentActor): ChargeOutcome | null {
    const parsed = this.parseRequest(request);
    const existing = this.db.getPaymentTransaction(parsed.chargeReference) as
      TransactionRow | undefined;
    if (existing) {
      const boundKiosk = existing.kiosk_id ? String(existing.kiosk_id) : null;
      const requestedKiosk =
        actor.channel === 'kiosk' ? (actor.kioskId ?? null) : null;
      if (
        String(existing.idempotency_key ?? '') !== parsed.idempotencyKey ||
        boundKiosk !== requestedKiosk
      )
        throw new PaymentError(
          'charge-reference-conflict',
          'Charge reference is already bound to another request',
        );
      return this.describe(existing, 'replayed');
    }
    const keyed = this.db.getPaymentTransactionByIdempotencyKey(
      parsed.idempotencyKey,
    ) as TransactionRow | undefined;
    if (keyed) {
      if (['initiated', 'unknown'].includes(String(keyed.status)))
        throw new PaymentError(
          'in-progress',
          'A payment is already in progress for this cart. Please check its status.',
        );
      throw new PaymentError(
        'idempotency-conflict',
        'Idempotency key is already bound to another charge',
      );
    }
    return null;
  }

  // ------------------------------------------------------------------- charge

  /** Full lifecycle: validate, persist, authorize, finalize. */
  async charge(
    request: PaymentRequest,
    actor: PaymentActor,
  ): Promise<ChargeOutcome> {
    const parsed = this.parseRequest(request);
    const replayed = this.replay(parsed, actor);
    if (replayed) return replayed;

    const validation = this.validate(parsed, actor);
    try {
      this.db.createPaymentTransaction(
        parsed.chargeReference,
        validation.processor.processorId,
        validation.totalCents,
        validation.snapshotJson,
        parsed.idempotencyKey,
        actor.channel === 'kiosk' ? (actor.kioskId ?? null) : null,
        validation.reservations,
        {
          snapshotHash: validation.snapshotHash,
          processorConfigHash: validation.processor.configHash,
          processorConfigSecret: this.secretStore.encrypt(
            canonicalJson(validation.processor.config ?? {}),
          ),
          originChannel: actor.channel,
        },
      );
    } catch (error) {
      // Lost the race for this charge reference or idempotency key: report the winner
      // instead of authorizing a second time.
      if (this.db.getPaymentTransaction(parsed.chargeReference)) {
        const winner = this.replay(parsed, actor);
        if (winner) return winner;
      }
      throw new PaymentError('in-progress', errorMessage(error));
    }

    const processor = processors.find(
      (p) => p.id === validation.processor.processorId,
    )!;
    let result;
    try {
      result = await processor.createCharge(
        {
          chargeReference: parsed.chargeReference,
          amountCents: validation.totalCents,
        },
        validation.processor.config,
        this.db.getProcessorStorage(),
      );
    } catch (error) {
      this.db.updatePaymentTransactionStatus(parsed.chargeReference, 'unknown');
      const outcome = this.describe(
        this.require(parsed.chargeReference),
        'charged',
      );
      return { ...outcome, errorMessage: errorMessage(error) };
    }

    this.db.updatePaymentTransactionStatus(
      parsed.chargeReference,
      result.status === 'pending' ? 'unknown' : result.status,
      result.processorTransactionId,
      result.cardBrand,
      result.cardLast4,
    );

    if (result.status !== 'approved') {
      const declined = this.describe(
        this.require(parsed.chargeReference),
        'charged',
      );
      return {
        ...declined,
        ...(result.declineReason
          ? { declineReason: result.declineReason }
          : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      };
    }

    const sale = this.finalize(parsed.chargeReference);
    const outcome = this.describe(
      this.require(parsed.chargeReference),
      'charged',
    );
    return {
      ...outcome,
      ...(result.processorTransactionId
        ? { processorTransactionId: result.processorTransactionId }
        : {}),
      ...(result.cardBrand ? { cardBrand: result.cardBrand } : {}),
      ...(result.cardLast4 ? { cardLast4: result.cardLast4 } : {}),
      ...(sale ? { sale, receiptNumber: sale.receiptNumber } : {}),
    };
  }

  // --------------------------------------------------------------- finalization

  /**
   * Snapshot-only, exact-once finalization. The sale is built exclusively from the frozen
   * snapshot captured at validation time; live catalog prices are never consulted.
   * Returns the sale (existing or newly created) or null when the charge could not be
   * finalized, in which case the transaction is moved to `needs-attention`.
   */
  finalize(chargeReference: string): Sale | null {
    const tx = this.db.getPaymentTransaction(chargeReference) as
      TransactionRow | undefined;
    if (!tx) return null;

    // Exact-once: an already linked sale is the answer, no matter how often this runs.
    if (tx.sale_id) return this.db.getSale(String(tx.sale_id));
    if (!['approved', 'needs-attention'].includes(String(tx.status)))
      return null;

    if (!tx.idempotency_key || !tx.cart_snapshot_json)
      return this.attention(tx, 'invalid-snapshot', 'Missing snapshot');

    const parsed = cartSnapshotSchema.safeParse(
      safeJsonParse(tx.cart_snapshot_json),
    );
    if (!parsed.success)
      return this.attention(
        tx,
        'invalid-snapshot',
        'Cart snapshot failed validation',
      );
    const snapshot = parsed.data;

    if (
      tx.snapshot_hash &&
      sha256(canonicalJson(snapshot)) !== tx.snapshot_hash
    )
      return this.attention(
        tx,
        'snapshot-hash-mismatch',
        'Cart snapshot does not match its frozen digest',
      );
    if (Number(tx.amount_cents) !== snapshot.totals.totalCents)
      return this.attention(
        tx,
        'amount-mismatch',
        `Authorized amount ${tx.amount_cents} does not match snapshot total ${snapshot.totals.totalCents}`,
      );

    // Promote an operator retry back to approved before the sale is linked, so the
    // `sale_id` trigger only ever sees an approved transaction.
    if (String(tx.status) === 'needs-attention')
      this.db.updatePaymentTransactionStatus(chargeReference, 'approved');

    try {
      const sale = this.db.completeSale(
        {
          completionKey: String(tx.idempotency_key),
          lines: snapshot.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            barcodeUsed: line.barcodeUsed,
          })),
          payment: {
            method: 'integrated_card',
            chargeReference,
          },
        },
        snapshot,
        tx.kiosk_id ? String(tx.kiosk_id) : null,
      );
      this.db.markPaymentFinalized(chargeReference);
      return sale;
    } catch (error) {
      return this.attention(tx, 'finalization-failed', errorMessage(error));
    }
  }

  private attention(
    tx: TransactionRow,
    reason: AttentionReason,
    detail: string,
    setStatus = true,
  ): null {
    this.db.markPaymentNeedsAttention(
      String(tx.charge_reference),
      `${reason}: ${detail}`.slice(0, 500),
      setStatus,
    );
    return null;
  }

  /** Marks a charge as needing attention and reports the resulting state. */
  private block(
    tx: TransactionRow,
    reason: AttentionReason,
    detail: string,
  ): ChargeOutcome {
    this.attention(tx, reason, detail);
    return this.describe(this.require(String(tx.charge_reference)), 'replayed');
  }

  // ----------------------------------------------------------- reconciliation

  /**
   * Per-transaction reconciliation: asks the processor for the truth about exactly one
   * charge reference, records it, and finalizes it when it turns out to be approved.
   */
  async reconcile(chargeReference: string): Promise<ChargeOutcome | null> {
    const tx = this.db.getPaymentTransaction(chargeReference) as
      TransactionRow | undefined;
    if (!tx) return null;
    if (tx.sale_id) return this.describe(tx, 'replayed');
    if (['declined', 'error'].includes(String(tx.status)))
      return this.describe(tx, 'replayed');

    const settings = this.db.getSettings();
    if (String(tx.processor_id) !== settings.cardProcessorId)
      return this.block(
        tx,
        'processor-changed',
        `Charge was authorized with ${tx.processor_id} but the store is configured for ${settings.cardProcessorId ?? 'no processor'}`,
      );

    const processor = processors.find((p) => p.id === tx.processor_id);
    if (!processor)
      return this.block(
        tx,
        'processor-changed',
        `Processor ${tx.processor_id} is no longer available`,
      );

    let config: unknown;
    if (tx.processor_config_secret !== null) {
      try {
        config = processor.configSchema.parse(
          JSON.parse(this.secretStore.decrypt(tx.processor_config_secret)),
        );
      } catch {
        try {
          const currentConfig = settings.cardProcessorConfigJson
            ? processor.configSchema.parse(
                JSON.parse(settings.cardProcessorConfigJson),
              )
            : processor.configSchema.parse({});
          const currentConfigHash = sha256(canonicalJson(currentConfig ?? {}));
          if (
            !tx.processor_config_hash ||
            tx.processor_config_hash !== currentConfigHash
          )
            return this.block(
              tx,
              'frozen-config-unavailable',
              'Frozen processor configuration could not be recovered',
            );
          config = currentConfig;
        } catch {
          return this.block(
            tx,
            'frozen-config-unavailable',
            'Frozen processor configuration could not be recovered',
          );
        }
      }
    } else {
      let configHash: string;
      try {
        config = settings.cardProcessorConfigJson
          ? processor.configSchema.parse(
              JSON.parse(settings.cardProcessorConfigJson),
            )
          : processor.configSchema.parse({});
        configHash = sha256(canonicalJson(config ?? {}));
      } catch {
        return this.block(
          tx,
          'processor-config-changed',
          'Current processor configuration is invalid',
        );
      }
      if (
        tx.processor_config_hash &&
        tx.processor_config_hash !== configHash &&
        String(tx.status) !== 'needs-attention'
      )
        return this.block(
          tx,
          'processor-config-changed',
          'Processor configuration changed after authorization',
        );
    }

    let result;
    try {
      result = await processor.getChargeStatus(
        chargeReference,
        config,
        this.db.getProcessorStorage(),
      );
    } catch (error) {
      return this.block(tx, 'reconciliation-failed', errorMessage(error));
    }

    const next: 'approved' | 'declined' | 'error' | 'unknown' =
      result.status === 'pending'
        ? 'unknown'
        : (result.status as 'approved' | 'declined' | 'error');
    this.db.updatePaymentTransactionStatus(
      chargeReference,
      next,
      result.processorTransactionId,
      result.cardBrand,
      result.cardLast4,
    );

    if (next === 'approved') {
      const sale = this.finalize(chargeReference);
      const outcome = this.describe(this.require(chargeReference), 'replayed');
      return sale
        ? { ...outcome, sale, receiptNumber: sale.receiptNumber }
        : outcome;
    }
    return this.describe(this.require(chargeReference), 'replayed');
  }

  async refund(
    input: RecordRefundInput,
  ): Promise<import('@shul-store/shared').Refund> {
    const value = recordRefundInputSchema.parse(input);
    const replay = this.db.getRefundByOperationId(value.operationId);
    if (replay) return replay;
    const context = this.db.refundableSale(value.saleId);
    if (value.manualExternalTerminal || context.method !== 'integrated_card') {
      return this.db.recordRefund(value);
    }
    const validation = validateRefundRequest(context, value, null, false);
    const tx = parseRefundTransaction(
      this.db.getPaymentTransaction(context.chargeReference ?? ''),
    );
    if (!tx)
      throw new Error(
        'Integrated card charge not found. Refund on the physical terminal and record an external-terminal refund.',
      );
    const settings = this.db.getSettings();
    if (String(tx.processor_id) !== settings.cardProcessorId)
      throw new Error(
        `frozen-config-unavailable: charge used ${tx.processor_id}, but the store is configured for ${settings.cardProcessorId ?? 'no processor'}. Refund on the physical terminal and record an external-terminal refund.`,
      );
    const processor = processors.find(
      (candidate) => candidate.id === tx.processor_id,
    );
    if (!processor)
      throw new Error(
        'frozen-config-unavailable: the original card processor is unavailable. Refund on the physical terminal and record an external-terminal refund.',
      );
    let config: unknown;
    try {
      if (tx.processor_config_secret !== null) {
        try {
          config = processor.configSchema.parse(
            JSON.parse(this.secretStore.decrypt(tx.processor_config_secret)),
          );
        } catch {
          const current = settings.cardProcessorConfigJson
            ? processor.configSchema.parse(
                JSON.parse(settings.cardProcessorConfigJson),
              )
            : processor.configSchema.parse({});
          if (
            !tx.processor_config_hash ||
            tx.processor_config_hash !== sha256(canonicalJson(current))
          )
            throw new Error('frozen-config-unavailable');
          config = current;
        }
      } else {
        const current = settings.cardProcessorConfigJson
          ? processor.configSchema.parse(
              JSON.parse(settings.cardProcessorConfigJson),
            )
          : processor.configSchema.parse({});
        if (
          tx.processor_config_hash &&
          tx.processor_config_hash !== sha256(canonicalJson(current))
        )
          throw new Error('frozen-config-unavailable');
        config = current;
      }
    } catch {
      throw new Error(
        'frozen-config-unavailable: the original processor configuration could not be recovered. Refund on the physical terminal and record an external-terminal refund.',
      );
    }
    if (!processor.refundCharge)
      throw new Error(
        'This processor cannot refund charges. Refund on the physical terminal and record an external-terminal refund.',
      );
    const result = await processor.refundCharge(
      {
        chargeReference: context.chargeReference!,
        refundReference: value.operationId,
        amountCents: validation.calculation.amountCents,
      },
      config,
      this.db.getProcessorStorage(),
    );
    if (result.status !== 'refunded')
      throw new Error(
        `${result.errorMessage ?? 'Processor refund failed.'} Refund on the physical terminal and record an external-terminal refund.`,
      );
    const processorRefundId = result.processorRefundId ?? null;
    try {
      return this.db.recordRefund(value, processorRefundId);
    } catch (error) {
      throw new Error(
        `Card was refunded but not recorded. Processor refund ID: ${processorRefundId ?? 'unknown'}; refunded amount: ${validation.calculation.amountCents} cents. ${errorMessage(error)}`,
      );
    }
  }

  /** Reconciles every unresolved transaction except those awaiting operator attention. */
  async reconcileAll(): Promise<void> {
    for (const tx of this.db.getReconcilablePaymentTransactions()) {
      try {
        await this.reconcile(String(tx.charge_reference));
      } catch (error) {
        console.error(
          'Failed to reconcile transaction',
          tx.charge_reference,
          error,
        );
      }
    }
  }

  // ----------------------------------------------------------- needs-attention

  listNeedsAttention(): NeedsAttentionEntry[] {
    return this.db.getNeedsAttentionPaymentTransactions().map((row) => {
      const tx = row as unknown as TransactionRow;
      const kiosk = tx.kiosk_id
        ? this.db.getActiveKiosk(String(tx.kiosk_id))
        : null;
      return {
        chargeReference: String(tx.charge_reference),
        status: tx.status as PaymentStatus,
        totalCents: Number(tx.amount_cents),
        attentionReason: tx.attention_reason,
        processorId: String(tx.processor_id),
        originChannel: (tx.origin_channel as PaymentChannel) ?? 'manager',
        kioskId: tx.kiosk_id ? String(tx.kiosk_id) : null,
        kioskName: kiosk ? kiosk.name : null,
        createdAt: String(tx.created_at),
        updatedAt: String(tx.updated_at),
        reservations: this.db.listReservations(String(tx.charge_reference)),
      };
    });
  }

  /**
   * Operator resolution for an approved-but-unfinalizable charge.
   * `retry` re-runs reconciliation and finalization; `void` releases the held stock and
   * records the charge as abandoned (the authorization itself must be refunded at the
   * processor, which is a human action).
   */
  async resolveNeedsAttention(
    chargeReference: string,
    action: 'retry' | 'void',
    note?: string,
  ): Promise<ChargeOutcome | null> {
    const tx = this.db.getPaymentTransaction(chargeReference) as
      TransactionRow | undefined;
    if (!tx)
      throw new PaymentError(
        'charge-not-found',
        'Payment transaction not found',
      );
    if (String(tx.status) !== 'needs-attention')
      throw new PaymentError(
        'charge-not-found',
        'Payment transaction is not awaiting attention',
      );
    if (action === 'void') {
      this.db.markPaymentNeedsAttention(
        chargeReference,
        `voided: ${note ?? 'resolved by operator'}`.slice(0, 500),
        false,
      );
      this.db.releaseReservations(chargeReference);
      return this.describe(this.require(chargeReference), 'replayed');
    }
    return this.reconcile(chargeReference);
  }

  // ------------------------------------------------------------------ helpers

  private require(chargeReference: string): TransactionRow {
    const tx = this.db.getPaymentTransaction(chargeReference) as
      TransactionRow | undefined;
    if (!tx)
      throw new PaymentError(
        'charge-not-found',
        'Payment transaction not found',
      );
    return tx;
  }

  private describe(
    tx: TransactionRow,
    kind: 'charged' | 'replayed',
  ): ChargeOutcome {
    const base: ChargeOutcome = {
      kind,
      chargeReference: String(tx.charge_reference),
      status: tx.status as PaymentStatus,
      totalCents: Number(tx.amount_cents),
    };
    if (tx.processor_transaction_id)
      base.processorTransactionId = String(tx.processor_transaction_id);
    if (tx.card_brand) base.cardBrand = String(tx.card_brand);
    if (tx.card_last4) base.cardLast4 = String(tx.card_last4);
    if (tx.attention_reason)
      base.attentionReason = String(tx.attention_reason).split(
        ':',
      )[0] as AttentionReason;
    if (tx.sale_id) {
      const sale = this.db.getSale(String(tx.sale_id));
      base.sale = sale;
      base.receiptNumber = sale.receiptNumber;
    }
    return base;
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
