import { describe, expect, it } from 'vitest';
import {
  calculateRefund,
  calculateRefundTax,
  refundableQuantity,
  validateRefundQuantity,
} from '../src/refunds.js';

describe('refund domain calculations', () => {
  it('computes refundable quantities and rejects an over-refund with context', () => {
    expect(refundableQuantity(4, 1)).toBe(3);
    expect(validateRefundQuantity('Challah', 4, 1, 2)).toBe(1);
    expect(() => validateRefundQuantity('Challah', 4, 3, 2)).toThrow(
      'Cannot refund 2 of Challah; only 1 unit(s) remain refundable.',
    );
  });

  it('assigns the exact tax remainder to the final partial refund', () => {
    expect(
      calculateRefundTax({
        saleItemTaxCents: 10,
        soldQuantity: 3,
        refundedQuantity: 0,
        requestedQuantity: 1,
        taxAlreadyRefundedCents: 0,
      }),
    ).toBe(3);
    expect(
      calculateRefundTax({
        saleItemTaxCents: 10,
        soldQuantity: 3,
        refundedQuantity: 1,
        requestedQuantity: 1,
        taxAlreadyRefundedCents: 3,
      }),
    ).toBe(3);
    expect(
      calculateRefundTax({
        saleItemTaxCents: 10,
        soldQuantity: 3,
        refundedQuantity: 2,
        requestedQuantity: 1,
        taxAlreadyRefundedCents: 6,
      }),
    ).toBe(4);
  });

  it('calculates line and aggregate totals in integer cents', () => {
    const result = calculateRefund([
      {
        saleItemId: 'line-1',
        productName: 'Juice',
        soldQuantity: 3,
        refundedQuantity: 0,
        taxAlreadyRefundedCents: 0,
        unitSellingPriceCents: 101,
        taxCents: 10,
        quantity: 1,
        restocked: true,
      },
    ]);
    expect(result).toMatchObject({
      subtotalCents: 101,
      taxCents: 3,
      amountCents: 104,
    });
  });
});
