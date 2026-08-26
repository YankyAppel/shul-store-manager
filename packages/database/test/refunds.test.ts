import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { processors, simulatedProcessor } from '@shul-store/payments';
import { StoreDatabase } from '../src/index.js';

function seed(
  store: StoreDatabase,
  sellingPriceCents = 101,
  taxable = false,
): { productId: string; customerId: string } {
  const categoryId = store.createCategory({ name: 'Returns' }).id;
  const productId = store.createProduct({
    categoryId,
    name: 'Juice',
    purchaseCostCents: 40,
    sellingPriceCents,
    taxable,
    lowStockThreshold: 1,
    barcodes: [`JUICE-${sellingPriceCents}`],
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 20,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  const customerId = store.createCustomer({
    name: 'Account customer',
    accountNumber: `A-${sellingPriceCents}`,
  }).id;
  return { productId, customerId };
}

function refundInput(
  saleId: string,
  saleItemId: string,
  quantity: number,
  restocked = true,
) {
  return {
    operationId: randomUUID(),
    saleId,
    items: [{ saleItemId, quantity, restocked }],
    reason: 'Customer return',
  };
}

async function integratedSale(
  store: StoreDatabase,
  firstPriceCents: number,
  secondPriceCents: number,
  processorId = 'simulated',
) {
  const { productId } = seed(store, firstPriceCents);
  const categoryId = store.listCategories()[0]!.id;
  const secondProductId = store.createProduct({
    categoryId,
    name: 'Water',
    purchaseCostCents: 20,
    sellingPriceCents: secondPriceCents,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: [`WATER-${secondPriceCents}`],
  }).id;
  store.addInventoryMovement({
    productId: secondProductId,
    quantityChange: 20,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  store.updateSettings({
    ...store.getSettings(),
    cardProcessingEnabled: true,
    cardProcessorId: processorId,
  });
  const charge = await store.payments.charge(
    {
      chargeReference: randomUUID(),
      idempotencyKey: randomUUID(),
      lines: [
        { productId, quantity: 1, barcodeUsed: null },
        { productId: secondProductId, quantity: 1, barcodeUsed: null },
      ],
    },
    { channel: 'manager', kioskId: null },
  );
  if (!charge.sale) throw new Error('Expected integrated card sale');
  return { sale: charge.sale, productId };
}

describe('refunds', () => {
  let store: StoreDatabase | undefined;

  afterEach(() => store?.close());

  it('supports partial then full refunds and flips status only at the end', () => {
    store = new StoreDatabase(':memory:');
    const { productId } = seed(store);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 3, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });
    const itemId = sale.items[0]!.id;

    const first = store.recordRefund(refundInput(sale.id, itemId, 1));
    expect(first.amountCents).toBe(101);
    expect(store.getSale(sale.id).status).toBe('completed');
    const second = store.recordRefund(refundInput(sale.id, itemId, 2));
    expect(second.amountCents).toBe(202);
    expect(store.getSale(sale.id).status).toBe('refunded');
    expect(store.refundableSale(sale.id).items[0]!.remainingQuantity).toBe(0);
  });

  it('rejects over-refunds with the product and remaining quantity', () => {
    store = new StoreDatabase(':memory:');
    const { productId } = seed(store);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 101 },
    });
    const input = refundInput(sale.id, sale.items[0]!.id, 2);
    expect(() => store.recordRefund(input)).toThrow(
      'Cannot refund 2 of Juice; only 1 unit(s) remain refundable.',
    );
    expect(store.listRefunds(sale.id)).toHaveLength(0);
  });

  it('replays an operation ID without duplicating effects', () => {
    store = new StoreDatabase(':memory:');
    const { productId } = seed(store);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 101 },
    });
    const input = refundInput(sale.id, sale.items[0]!.id, 1);
    const first = store.recordRefund(input);
    const replay = store.recordRefund(input);
    expect(replay).toEqual(first);
    expect(store.listRefunds(sale.id)).toHaveLength(1);
    expect(
      store.connection
        .prepare(
          'SELECT COUNT(*) AS count FROM inventory_movements WHERE reason = ?',
        )
        .get('customer_return'),
    ).toEqual({ count: 1 });
  });

  it('allocates tax across repeated partial refunds exactly', () => {
    store = new StoreDatabase(':memory:');
    store.updateSettings({ ...store.getSettings(), taxRateBps: 333 });
    const { productId } = seed(store, 100, true);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 3, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 400 },
    });
    const itemId = sale.items[0]!.id;
    const first = store.recordRefund(refundInput(sale.id, itemId, 1));
    const second = store.recordRefund(refundInput(sale.id, itemId, 1));
    const third = store.recordRefund(refundInput(sale.id, itemId, 1));
    expect([first, second, third].map((refund) => refund.taxCents)).toEqual([
      3, 3, 4,
    ]);
    expect(first.taxCents + second.taxCents + third.taxCents).toBe(
      sale.taxCents,
    );
  });

  it('refunds tax-inclusive prices exactly once', () => {
    store = new StoreDatabase(':memory:');
    store.updateSettings({
      ...store.getSettings(),
      taxRateBps: 1000,
      pricesIncludeTax: true,
    });
    const { productId } = seed(store, 110, true);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 110 },
    });
    const refund = store.recordRefund(
      refundInput(sale.id, sale.items[0]!.id, 1),
    );
    expect(refund.subtotalCents).toBe(100);
    expect(refund.taxCents).toBe(10);
    expect(refund.amountCents).toBe(110);
  });

  it('keeps not-resalable returns out of inventory', () => {
    store = new StoreDatabase(':memory:');
    const { productId } = seed(store);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 2, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 202 },
    });
    const itemId = sale.items[0]!.id;
    store.recordRefund(refundInput(sale.id, itemId, 1, false));
    expect(
      store.connection
        .prepare(
          'SELECT COUNT(*) AS count FROM inventory_movements WHERE reason = ?',
        )
        .get('customer_return'),
    ).toEqual({ count: 0 });
  });

  it('records account refunds as negative ledger entries and updates balance', () => {
    store = new StoreDatabase(':memory:');
    const { productId, customerId } = seed(store);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: { method: 'account', customerId, confirmed: true },
    });
    expect(store.getCustomerBalance(customerId)).toBe(101);
    store.recordRefund(refundInput(sale.id, sale.items[0]!.id, 1));
    expect(store.getCustomerBalance(customerId)).toBe(0);
    expect(store.listCustomerLedger(customerId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: 'sale_refund',
          amountCents: -101,
        }),
      ]),
    );
  });

  it('attempts integrated-card refunds before persistence and writes nothing on decline', async () => {
    store = new StoreDatabase(':memory:');
    const { productId } = seed(store, 101);
    const categoryId = store.listCategories()[0]!.id;
    const secondProductId = store.createProduct({
      categoryId,
      name: 'Water',
      purchaseCostCents: 20,
      sellingPriceCents: 103,
      taxable: false,
      lowStockThreshold: 1,
      barcodes: ['WATER-100'],
    }).id;
    store.addInventoryMovement({
      productId: secondProductId,
      quantityChange: 20,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    store.updateSettings({
      ...store.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    const charge = await store.payments.charge(
      {
        chargeReference: randomUUID(),
        idempotencyKey: randomUUID(),
        lines: [
          { productId, quantity: 1, barcodeUsed: null },
          { productId: secondProductId, quantity: 1, barcodeUsed: null },
        ],
      },
      { channel: 'manager', kioskId: null },
    );
    const sale = charge.sale!;
    const before = store.listRefunds(sale.id);
    await expect(
      store.payments.refund(refundInput(sale.id, sale.items[0]!.id, 1)),
    ).rejects.toThrow(/physical terminal/);
    expect(store.listRefunds(sale.id)).toEqual(before);
    expect(store.getSale(sale.id).status).toBe('completed');
    expect(
      store.connection
        .prepare('SELECT state FROM refund_intents')
        .all(),
    ).toEqual([{ state: 'failed' }]);
  });

  it('rejects invalid integrated-card refunds before calling the processor', async () => {
    let refundCalls = 0;
    const trackingProcessor = {
      ...simulatedProcessor,
      id: 'tracking-refund',
      refundCharge: async (
        ...args: Parameters<NonNullable<typeof simulatedProcessor.refundCharge>>
      ) => {
        refundCalls += 1;
        return simulatedProcessor.refundCharge!(...args);
      },
    };
    processors.push(trackingProcessor);
    try {
      store = new StoreDatabase(':memory:');
      const { sale } = await integratedSale(
        store,
        103,
        101,
        trackingProcessor.id,
      );
      await expect(
        store.payments.refund(refundInput(sale.id, sale.items[0]!.id, 2)),
      ).rejects.toThrow(/only 1 unit\(s\) remain refundable/);
      expect(refundCalls).toBe(0);
      expect(store.listRefunds(sale.id)).toHaveLength(0);
    } finally {
      processors.splice(processors.indexOf(trackingProcessor), 1);
    }
  });

  it('reports the processor refund when persistence fails afterward', async () => {
    store = new StoreDatabase(':memory:');
    const { sale } = await integratedSale(store, 103, 101);
    const originalRecordRefund = store.recordRefund;
    const failingStore = store as StoreDatabase & {
      recordRefund: typeof store.recordRefund;
    };
    failingStore.recordRefund = () => {
      throw new Error('simulated database write failure');
    };
    try {
      await expect(
        store.payments.refund(refundInput(sale.id, sale.items[0]!.id, 1)),
      ).rejects.toThrow(
        /Card was refunded but not recorded.*Processor refund ID: sim_refund_.*refunded amount: 103 cents/,
      );
    } finally {
      failingStore.recordRefund = originalRecordRefund;
    }
    expect(store.listRefundIntentsByState('attention')).toHaveLength(1);
  });

  it('records a card refund journal before sending and completes it after persistence', async () => {
    store = new StoreDatabase(':memory:');
    const { sale } = await integratedSale(store, 103, 101);
    const refund = await store.payments.refund(
      refundInput(sale.id, sale.items[0]!.id, 1),
    );
    expect(refund.processorRefundId).toMatch(/^sim_refund_/);
    expect(store.getRefundIntent(refund.operationId)).toMatchObject({
      state: 'completed',
      amountCents: refund.amountCents,
      allocationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('recovers a sent refund from processor status without resending it', async () => {
    let refundCalls = 0;
    const trackingProcessor = {
      ...simulatedProcessor,
      id: 'tracking-recovery',
      refundCharge: async (
        ...args: Parameters<NonNullable<typeof simulatedProcessor.refundCharge>>
      ) => {
        refundCalls += 1;
        return simulatedProcessor.refundCharge!(...args);
      },
    };
    processors.push(trackingProcessor);
    try {
      store = new StoreDatabase(':memory:');
      const { sale } = await integratedSale(
        store,
        103,
        101,
        trackingProcessor.id,
      );
      const input = refundInput(sale.id, sale.items[0]!.id, 1);
      const originalRecordRefund = store.recordRefund;
      const failingStore = store as StoreDatabase & {
        recordRefund: typeof store.recordRefund;
      };
      failingStore.recordRefund = () => {
        throw new Error('simulated database write failure');
      };
      await expect(store.payments.refund(input)).rejects.toThrow(
        /Card was refunded but not recorded/,
      );
      failingStore.recordRefund = originalRecordRefund;

      const recovered = await store.payments.refund(input);
      expect(recovered.processorRefundId).toMatch(/^sim_refund_/);
      expect(refundCalls).toBe(1);
      expect(store.getRefundIntent(input.operationId)?.state).toBe('completed');
    } finally {
      processors.splice(processors.indexOf(trackingProcessor), 1);
    }
  });

  it('writes nothing when the integrated-card processor errors', async () => {
    store = new StoreDatabase(':memory:');
    const { sale, productId } = await integratedSale(store, 102, 102);
    await expect(
      store.payments.refund(refundInput(sale.id, sale.items[0]!.id, 1)),
    ).rejects.toThrow(/physical terminal/);
    expect(store.listRefunds(sale.id)).toHaveLength(0);
    expect(store.getSale(sale.id).status).toBe('completed');
    expect(store.getProduct(productId).stockQuantity).toBe(19);
  });

  it('writes nothing when the frozen processor configuration is unavailable', async () => {
    class UnavailableSecretStore {
      readonly available = false;

      encrypt(value: string): string {
        return btoa(value);
      }

      decrypt(): string {
        throw new Error('secret unavailable');
      }
    }
    store = new StoreDatabase(':memory:', new UnavailableSecretStore());
    const { sale } = await integratedSale(store, 103, 101);
    store.updateSettings({
      ...store.getSettings(),
      cardProcessorConfigJson: JSON.stringify({ simulateDelayMs: 9 }),
    });
    await expect(
      store.payments.refund(refundInput(sale.id, sale.items[0]!.id, 1)),
    ).rejects.toThrow(/frozen-config-unavailable/);
    expect(store.listRefunds(sale.id)).toHaveLength(0);
  });

  it('guides to the terminal when the processor has no refund API', async () => {
    const noRefundProcessor = {
      ...simulatedProcessor,
      id: 'no-refund',
      refundCharge: undefined,
    };
    processors.push(noRefundProcessor);
    try {
      store = new StoreDatabase(':memory:');
      const { sale } = await integratedSale(store, 103, 101, 'no-refund');
      await expect(
        store.payments.refund(refundInput(sale.id, sale.items[0]!.id, 1)),
      ).rejects.toThrow(/cannot refund charges|physical terminal/);
      expect(store.listRefunds(sale.id)).toHaveLength(0);
    } finally {
      processors.splice(processors.indexOf(noRefundProcessor), 1);
    }
  });

  it('supports external-terminal refunds with a terminal reference', () => {
    store = new StoreDatabase(':memory:');
    const { productId } = seed(store);
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: null }],
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'sale-terminal',
      },
    });
    const refund = store.recordRefund({
      ...refundInput(sale.id, sale.items[0]!.id, 1),
      terminalReference: 'refund-terminal',
    });
    expect(refund.method).toBe('external_terminal');
    expect(refund.terminalReference).toBe('refund-terminal');
  });
});
