import { describe, expect, it } from 'vitest';
import {
  decodeWeighBarcode,
  ean13CheckDigit,
  encodeWeighBarcode,
  isEan13,
  renderEan13Svg,
} from '../src/weigh-barcode.js';
import { resolveSalePriceCents, salePriceSchema } from '../src/pricing.js';

describe('weigh barcode codec', () => {
  it('computes the EAN-13 check digit', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(ean13CheckDigit('020001201234')).toBe(7);
  });

  it('round-trips a price-embedded label', () => {
    const digits = encodeWeighBarcode(12345, { priceCents: 1099 });
    expect(digits).toMatch(/^02\d{11}$/);
    expect(digits.slice(2, 7)).toBe('12345');
    expect(isEan13(digits)).toBe(true);
    const decoded = decodeWeighBarcode(digits, 'price');
    expect(decoded).toEqual({ mode: 'price', plu: 12345, priceCents: 1099 });
  });

  it('round-trips a weight-embedded label', () => {
    const digits = encodeWeighBarcode(777, { milliQty: 2350 });
    expect(digits.slice(2, 7)).toBe('00777');
    expect(digits.slice(7, 12)).toBe('02350');
    const decoded = decodeWeighBarcode(digits, 'weight');
    expect(decoded).toEqual({ mode: 'weight', plu: 777, milliQty: 2350 });
  });

  it('rejects wrong prefix, bad check digit, and non-digits', () => {
    const good = encodeWeighBarcode(1, { priceCents: 500 });
    expect(decodeWeighBarcode(good, 'price')?.plu).toBe(1);
    expect(decodeWeighBarcode(`03${good.slice(2)}`, 'price')).toBeNull();
    const badCheck = `${good.slice(0, 12)}${(Number(good.at(-1)) + 1) % 10}`;
    expect(decodeWeighBarcode(badCheck, 'price')).toBeNull();
    expect(decodeWeighBarcode('02ABC56789012', 'price')).toBeNull();
    expect(decodeWeighBarcode('12345', 'price')).toBeNull();
  });

  it('renders an SVG barcode with the human-readable digits', () => {
    const svg = renderEan13Svg(encodeWeighBarcode(42, { priceCents: 250 }));
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });
});

describe('sale price resolution', () => {
  const base = 1000;
  const sale = salePriceSchema.parse({
    id: 'a7b9c8d4-0000-4000-8000-000000000001',
    productId: 'a7b9c8d4-0000-4000-8000-000000000002',
    priceCents: 799,
    percentOffBps: null,
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-10-10T00:00:00.000Z',
    label: 'Sale',
    createdAt: '2026-09-30T00:00:00.000Z',
  });

  it('applies an active fixed-price sale', () => {
    expect(
      resolveSalePriceCents(base, [sale], '2026-10-05T00:00:00.000Z')
        ?.priceCents,
    ).toBe(799);
  });

  it('ignores a sale before it starts and after it ends', () => {
    expect(
      resolveSalePriceCents(base, [sale], '2026-09-30T23:59:00.000Z'),
    ).toBeNull();
    expect(
      resolveSalePriceCents(base, [sale], '2026-10-10T00:00:00.000Z'),
    ).toBeNull();
  });

  it('treats a null endsAt as open-ended', () => {
    const open = { ...sale, endsAt: null };
    expect(
      resolveSalePriceCents(base, [open], '2027-01-01T00:00:00.000Z')
        ?.priceCents,
    ).toBe(799);
  });

  it('resolves percent-off to a rounded cent price', () => {
    const percent = { ...sale, priceCents: null, percentOffBps: 2500 };
    expect(
      resolveSalePriceCents(999, [percent], '2026-10-05T00:00:00.000Z')
        ?.priceCents,
    ).toBe(749);
  });

  it('returns the lowest of overlapping active sales', () => {
    const cheaper = {
      ...sale,
      id: 'a7b9c8d4-0000-4000-8000-000000000003',
      priceCents: 599,
    };
    expect(
      resolveSalePriceCents(base, [sale, cheaper], '2026-10-05T00:00:00.000Z')
        ?.priceCents,
    ).toBe(599);
  });
});
