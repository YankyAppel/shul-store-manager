import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  benefitEligibility,
  calculateCart,
  quantitySchema,
} from '@shul-store/shared';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Deli' }).id;
  store.updateSettings({
    storeName: 'Test Store',
    contactLines: ['1 Main St'],
    currency: 'USD',
    taxRateBps: 1000,
    pricesIncludeTax: false,
    receiptFooter: 'Thank you',
    snapAccepted: true,
    wicAccepted: true,
  });
});
afterEach(() => store.close());

function weightProduct(
  overrides: Partial<Parameters<StoreDatabase['createProduct']>[0]> = {},
) {
  const productId = store.createProduct({
    categoryId,
    name: 'Deli turkey',
    purchaseCostCents: 300,
    sellingPriceCents: 899,
    taxable: true,
    lowStockThreshold: 0,
    barcodes: ['TURKEY'],
    soldBy: 'weight',
    unit: 'lb',
    snapEligible: true,
    ...overrides,
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 5000,
    reason: 'stock_received',
    notes: '5 lb opening stock',
  });
  return productId;
}

describe('decimal quantities', () => {
  it('quantitySchema accepts ≤3 decimals and rejects more', () => {
    expect(quantitySchema.safeParse(2.35).success).toBe(true);
    expect(quantitySchema.safeParse(0.001).success).toBe(true);
    expect(quantitySchema.safeParse(1.2345).success).toBe(false);
    expect(quantitySchema.safeParse(0).success).toBe(false);
    expect(quantitySchema.safeParse(-1).success).toBe(false);
  });

  it('calculates exact cents for a weight line', () => {
    const totals = calculateCart(
      [
        {
          product: {
            id: 'p1',
            name: 'Turkey',
            sellingPriceCents: 899,
            taxable: true,
            soldBy: 'weight',
            unit: 'lb',
          },
          quantity: 2.35,
        },
      ],
      { taxRateBps: 1000, pricesIncludeTax: false },
    );
    // 899 × 2.35 = 2112.65 → rounds to 2113; tax 10% → 211
    expect(totals.subtotalCents).toBe(2113);
    expect(totals.taxCents).toBe(211);
    expect(totals.totalCents).toBe(2324);
  });
});

describe('weight products at checkout', () => {
  it('sells a decimal quantity and deducts milli-unit stock', () => {
    const productId = weightProduct();
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 2.35, barcodeUsed: 'TURKEY' }],
      payment: { method: 'cash', cashReceivedCents: 3000 },
    });
    expect(sale.items[0]!.quantity).toBe(2.35);
    expect(sale.items[0]!.soldBy).toBe('weight');
    expect(sale.items[0]!.unit).toBe('lb');
    expect(sale.subtotalCents).toBe(2113);
    const product = store.listProducts().find((p) => p.id === productId)!;
    expect(product.stockQuantity).toBe(5000 - 2350);
  });

  it('rejects selling more weight than on hand', () => {
    const productId = weightProduct();
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 6, barcodeUsed: null }],
        payment: { method: 'cash', cashReceivedCents: 30000 },
      }),
    ).toThrow();
  });
});

describe('SNAP/EBT tender', () => {
  it('charges the eligible subtotal, waives eligible tax, records remainder', () => {
    const snap = weightProduct();
    const other = store.createProduct({
      categoryId,
      name: 'Cleaning spray',
      purchaseCostCents: 100,
      sellingPriceCents: 500,
      taxable: true,
      lowStockThreshold: 0,
      barcodes: ['SPRAY'],
    }).id;
    store.addInventoryMovement({
      productId: other,
      quantityChange: 10,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [
        { productId: snap, quantity: 1, barcodeUsed: null },
        { productId: other, quantity: 1, barcodeUsed: null },
      ],
      payment: {
        method: 'snap_ebt',
        approved: true,
        terminalReference: 'EBT-1234',
        remainder: { method: 'cash', cashReceivedCents: 1000 },
      },
    });
    // Turkey eligible: subtotal 899, its tax waived (90). Spray: 500 + 50 tax.
    // Total = 899 + 550 = 1449; benefit covers 899; remainder 550.
    expect(sale.totalCents).toBe(1449);
    expect(sale.taxCents).toBe(50);
    expect(sale.benefitPayment).toMatchObject({
      method: 'snap_ebt',
      amountCents: 899,
      terminalReference: 'EBT-1234',
    });
    // sale.payment carries the conventional remainder; the benefit side is
    // in benefitPayment.
    expect(sale.payment.method).toBe('cash');
    const benefitRow = store.connection
      .prepare('SELECT * FROM benefit_payments WHERE sale_id = ?')
      .get(sale.id) as { method: string; amount_cents: number };
    expect(benefitRow.method).toBe('snap_ebt');
    expect(benefitRow.amount_cents).toBe(899);
  });

  it('rejects SNAP when no items are eligible', () => {
    const productId = store.createProduct({
      categoryId,
      name: 'Soap',
      purchaseCostCents: 50,
      sellingPriceCents: 200,
      taxable: false,
      lowStockThreshold: 0,
      barcodes: ['SOAP'],
    }).id;
    store.addInventoryMovement({
      productId,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: {
          method: 'snap_ebt',
          approved: true,
          terminalReference: null,
        },
      }),
    ).toThrow(/eligible/);
  });

  it('requires a remainder when the benefit does not cover the sale', () => {
    const snap = weightProduct();
    const other = store.createProduct({
      categoryId,
      name: 'Foil',
      purchaseCostCents: 50,
      sellingPriceCents: 300,
      taxable: false,
      lowStockThreshold: 0,
      barcodes: ['FOIL'],
    }).id;
    store.addInventoryMovement({
      productId: other,
      quantityChange: 5,
      reason: 'stock_received',
      notes: 'Opening stock',
    });
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [
          { productId: snap, quantity: 1, barcodeUsed: null },
          { productId: other, quantity: 1, barcodeUsed: null },
        ],
        payment: {
          method: 'snap_ebt',
          approved: true,
          terminalReference: null,
        },
      }),
    ).toThrow(/remainder/i);
  });

  it('rejects SNAP when the store does not accept it', () => {
    store.updateSettings({
      storeName: 'Test Store',
      contactLines: [],
      currency: 'USD',
      taxRateBps: 0,
      pricesIncludeTax: false,
      receiptFooter: '',
      snapAccepted: false,
      wicAccepted: true,
    });
    const productId = weightProduct();
    expect(() =>
      store.completeSale({
        completionKey: randomUUID(),
        lines: [{ productId, quantity: 1, barcodeUsed: null }],
        payment: {
          method: 'snap_ebt',
          approved: true,
          terminalReference: null,
        },
      }),
    ).toThrow(/not enabled/i);
  });
});

describe('WIC manual tender', () => {
  it('records a WIC sale like an external tender', () => {
    const productId = weightProduct({ wicEligible: true });
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 0.5, barcodeUsed: null }],
      payment: {
        method: 'wic',
        approved: true,
        terminalReference: 'WIC-VOUCHER-7',
      },
    });
    expect(sale.payment.method).toBe('wic');
    expect(sale.benefitPayment?.method).toBe('wic');
    expect(sale.benefitPayment?.amountCents).toBe(sale.totalCents);
  });
});

describe('fractional refunds', () => {
  it('refunds part of a weight line and restocks in milli-units', () => {
    const productId = weightProduct();
    const sale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 2, barcodeUsed: null }],
      payment: { method: 'cash', cashReceivedCents: 5000 },
    });
    const itemId = sale.items[0]!.id;
    const refund = store.recordRefund({
      operationId: randomUUID(),
      saleId: sale.id,
      items: [{ saleItemId: itemId, quantity: 0.5, restocked: true }],
      reason: 'Customer return',
    });
    // 899 × 0.5 = 449.5 → 450; tax 45 → refund 495
    expect(refund.items[0]!.quantity).toBe(0.5);
    expect(refund.amountCents).toBe(495);
    const product = store.listProducts().find((p) => p.id === productId)!;
    expect(product.stockQuantity).toBe(5000 - 2000 + 500);
    expect(store.refundableSale(sale.id).items[0]!.remainingQuantity).toBe(1.5);
    expect(store.getSale(sale.id).status).toBe('completed');
  });
});

describe('benefitEligibility', () => {
  it('sums only eligible lines and reports waived tax', () => {
    const eligible = benefitEligibility(
      [
        {
          product: {
            id: 'a',
            name: 'Turkey',
            sellingPriceCents: 899,
            taxable: true,
            snapEligible: true,
          },
          quantity: 1,
        },
        {
          product: {
            id: 'b',
            name: 'Spray',
            sellingPriceCents: 500,
            taxable: true,
            snapEligible: false,
          },
          quantity: 1,
        },
      ],
      { taxRateBps: 1000, pricesIncludeTax: false },
      'snap_ebt',
    );
    expect(eligible.eligibleSubtotalCents).toBe(899);
    expect(eligible.waivedTaxCents).toBe(90);
  });
});
