import { describe, expect, it } from 'vitest';
import {
  kioskChargeRequestSchema,
  kioskPriceRequestSchema,
} from '@shul-store/shared';

const id = '11111111-1111-4111-8111-111111111111';
describe('kiosk API schemas', () => {
  it('accepts identifier and quantity only pricing input', () => {
    expect(
      kioskPriceRequestSchema.parse({ lines: [{ productId: id, quantity: 1 }] })
        .lines,
    ).toHaveLength(1);
  });
  it('rejects prices, names, totals and invalid quantities', () => {
    for (const line of [
      { productId: id, quantity: 1, priceCents: 1 },
      { productId: id, quantity: 1, name: 'forged' },
      { productId: id, quantity: 0 },
      { productId: id, quantity: 1.5 },
    ])
      expect(() => kioskPriceRequestSchema.parse({ lines: [line] })).toThrow();
    expect(() =>
      kioskChargeRequestSchema.parse({
        chargeReference: id,
        idempotencyKey: id,
        lines: [{ productId: id, quantity: 1, barcodeUsed: null }],
        totalCents: 1,
      }),
    ).toThrow();
  });
});
