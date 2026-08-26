import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { businessDayRange } from '@shul-store/shared';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let file: string;
let categoryId: string;
let productId: string;
let secondProductId: string;
let customerId: string;
const now = new Date();
const businessDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

beforeEach(() => {
  file = path.join(tmpdir(), `shul-reports-${randomUUID()}.sqlite`);
  store = new StoreDatabase(file);
  categoryId = store.createCategory({ name: 'Food' }).id;
  productId = store.createProduct({
    categoryId,
    name: 'Cookie',
    purchaseCostCents: 100,
    sellingPriceCents: 300,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['COOKIE'],
  }).id;
  secondProductId = store.createProduct({
    categoryId,
    name: 'Challah',
    purchaseCostCents: 200,
    sellingPriceCents: 500,
    taxable: false,
    lowStockThreshold: 1,
    barcodes: ['CHALLAH'],
  }).id;
  store.addInventoryMovement({
    productId,
    quantityChange: 100,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  store.addInventoryMovement({
    productId: secondProductId,
    quantityChange: 100,
    reason: 'stock_received',
    notes: 'Opening stock',
  });
  customerId = store.createCustomer({
    name: 'Customer',
    accountNumber: '1001',
    creditLimitCents: 10_000,
  }).id;
});

afterEach(() => {
  store.close();
  rmSync(file, { force: true });
});

function timestamp(offsetMs = 0): string {
  return new Date(
    Date.parse(businessDayRange(businessDate).from) + offsetMs,
  ).toISOString();
}

function moveSale(saleId: string, completedAt: string): void {
  store.connection
    .prepare('UPDATE sales SET created_at = ?, completed_at = ? WHERE id = ?')
    .run(completedAt, completedAt, saleId);
}

describe('daily reports', () => {
  it('splits tenders, handles half-open boundaries, cash reconciliation, margin, and top items', () => {
    const cashSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 2, barcodeUsed: 'COOKIE' }],
      payment: { method: 'cash', cashReceivedCents: 1000 },
    });
    moveSale(cashSale.id, timestamp(0));

    const cardSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: 'COOKIE' }],
      payment: {
        method: 'external_terminal',
        approved: true,
        terminalReference: 'terminal-1',
      },
    });
    moveSale(cardSale.id, timestamp(1000));

    const accountSale = store.completeSale({
      completionKey: randomUUID(),
      lines: [
        { productId: secondProductId, quantity: 3, barcodeUsed: 'CHALLAH' },
      ],
      payment: { method: 'account', customerId, confirmed: true },
    });
    moveSale(accountSale.id, timestamp(2000));

    store.recordAccountPayment({
      operationId: randomUUID(),
      customerId,
      amountCents: 700,
      payment: { method: 'cash', cashReceivedCents: 1000 },
      notes: 'Cash payment',
    });
    const outside = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: 'COOKIE' }],
      payment: { method: 'cash', cashReceivedCents: 300 },
    });
    moveSale(outside.id, businessDayRange(businessDate).to);
    store.recordRefund({
      operationId: randomUUID(),
      saleId: cashSale.id,
      items: [
        {
          saleItemId: cashSale.items[0]!.id,
          quantity: 1,
          restocked: true,
        },
      ],
      reason: 'Report test return',
    });

    const report = store.dailyReport(businessDate, 500);
    expect(report.sales).toMatchObject({
      saleCount: 3,
      subtotalCents: 2 * 300 + 300 + 3 * 500,
      totalCents: 2 * 300 + 300 + 3 * 500,
    });
    expect(report.tenders).toEqual(
      expect.arrayContaining([
        { tender: 'cash', saleCount: 1, totalCents: 600 },
        { tender: 'external_terminal', saleCount: 1, totalCents: 300 },
        { tender: 'account', saleCount: 1, totalCents: 1500 },
      ]),
    );
    expect(report.cash).toMatchObject({
      salesCents: 600,
      receivedCents: 1000,
      changeGivenCents: 400,
    });
    expect(report.expectedCashCents).toBe(500 + 600 + 700 - 300);
    expect(report.refunds).toEqual([
      { method: 'cash', refundCount: 1, amountCents: 300 },
    ]);
    expect(report.profit).toMatchObject({
      costCents: 2 * 100 + 100 + 3 * 200,
      netSalesCents: 600 + 300 + 1500,
      grossProfitCents: 1500,
    });
    expect(report.topItems[0]).toMatchObject({
      productId: secondProductId,
      quantity: 3,
    });
  });

  it('includes the from boundary and excludes a sale before it', () => {
    const included = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: 'COOKIE' }],
      payment: { method: 'cash', cashReceivedCents: 300 },
    });
    moveSale(included.id, timestamp(0));
    const excluded = store.completeSale({
      completionKey: randomUUID(),
      lines: [{ productId, quantity: 1, barcodeUsed: 'COOKIE' }],
      payment: { method: 'cash', cashReceivedCents: 300 },
    });
    moveSale(excluded.id, timestamp(-1));

    expect(store.dailyReport(businessDate, 0).sales.saleCount).toBe(1);
  });

  it('reports voided sales separately without including them in sales totals', () => {
    const saleId = randomUUID();
    const at = timestamp(5000);
    store.connection
      .prepare(
        `INSERT INTO sales
         (id, receipt_number, completion_key, status, subtotal_cents, tax_cents,
          total_cents, created_at, completed_at)
         VALUES (?, ?, ?, 'voided', 900, 0, 900, ?, NULL)`,
      )
      .run(saleId, 999, randomUUID(), at);
    const report = store.dailyReport(businessDate, 0);
    expect(report.sales.saleCount).toBe(0);
    expect(report.voided).toEqual({ count: 1, totalCents: 900 });
  });
});

describe('daily closes', () => {
  it('rejects a second close for the same business date', () => {
    const first = store.recordDailyClose(businessDate, 500, 500);
    expect(first.overShortCents).toBe(0);
    expect(store.getDailyClose(businessDate)?.id).toBe(first.id);
    expect(() => store.recordDailyClose(businessDate, 500, 500)).toThrow(
      `Day ${businessDate} has already been closed.`,
    );
  });
});
