import { z } from 'zod';

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, 'Expected an ISO datetime');

/** Scheduled sale price: while a row is active the product rings at the sale
 * price (either an explicit cents price or a percent off the base price).
 * When several overlap, the lowest resulting price wins. */
export const salePriceInputSchema = z
  .object({
    productId: z.string().uuid(),
    priceCents: z
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .nullable()
      .default(null),
    percentOffBps: z.number().int().min(1).max(9_999).nullable().default(null),
    startsAt: isoDateTime,
    endsAt: isoDateTime.nullable().default(null),
    label: z.string().trim().max(100).nullable().default(null),
  })
  .refine(
    (value) => (value.priceCents === null) !== (value.percentOffBps === null),
    'Set either a sale price or a percent off, not both',
  );
export type SalePriceInput = z.infer<typeof salePriceInputSchema>;

export const salePriceSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  priceCents: z.number().int().nullable(),
  percentOffBps: z.number().int().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  label: z.string().nullable(),
  createdAt: z.string(),
});
export type SalePrice = z.infer<typeof salePriceSchema>;

/** Lowest active sale wins; percent-off is computed on the base price. */
export function resolveSalePriceCents(
  baseCents: number,
  sales: SalePrice[],
  at: string,
): { priceCents: number; label: string | null } | null {
  let best: { priceCents: number; label: string | null } | null = null;
  for (const sale of sales) {
    if (sale.startsAt > at) continue;
    if (sale.endsAt !== null && sale.endsAt <= at) continue;
    const priceCents =
      sale.priceCents !== null
        ? sale.priceCents
        : Math.max(
            1,
            Math.round((baseCents * (10_000 - sale.percentOffBps!)) / 10_000),
          );
    if (priceCents >= baseCents) continue;
    if (best === null || priceCents < best.priceCents)
      best = { priceCents, label: sale.label };
  }
  return best;
}

export function unitPriceCentsOf(product: {
  sellingPriceCents: number;
  salePriceCents: number | null;
}): number {
  return product.salePriceCents ?? product.sellingPriceCents;
}
