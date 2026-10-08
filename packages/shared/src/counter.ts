import { z } from 'zod';
import { quantitySchema } from './checkout.js';

/* Counter operations: parked (suspended) sales, checkout quick keys, and
 * cash drawer movements that feed the daily close. */

export const suspendedCartLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: quantitySchema,
  barcodeUsed: z.string().trim().min(1).max(100).nullable().default(null),
  /** Fixed line price carried by a scale-printed '02' barcode. */
  priceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable()
    .default(null),
});

export const suspendSaleInputSchema = z.object({
  label: z.string().trim().max(100).nullable().default(null),
  customerId: z.string().uuid().nullable().default(null),
  lines: z.array(suspendedCartLineSchema).min(1).max(500),
});
export type SuspendSaleInput = z.infer<typeof suspendSaleInputSchema>;
export type SuspendedCartLine = z.infer<typeof suspendedCartLineSchema>;

export const suspendedSaleSchema = z.object({
  id: z.string().uuid(),
  label: z.string().nullable(),
  customerId: z.string().nullable(),
  lines: z.array(suspendedCartLineSchema),
  createdAt: z.string(),
});
export type SuspendedSale = z.infer<typeof suspendedSaleSchema>;

export const quickKeySchema = z.object({
  productId: z.string().uuid(),
  position: z.number().int().min(0),
});
export type QuickKey = z.infer<typeof quickKeySchema>;

export const cashMovementKindSchema = z.enum(['pay_in', 'pay_out', 'drop']);
export type CashMovementKind = z.infer<typeof cashMovementKindSchema>;

export const cashMovementInputSchema = z.object({
  kind: cashMovementKindSchema,
  amountCents: z.number().int().min(1).max(100_000_000),
  reason: z.string().trim().min(1).max(200),
});
export type CashMovementInput = z.infer<typeof cashMovementInputSchema>;

export const cashMovementSchema = z.object({
  id: z.string().uuid(),
  kind: cashMovementKindSchema,
  amountCents: z.number().int(),
  reason: z.string(),
  createdAt: z.string(),
});
export type CashMovement = z.infer<typeof cashMovementSchema>;

/** Result of a barcode scan at checkout: either a normal product hit or a
 * weigh-embedded EAN-13 carrying its own price/quantity. */
export interface BarcodeLookup {
  product: import('./index.js').Product;
  weigh: {
    mode: 'price' | 'weight';
    plu: number;
    priceCents: number | null;
    milliQty: number | null;
  } | null;
}
