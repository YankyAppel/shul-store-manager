import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processors, simulatedProcessor } from '@shul-store/payments';
import {
  canonicalJson,
  PaymentError,
  PaymentService,
  sha256,
  StoreDatabase,
} from '../src/index.js';

/**
 * Shared Manager/Kiosk payment service: deterministic validation, frozen snapshot and
 * processor identity, snapshot-only exact-once finalization, per-transaction
 * reconciliation and the needs-attention lifecycle.
 */

const MANAGER = { channel: 'manager', kioskId: null } as const;

function seed(db: StoreDatabase, sellingPriceCents = 1000) {
  const categoryId = db.createCategory({ name: 'Drinks' }).id;
  const water = db.createProduct({
    categoryId,
    name: 'Water',
    purchaseCostCents: 40,
    sellingPriceCents,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['WATER-1'],
  });
  const soda = db.createProduct({
    categoryId,
    name: 'Soda',
    purchaseCostCents: 60,
    sellingPriceCents: 200,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['SODA-1'],
  });
  for (const product of [water, soda])
    db.addInventoryMovement({
      productId: product.id,
      quantityChange: 20,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
  db.updateSettings({
    ...db.getSettings(),
    cardProcessingEnabled: true,
    cardProcessorId: 'simulated',
  });
  return { water, soda };
}

function request(productId: string, quantity = 1) {
  return {
    chargeReference: randomUUID(),
    idempotencyKey: randomUUID(),
    lines: [{ productId, quantity, barcodeUsed: null }],
  };
}

describe('shared payment service', () => {
  let db: StoreDatabase;
  let payments: PaymentService;
  let water: ReturnType<StoreDatabase['createProduct']>;
  let soda: ReturnType<StoreDatabase['createProduct']>;

  beforeEach(() => {
    db = new StoreDatabase(':memory:');
    const seeded = seed(db);
    water = seeded.water;
    soda = seeded.soda;
    payments = db.payments;
  });

  afterEach(() => db.close());

  it('validates deterministically and writes nothing when validation fails', async () => {
    const bad = request(water.id);
    const failures: PaymentError[] = [];

    // Disabled card processing.
    db.updateSettings({ ...db.getSettings(), cardProcessingEnabled: false });
    try {
      payments.validate(bad, MANAGER);
    } catch (error) {
      failures.push(error as PaymentError);
    }
    db.updateSettings({ ...db.getSettings(), cardProcessingEnabled: true });

    // Unknown product, inactive product, barcode mismatch, zero-amount, insufficient stock.
    const unknown = request(randomUUID());
    const oversized = {
      ...request(water.id),
      lines: [{ productId: water.id, quantity: 10000, barcodeUsed: null }],
    };
    const wrongBarcode = {
      ...request(water.id),
      lines: [{ productId: water.id, quantity: 1, barcodeUsed: 'SODA-1' }],
    };
    for (const candidate of [unknown, oversized, wrongBarcode]) {
      try {
        payments.validate(candidate, MANAGER);
      } catch (error) {
        failures.push(error as PaymentError);
      }
    }

    expect(failures.map((failure) => failure.code)).toEqual([
      'card-processing-disabled',
      'product-not-found',
      'insufficient-stock',
      'barcode-mismatch',
    ]);
    for (const failure of failures)
      expect(failure).toBeInstanceOf(PaymentError);

    // Nothing was journaled, reserved or sent to the processor.
    for (const candidate of [bad, unknown, oversized, wrongBarcode]) {
      expect(
        db.getPaymentTransaction(candidate.chargeReference),
      ).toBeUndefined();
      expect(db.listReservations(candidate.chargeReference)).toEqual([]);
      expect(
        await db.getProcessorStorage().get(candidate.chargeReference),
      ).toBe(undefined);
    }
    expect(db.getPendingPaymentTransactions()).toEqual([]);
  });

  it('freezes a canonical snapshot digest and a deterministic reservation set', () => {
    const first = payments.validate(
      {
        chargeReference: randomUUID(),
        idempotencyKey: randomUUID(),
        lines: [
          { productId: water.id, quantity: 2, barcodeUsed: 'WATER-1' },
          { productId: water.id, quantity: 1, barcodeUsed: null },
          { productId: soda.id, quantity: 3, barcodeUsed: null },
        ],
      },
      MANAGER,
    );

    // Duplicate lines collapse into one aggregated, ordered reservation per product.
    expect(first.reservations).toEqual(
      [
        { productId: soda.id, quantity: 3 },
        { productId: water.id, quantity: 3 },
      ].sort((a, b) => a.productId.localeCompare(b.productId)),
    );
    expect(first.totalCents).toBe(2 * 1000 + 1 * 1000 + 3 * 200);

    // The stored snapshot is already in canonical form: re-canonicalizing reproduces it.
    expect(sha256(canonicalJson(JSON.parse(first.snapshotJson)))).toBe(
      first.snapshotHash,
    );

    // The same cart validates to the same digest every time.
    const second = payments.validate(
      {
        chargeReference: randomUUID(),
        idempotencyKey: randomUUID(),
        lines: [
          { productId: water.id, quantity: 2, barcodeUsed: 'WATER-1' },
          { productId: water.id, quantity: 1, barcodeUsed: null },
          { productId: soda.id, quantity: 3, barcodeUsed: null },
        ],
      },
      MANAGER,
    );
    expect(second.snapshotHash).toBe(first.snapshotHash);
    expect(second.processor.configHash).toBe(first.processor.configHash);
    expect(second.processor.processorId).toBe('simulated');
  });

  it('persists and protects the frozen charge identity', async () => {
    const input = request(water.id, 2);
    const validation = payments.validate(input, MANAGER);
    await payments.charge(input, MANAGER);

    const row = db.getPaymentTransaction(input.chargeReference)!;
    expect(String(row.snapshot_hash)).toBe(validation.snapshotHash);
    expect(String(row.processor_config_hash)).toBe(
      validation.processor.configHash,
    );
    expect(String(row.origin_channel)).toBe('manager');

    for (const column of [
      'snapshot_hash',
      'processor_config_hash',
      'processor_config_secret',
      'origin_channel',
      'cart_snapshot_json',
      'amount_cents',
      'idempotency_key',
    ])
      expect(() =>
        db.connection
          .prepare(`UPDATE payment_transactions SET ${column} = 'tampered'`)
          .run(),
      ).toThrow();
  });

  it('authorizes, finalizes from the snapshot exactly once, and replays afterwards', async () => {
    const input = request(water.id, 2);
    const outcome = await payments.charge(input, MANAGER);

    expect(outcome.status).toBe('approved');
    expect(outcome.kind).toBe('charged');
    expect(outcome.sale?.totalCents).toBe(2000);
    expect(outcome.receiptNumber).toBe(outcome.sale?.receiptNumber);
    expect(db.listSales()).toHaveLength(1);
    expect(
      db.listReservations(input.chargeReference).map((row) => row.status),
    ).toEqual(['consumed']);
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.finalized_at),
    ).not.toBe('null');

    // Finalization is exact-once: repeated calls return the same sale.
    const again = payments.finalize(input.chargeReference);
    expect(again?.id).toBe(outcome.sale?.id);
    expect(db.listSales()).toHaveLength(1);

    // A retried charge request replays instead of authorizing again.
    const replayed = await payments.charge(input, MANAGER);
    expect(replayed.kind).toBe('replayed');
    expect(replayed.sale?.id).toBe(outcome.sale?.id);
    expect(db.listSales()).toHaveLength(1);
    expect(
      (
        db.connection
          .prepare('SELECT COUNT(*) AS count FROM payment_transactions')
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  it('finalizes from the frozen snapshot even after the catalog price changes', async () => {
    const input = request(water.id, 1);
    await payments.charge(input, MANAGER);
    const before = db.getSale(
      String(db.getPaymentTransaction(input.chargeReference)!.sale_id),
    );
    expect(before.totalCents).toBe(1000);

    // A later price change cannot rewrite history: the persisted sale keeps snapshot prices.
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 5000,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    expect(db.getSale(before.id).totalCents).toBe(1000);
  });

  it('finalizes a pending charge from its frozen products after a restart window', async () => {
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 1003,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    const input = request(water.id, 1);
    const pending = await payments.charge(input, MANAGER);
    expect(pending.status).toBe('unknown');

    await db.getProcessorStorage().set(input.chargeReference, {
      status: 'approved',
      processorTransactionId: 'txn_restart',
      cardBrand: 'Visa',
      cardLast4: '4242',
    });
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 5000,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });

    const recovered = await payments.reconcile(input.chargeReference);
    expect(recovered?.status).toBe('approved');
    expect(recovered?.sale?.totalCents).toBe(1003);
    expect(db.listSales()[0]?.totalCents).toBe(1003);
  });

  it('releases reservations and creates no sale for a declined charge', async () => {
    // Simulated processor declines anything ending in .01.
    const input = {
      ...request(water.id),
      lines: [{ productId: water.id, quantity: 1, barcodeUsed: null }],
    };
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 1001,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    const outcome = await payments.charge(input, MANAGER);

    expect(outcome.status).toBe('declined');
    expect(outcome.sale).toBeUndefined();
    expect(db.listSales()).toHaveLength(0);
    expect(
      db.listReservations(input.chargeReference).map((row) => row.status),
    ).toEqual(['released']);
    expect(db.heldQuantityFor(water.id, null)).toBe(0);
  });

  it('rejects reused charge references and idempotency keys', async () => {
    const original = request(water.id);
    await payments.charge(original, MANAGER);

    const sameReference = { ...original, idempotencyKey: randomUUID() };
    await expect(payments.charge(sameReference, MANAGER)).rejects.toMatchObject(
      {
        code: 'charge-reference-conflict',
      },
    );

    const sameKey = {
      ...request(water.id),
      idempotencyKey: original.idempotencyKey,
    };
    await expect(payments.charge(sameKey, MANAGER)).rejects.toMatchObject({
      code: 'idempotency-conflict',
    });

    // A charge still in flight blocks any second attempt for the same cart.
    const pending = request(soda.id);
    db.createPaymentTransaction(
      pending.chargeReference,
      'simulated',
      200,
      '{}',
      pending.idempotencyKey,
    );
    db.updatePaymentTransactionStatus(pending.chargeReference, 'unknown');
    const inFlight = {
      ...request(soda.id),
      idempotencyKey: pending.idempotencyKey,
    };
    await expect(payments.charge(inFlight, MANAGER)).rejects.toMatchObject({
      code: 'in-progress',
    });
    expect(db.listSales()).toHaveLength(1);
  });

  it('moves an approved-but-unfinalizable charge to needs-attention and resolves it', async () => {
    // .03 leaves the simulated processor pending, so nothing is finalized yet.
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 1003,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    const input = request(water.id, 1);
    const outcome = await payments.charge(input, MANAGER);
    expect(outcome.status).toBe('unknown');
    expect(db.listSales()).toHaveLength(0);

    // Drain the stock that the reservation was holding, then let reconciliation learn the
    // charge was approved: the sale can no longer be created.
    db.addInventoryMovement({
      productId: water.id,
      quantityChange: -20,
      reason: 'manual_decrease',
      notes: 'Damaged in storage',
    });
    const reconciled = await payments.reconcile(input.chargeReference);
    expect(reconciled?.status).toBe('needs-attention');
    expect(db.listSales()).toHaveLength(0);

    const attention = payments.listNeedsAttention();
    expect(attention).toHaveLength(1);
    expect(attention[0]!.chargeReference).toBe(input.chargeReference);
    expect(attention[0]!.attentionReason).toMatch(/^finalization-failed:/);
    expect(attention[0]!.originChannel).toBe('manager');
    expect(attention[0]!.reservations[0]!.status).toBe('held');
    expect(db.heldQuantityFor(water.id, null)).toBe(1);

    // The automatic sweep must not silently retry a charge awaiting an operator.
    await db.runStartupReconciliation();
    expect(db.listSales()).toHaveLength(0);
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.status),
    ).toBe('needs-attention');

    // Restock and retry explicitly: the operator resolves it into a real sale.
    db.addInventoryMovement({
      productId: water.id,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'Restocked',
    });
    const retried = await payments.resolveNeedsAttention(
      input.chargeReference,
      'retry',
    );
    expect(retried?.status).toBe('approved');
    expect(db.listSales()).toHaveLength(1);
    expect(payments.listNeedsAttention()).toHaveLength(0);
    expect(
      db.listReservations(input.chargeReference).map((row) => row.status),
    ).toEqual(['consumed']);
  });

  it('lets an operator void a needs-attention charge and frees the held stock', async () => {
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 1003,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    const input = request(water.id, 1);
    await payments.charge(input, MANAGER);
    expect(db.heldQuantityFor(water.id, null)).toBe(1);

    // Corrupt the authorization state so finalization cannot succeed.
    db.connection
      .prepare("UPDATE payment_transactions SET status='unknown'")
      .run();
    await db.getProcessorStorage().set(input.chargeReference, {
      status: 'approved',
      processorTransactionId: 'txn_void',
    });
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 1003,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    db.addInventoryMovement({
      productId: water.id,
      quantityChange: -20,
      reason: 'manual_decrease',
      notes: 'Damaged in storage',
    });
    await payments.reconcile(input.chargeReference);
    expect(payments.listNeedsAttention()).toHaveLength(1);

    const voided = await payments.resolveNeedsAttention(
      input.chargeReference,
      'void',
      'Refunded at the terminal',
    );
    expect(voided?.status).toBe('voided');
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.attention_reason),
    ).toMatch(/^voided: Refunded at the terminal/);
    expect(
      db.listReservations(input.chargeReference).map((row) => row.status),
    ).toEqual(['released']);
    expect(db.heldQuantityFor(water.id, null)).toBe(0);
    expect(db.listSales()).toHaveLength(0);

    await expect(
      payments.resolveNeedsAttention(input.chargeReference, 'retry'),
    ).rejects.toMatchObject({ code: 'charge-voided' });
    await expect(
      payments.reconcile(input.chargeReference),
    ).rejects.toMatchObject({ code: 'charge-voided' });
    await db.runStartupReconciliation();
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.status),
    ).toBe('voided');
    const secondVoid = await payments.resolveNeedsAttention(
      input.chargeReference,
      'void',
      'different note',
    );
    expect(secondVoid?.status).toBe('voided');
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.resolved_by_note),
    ).toBe('Refunded at the terminal');
  });

  it('marks a charge needs-attention when its frozen snapshot no longer validates', async () => {
    const reference = randomUUID();
    db.createPaymentTransaction(
      reference,
      'simulated',
      100,
      '{}',
      randomUUID(),
    );
    db.updatePaymentTransactionStatus(reference, 'unknown');
    await db.getProcessorStorage().set(reference, { status: 'approved' });

    await payments.reconcile(reference);
    const attention = payments.listNeedsAttention();
    expect(attention).toHaveLength(1);
    expect(attention[0]!.attentionReason).toMatch(/^invalid-snapshot:/);
    expect(db.listSales()).toHaveLength(0);
  });

  it('detects a tampered snapshot through its frozen digest', async () => {
    const reference = randomUUID();
    const snapshot = {
      lines: [
        {
          productId: water.id,
          quantity: 1,
          barcodeUsed: null,
          productName: 'Water',
          secondaryName: null,
          unitSellingPriceCents: 1000,
          unitPurchaseCostCents: 40,
          taxable: false,
          unitPriceCents: 1000,
          subtotalCents: 1000,
          taxCents: 0,
          totalCents: 1000,
        },
      ],
      totals: { subtotalCents: 1000, taxCents: 0, totalCents: 1000 },
    };
    db.createPaymentTransaction(
      reference,
      'simulated',
      1000,
      canonicalJson(snapshot),
      randomUUID(),
      null,
      [],
      { snapshotHash: sha256('not-the-snapshot'), originChannel: 'manager' },
    );
    db.updatePaymentTransactionStatus(reference, 'approved');

    expect(payments.finalize(reference)).toBeNull();
    expect(payments.listNeedsAttention()[0]!.attentionReason).toMatch(
      /^snapshot-hash-mismatch:/,
    );
    expect(db.listSales()).toHaveLength(0);
  });

  it('reconciles a legacy charge as needs-attention when its configuration changes', async () => {
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 1003,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    const input = request(water.id);
    const validation = payments.validate(input, MANAGER);
    db.createPaymentTransaction(
      input.chargeReference,
      validation.processor.processorId,
      validation.totalCents,
      validation.snapshotJson,
      input.idempotencyKey,
      null,
      validation.reservations,
      {
        processorConfigHash: validation.processor.configHash,
        originChannel: 'manager',
      },
    );
    await db.getProcessorStorage().set(input.chargeReference, {
      status: 'approved',
      processorTransactionId: 'legacy',
    });
    db.updatePaymentTransactionStatus(input.chargeReference, 'unknown');
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.status),
    ).toBe('unknown');

    // Configuration changed after authorization: identity no longer matches.
    db.updateSettings({
      ...db.getSettings(),
    });
    db.setCardProcessorConfigJson(JSON.stringify({ simulateDelayMs: 5 }));
    await payments.reconcile(input.chargeReference);
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.status),
    ).toBe('needs-attention');
    expect(payments.listNeedsAttention()[0]!.attentionReason).toMatch(
      /^processor-config-changed:/,
    );
    expect(db.listSales()).toHaveLength(0);
    expect(
      db.listReservations(input.chargeReference).map((row) => row.status),
    ).toEqual(['held']);

    // Processor changed after authorization. Soda is priced so the total also stays pending.
    db.updateProduct(soda.id, {
      categoryId: soda.categoryId,
      name: soda.name,
      purchaseCostCents: soda.purchaseCostCents,
      sellingPriceCents: 203,
      taxable: false,
      lowStockThreshold: soda.lowStockThreshold,
    });
    const second = request(soda.id);
    db.updateSettings({
      ...db.getSettings(),
    });
    db.setCardProcessorConfigJson(null);
    await payments.charge(second, MANAGER);
    db.updateSettings({ ...db.getSettings(), cardProcessorId: 'gone' });
    await payments.reconcile(second.chargeReference);
    expect(
      String(db.getPaymentTransaction(second.chargeReference)!.status),
    ).toBe('needs-attention');
    expect(
      payments
        .listNeedsAttention()
        .find((entry) => entry.chargeReference === second.chargeReference)!
        .attentionReason,
    ).toMatch(/^processor-changed:/);
    expect(db.listSales()).toHaveLength(0);
  });

  it('reconciles with the frozen processor configuration after settings change', async () => {
    const calls: { kind: string; config: unknown }[] = [];
    const recordingProcessor = {
      ...simulatedProcessor,
      id: 'recording',
      createCharge: async (
        _request: Parameters<typeof simulatedProcessor.createCharge>[0],
        config: Parameters<typeof simulatedProcessor.createCharge>[1],
      ) => {
        calls.push({ kind: 'create', config });
        return { status: 'pending' as const };
      },
      getChargeStatus: async (
        chargeReference: string,
        config: Parameters<typeof simulatedProcessor.getChargeStatus>[1],
      ) => {
        calls.push({ kind: 'status', config });
        return {
          status: 'approved' as const,
          processorTransactionId: `recorded-${chargeReference}`,
        };
      },
    };
    processors.push(recordingProcessor);
    try {
      db.updateSettings({
        ...db.getSettings(),
        cardProcessingEnabled: true,
        cardProcessorId: 'recording',
      });
      db.setCardProcessorConfigJson(JSON.stringify({ simulateDelayMs: 1 }));
      const input = request(water.id);
      const pending = await payments.charge(input, MANAGER);
      expect(pending.status).toBe('unknown');

      db.updateSettings({
        ...db.getSettings(),
      });
      db.setCardProcessorConfigJson(JSON.stringify({ simulateDelayMs: 99 }));
      const reconciled = await payments.reconcile(input.chargeReference);

      expect(reconciled?.status).toBe('approved');
      expect(calls).toEqual([
        { kind: 'create', config: { simulateDelayMs: 1 } },
        { kind: 'status', config: { simulateDelayMs: 1 } },
      ]);
      expect(db.listSales()).toHaveLength(1);
      await payments.reconcile(input.chargeReference);
      expect(calls).toHaveLength(2);
      expect(payments.listNeedsAttention()).toHaveLength(0);
    } finally {
      processors.splice(processors.indexOf(recordingProcessor), 1);
    }
  });

  it('holds reservations and records a safe attention reason when the frozen configuration is corrupt', async () => {
    const input = request(water.id);
    const validation = payments.validate(input, MANAGER);
    db.createPaymentTransaction(
      input.chargeReference,
      validation.processor.processorId,
      validation.totalCents,
      validation.snapshotJson,
      input.idempotencyKey,
      null,
      validation.reservations,
      {
        processorConfigHash: validation.processor.configHash,
        processorConfigSecret: '%',
        originChannel: 'manager',
      },
    );
    await db.getProcessorStorage().set(input.chargeReference, {
      status: 'approved',
      processorTransactionId: 'corrupt',
    });
    db.updatePaymentTransactionStatus(input.chargeReference, 'unknown');
    db.updateSettings({
      ...db.getSettings(),
    });
    db.setCardProcessorConfigJson(JSON.stringify({ simulateDelayMs: 5 }));

    await expect(
      payments.reconcile(input.chargeReference),
    ).resolves.toMatchObject({ status: 'needs-attention' });
    expect(db.listSales()).toHaveLength(0);
    expect(
      db.listReservations(input.chargeReference).map((row) => row.status),
    ).toEqual(['held']);
    expect(payments.listNeedsAttention()[0]!.attentionReason).toMatch(
      /^frozen-config-unavailable:/,
    );
  });

  it('recovers a corrupt frozen configuration when the current configuration hash matches', async () => {
    const input = request(water.id);
    const validation = payments.validate(input, MANAGER);
    db.createPaymentTransaction(
      input.chargeReference,
      validation.processor.processorId,
      validation.totalCents,
      validation.snapshotJson,
      input.idempotencyKey,
      null,
      validation.reservations,
      {
        processorConfigHash: validation.processor.configHash,
        processorConfigSecret: '%',
        originChannel: 'manager',
      },
    );
    await db.getProcessorStorage().set(input.chargeReference, {
      status: 'approved',
      processorTransactionId: 'recoverable',
    });
    db.updatePaymentTransactionStatus(input.chargeReference, 'unknown');

    const reconciled = await payments.reconcile(input.chargeReference);

    expect(reconciled?.status).toBe('approved');
    expect(db.listSales()).toHaveLength(1);
    expect(payments.listNeedsAttention()).toHaveLength(0);
    expect(db.heldQuantityFor(water.id, null)).toBe(0);
  });

  it('keeps frozen processor configuration out of sync payloads and attention listings', async () => {
    db.updateProduct(water.id, {
      categoryId: water.categoryId,
      name: water.name,
      purchaseCostCents: water.purchaseCostCents,
      sellingPriceCents: 1003,
      taxable: false,
      lowStockThreshold: water.lowStockThreshold,
    });
    db.updateSettings({
      ...db.getSettings(),
    });
    db.setCardProcessorConfigJson(JSON.stringify({ simulateDelayMs: 5 }));
    const input = request(water.id);
    const pending = await payments.charge(input, MANAGER);
    expect(pending.status).toBe('unknown');

    const row = db.getPaymentTransaction(input.chargeReference)!;
    const secret = String(row.processor_config_secret);
    const paymentEvent = db
      .exportOutboxSnapshot()
      .filter((event) => event.entityType === 'payment_transaction')
      .at(-1)!;
    const payload = JSON.stringify(paymentEvent.payload);
    expect(payload).not.toContain(secret);
    expect(payload).not.toContain('simulateDelayMs');

    db.addInventoryMovement({
      productId: water.id,
      quantityChange: -20,
      reason: 'manual_decrease',
      notes: 'Damaged in storage',
    });
    await payments.reconcile(input.chargeReference);
    const attention = JSON.stringify(payments.listNeedsAttention());
    expect(attention).not.toContain(secret);
    expect(attention).not.toContain('simulateDelayMs');
  });

  it('enforces the documented status transitions in SQLite', () => {
    const reference = randomUUID();
    db.createPaymentTransaction(
      reference,
      'simulated',
      100,
      '{}',
      randomUUID(),
    );

    // initiated -> needs-attention is allowed (a charge can be blocked before it resolves).
    db.updatePaymentTransactionStatus(reference, 'needs-attention');
    expect(String(db.getPaymentTransaction(reference)!.status)).toBe(
      'needs-attention',
    );

    // needs-attention -> approved is allowed, but only for an operator retry.
    db.updatePaymentTransactionStatus(reference, 'approved');
    expect(String(db.getPaymentTransaction(reference)!.status)).toBe(
      'approved',
    );

    // approved -> declined is not a legal transition.
    expect(() =>
      db.updatePaymentTransactionStatus(reference, 'declined'),
    ).toThrow('Invalid payment transaction status transition');

    // approved -> reconciled is not written by any code path and is not permitted.
    expect(() =>
      db.updatePaymentTransactionStatus(reference, 'reconciled'),
    ).toThrow('Invalid payment transaction status transition');

    db.updatePaymentTransactionStatus(reference, 'needs-attention');
    db.updatePaymentTransactionStatus(reference, 'voided');
    expect(String(db.getPaymentTransaction(reference)!.status)).toBe('voided');
    expect(() =>
      db.updatePaymentTransactionStatus(reference, 'unknown'),
    ).toThrow('Invalid payment transaction status transition');
  });

  it('requires a paired kiosk identity for kiosk-originated charges', async () => {
    const input = request(water.id);
    await expect(
      payments.charge(input, { channel: 'kiosk', kioskId: null }),
    ).rejects.toMatchObject({ code: 'kiosk-unknown' });
    await expect(
      payments.charge(input, { channel: 'kiosk', kioskId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'kiosk-unknown' });
    expect(db.getPaymentTransaction(input.chargeReference)).toBeUndefined();

    const kioskId = randomUUID();
    db.createKiosk(kioskId, 'Front table', 'token-hash', 'pin-hash');
    const outcome = await payments.charge(input, {
      channel: 'kiosk',
      kioskId,
    });
    expect(outcome.status).toBe('approved');
    expect(
      String(db.getPaymentTransaction(input.chargeReference)!.origin_channel),
    ).toBe('kiosk');
    expect(
      db.getSale(
        String(db.getPaymentTransaction(input.chargeReference)!.sale_id),
      ).payment.method,
    ).toBe('integrated_card');

    // A revoked kiosk can no longer start charges.
    db.revokeKiosk(kioskId);
    expect(db.getActiveKiosk(kioskId)).toBeNull();
    await expect(
      payments.charge(request(water.id), { channel: 'kiosk', kioskId }),
    ).rejects.toMatchObject({ code: 'kiosk-unknown' });
  });
});
