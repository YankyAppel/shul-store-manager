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
        saleLineSubtotalCents: 303,
        saleLineTaxCents: 10,
        saleLineTotalCents: 313,
        refundedQuantity: 0,
        subtotalAlreadyRefundedCents: 0,
        taxAlreadyRefundedCents: 0,
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

  it('refunds the immutable tax-inclusive line total without adding tax twice', () => {
    expect(
      calculateRefund([
        {
          saleItemId: 'line-1',
          productName: 'Juice',
          soldQuantity: 1,
          saleLineSubtotalCents: 100,
          saleLineTaxCents: 10,
          saleLineTotalCents: 110,
          refundedQuantity: 0,
          subtotalAlreadyRefundedCents: 0,
          taxAlreadyRefundedCents: 0,
          quantity: 1,
          restocked: false,
        },
      ]).amountCents,
    ).toBe(110);
  });

  it('preserves zero-tax and tax-exclusive line allocations', () => {
    expect(
      calculateRefund([
        {
          saleItemId: 'zero-tax',
          productName: 'Water',
          soldQuantity: 2,
          saleLineSubtotalCents: 200,
          saleLineTaxCents: 0,
          saleLineTotalCents: 200,
          refundedQuantity: 0,
          subtotalAlreadyRefundedCents: 0,
          taxAlreadyRefundedCents: 0,
          quantity: 1,
          restocked: true,
        },
        {
          saleItemId: 'tax-exclusive',
          productName: 'Bread',
          soldQuantity: 1,
          saleLineSubtotalCents: 100,
          saleLineTaxCents: 18,
          saleLineTotalCents: 118,
          refundedQuantity: 0,
          subtotalAlreadyRefundedCents: 0,
          taxAlreadyRefundedCents: 0,
          quantity: 1,
          restocked: true,
        },
      ]).amountCents,
    ).toBe(218);
  });

  it('assigns partial allocation remainders to the final unit', () => {
    const line = {
      saleItemId: 'line-1',
      productName: 'Juice',
      soldQuantity: 3,
      saleLineSubtotalCents: 100,
      saleLineTaxCents: 10,
      saleLineTotalCents: 110,
      restocked: true,
    };
    const first = calculateRefund([
      {
        ...line,
        refundedQuantity: 0,
        subtotalAlreadyRefundedCents: 0,
        taxAlreadyRefundedCents: 0,
        quantity: 1,
      },
    ]);
    const second = calculateRefund([
      {
        ...line,
        refundedQuantity: 1,
        subtotalAlreadyRefundedCents: first.subtotalCents,
        taxAlreadyRefundedCents: first.taxCents,
        quantity: 1,
      },
    ]);
    const third = calculateRefund([
      {
        ...line,
        refundedQuantity: 2,
        subtotalAlreadyRefundedCents:
          first.subtotalCents + second.subtotalCents,
        taxAlreadyRefundedCents: first.taxCents + second.taxCents,
        quantity: 1,
      },
    ]);
    expect(first.subtotalCents + second.subtotalCents + third.subtotalCents).toBe(
      100,
    );
    expect(first.taxCents + second.taxCents + third.taxCents).toBe(10);
    expect(third.subtotalCents).toBe(34);
    expect(third.taxCents).toBe(4);
    expect(() =>
      calculateRefund([
        {
          ...line,
          refundedQuantity: 3,
          subtotalAlreadyRefundedCents: 100,
          taxAlreadyRefundedCents: 10,
          quantity: 1,
        },
      ]),
    ).toThrow(/only 0 unit/);
  });
});
