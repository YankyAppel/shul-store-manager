import { describe, expect, it } from 'vitest';
import {
  accountPaymentReceiptHtml,
  isCode128Encodable,
  parseReceiptBarcode,
  receiptBarcodeValue,
  receiptHtml,
  refundReceiptHtml,
  storeSettingsSchema,
  type AccountPayment,
  type Refund,
  type Sale,
} from '../src/index.js';

const settings = storeSettingsSchema.parse({
  storeName: 'Shul Store',
  contactLines: ['123 Main Street'],
  currency: 'USD',
  taxRateBps: 1000,
  pricesIncludeTax: false,
  receiptFooter: 'Thank you',
});

const sale: Sale = {
  id: '00000000-0000-0000-0000-000000000001',
  receiptNumber: 45,
  status: 'completed',
  subtotalCents: 100,
  taxCents: 10,
  totalCents: 110,
  createdAt: '2026-01-01T12:00:00.000Z',
  completedAt: '2026-01-01T12:00:00.000Z',
  channel: 'manager',
  kioskId: null,
  items: [
    {
      id: '00000000-0000-0000-0000-000000000002',
      productId: '00000000-0000-0000-0000-000000000003',
      productName: 'Siddur',
      secondaryName: null,
      barcodeUsed: null,
      quantity: 1,
      unitSellingPriceCents: 100,
      unitPurchaseCostCents: 50,
      taxable: true,
      taxCents: 10,
      lineSubtotalCents: 100,
      lineTotalCents: 110,
    },
  ],
  payment: {
    method: 'cash',
    amountCents: 110,
    cashReceivedCents: 110,
    changeDueCents: 0,
    terminalReference: null,
    externalApproved: null,
  },
  customer: null,
};

const refund: Refund = {
  id: '00000000-0000-0000-0000-000000000004',
  operationId: '00000000-0000-0000-0000-000000000005',
  receiptNumber: 45,
  saleId: sale.id,
  method: 'cash',
  subtotalCents: 100,
  taxCents: 10,
  amountCents: 110,
  terminalReference: null,
  chargeReference: null,
  processorRefundId: null,
  customerId: null,
  reason: 'Customer return',
  createdAt: '2026-01-01T12:05:00.000Z',
  items: [
    {
      id: '00000000-0000-0000-0000-000000000006',
      saleItemId: sale.items[0]!.id,
      productId: sale.items[0]!.productId,
      productName: 'Siddur',
      quantity: 1,
      restocked: true,
      subtotalCents: 100,
      taxCents: 10,
      amountCents: 110,
    },
  ],
};

const payment: AccountPayment = {
  id: '00000000-0000-0000-0000-000000000007',
  operationId: '00000000-0000-0000-0000-000000000008',
  receiptNumber: 45,
  customerId: '00000000-0000-0000-0000-000000000009',
  customerName: 'Leah Cohen',
  accountNumber: 'A-45',
  amountCents: 500,
  method: 'cash',
  cashReceivedCents: 500,
  changeDueCents: 0,
  terminalReference: null,
  externalApproved: null,
  previousBalanceCents: 500,
  newBalanceCents: 0,
  notes: null,
  createdAt: '2026-01-01T12:10:00.000Z',
};

describe('receipt barcodes', () => {
  it('formats and parses all receipt namespaces', () => {
    expect(receiptBarcodeValue('sale', 45)).toBe('SSM-S-000045');
    expect(receiptBarcodeValue('refund', 45)).toBe('SSM-R-000045');
    expect(receiptBarcodeValue('account_payment', 45)).toBe('SSM-P-000045');
    expect(parseReceiptBarcode('SSM-S-000045')).toEqual({
      kind: 'sale',
      receiptNumber: 45,
    });
    expect(parseReceiptBarcode('SSM-R-000045')).toEqual({
      kind: 'refund',
      receiptNumber: 45,
    });
    expect(parseReceiptBarcode('SSM-P-000045')).toEqual({
      kind: 'account_payment',
      receiptNumber: 45,
    });
  });

  it('accepts scanner and human-entered variations', () => {
    expect(parseReceiptBarcode('  ssm-s-45  ')).toEqual({
      kind: 'sale',
      receiptNumber: 45,
    });
    expect(parseReceiptBarcode('SSM-R-45')).toEqual({
      kind: 'refund',
      receiptNumber: 45,
    });
    expect(parseReceiptBarcode('45')).toEqual({
      kind: 'sale',
      receiptNumber: 45,
    });
    expect(parseReceiptBarcode('SSM-P-1234567')).toEqual({
      kind: 'account_payment',
      receiptNumber: 1_234_567,
    });
  });

  it('rejects malformed and unrelated barcode values without throwing', () => {
    expect(parseReceiptBarcode('')).toBeNull();
    expect(parseReceiptBarcode('SSM-X-45')).toBeNull();
    expect(parseReceiptBarcode('SSM-S-1.5')).toBeNull();
    expect(parseReceiptBarcode('SSM-ABC-123')).toBeNull();
    expect(parseReceiptBarcode('SSM-CUST-ABC-123')).toBeNull();
    expect(parseReceiptBarcode(null as unknown as string)).toBeNull();
  });

  it('keeps generated receipt values Code 128 encodable', () => {
    for (const kind of ['sale', 'refund', 'account_payment'] as const) {
      expect(isCode128Encodable(receiptBarcodeValue(kind, 45))).toBe(true);
      expect(isCode128Encodable(receiptBarcodeValue(kind, 1_234_567))).toBe(
        true,
      );
    }
  });

  it('renders each customer-facing receipt barcode at both paper widths', () => {
    for (const receiptPaperWidthMm of [58, 80] as const) {
      const saleHtml = receiptHtml({
        sale,
        settings: { ...settings, receiptPaperWidthMm },
      });
      const paymentHtml = accountPaymentReceiptHtml({
        payment,
        settings: { ...settings, receiptPaperWidthMm },
      });
      expect(saleHtml).toContain('<svg ');
      expect(saleHtml).toContain('SSM-S-000045');
      expect(paymentHtml).toContain('<svg ');
      expect(paymentHtml).toContain('SSM-P-000045');
      expect(saleHtml).toContain(`data-paper-width="${receiptPaperWidthMm}"`);
      expect(paymentHtml).toContain(
        `data-paper-width="${receiptPaperWidthMm}"`,
      );
    }
    for (const receiptPaperWidthMm of [58, 80] as const) {
      const refundHtml = refundReceiptHtml({
        refund,
        storeName: settings.storeName,
        settings: { receiptPaperWidthMm },
      });
      expect(refundHtml).toContain('<svg ');
      expect(refundHtml).toContain('SSM-R-000045');
      expect(refundHtml).toContain(`@page{size:${receiptPaperWidthMm}mm auto`);
    }
  });
});
