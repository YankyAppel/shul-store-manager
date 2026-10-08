import { z } from 'zod';

/* Physical inventory counts and expiry tracking. */

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');

export const stockCountSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['open', 'applied', 'cancelled']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  notes: z.string().nullable(),
});
export type StockCount = z.infer<typeof stockCountSchema>;

export const stockCountLineSchema = z.object({
  countId: z.string().uuid(),
  productId: z.string().uuid(),
  productName: z.string(),
  /** Expected vs counted in the product's native units (milli-units for
   * weight products). Expected is snapshotted when the count finishes. */
  expectedUnits: z.number().int().nullable(),
  countedUnits: z.number().int(),
});
export type StockCountLine = z.infer<typeof stockCountLineSchema>;

export const expiringBatchSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  expiresOn: dateOnly,
  remainingUnits: z.number().int(),
  soldBy: z.enum(['each', 'weight']),
  unit: z.enum(['lb', 'oz', 'kg']).nullable(),
});
export type ExpiringBatch = z.infer<typeof expiringBatchSchema>;
