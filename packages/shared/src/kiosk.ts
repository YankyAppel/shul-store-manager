import { z } from 'zod';
import { quantitySchema, storeLogoSchema } from './checkout.js';

const line = z
  .object({
    productId: z.string().uuid().optional(),
    barcode: z.string().trim().min(1).max(100).optional(),
    quantity: quantitySchema,
  })
  .strict()
  .refine(
    (x) => Boolean(x.productId || x.barcode),
    'productId or barcode is required',
  );
export const kioskPairRequestSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    name: z.string().trim().min(1).max(100),
    adminPin: z.string().regex(/^\d{4,12}$/),
  })
  .strict();
export const kioskPriceRequestSchema = z
  .object({ lines: z.array(line).min(1).max(500) })
  .strict();
export const kioskChargeRequestSchema = z
  .object({
    chargeReference: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    lines: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            quantity: quantitySchema,
            barcodeUsed: z.string().trim().min(1).max(100).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const kioskAdminVerifyRequestSchema = z
  .object({ pin: z.string().regex(/^\d{4,12}$/) })
  .strict();
export const kioskCatalogResponseSchema = z.object({
  storeName: z.string(),
  storeLogoDataUrl: storeLogoSchema.nullable().default(null),
  snapAccepted: z.boolean().default(false),
  wicAccepted: z.boolean().default(false),
  categories: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      secondaryName: z.string().nullable(),
    }),
  ),
  products: z.array(
    z.object({
      id: z.string().uuid(),
      categoryId: z.string().uuid(),
      name: z.string(),
      secondaryName: z.string().nullable(),
      priceCents: z.number().int().nonnegative(),
      barcodes: z.array(z.string()),
      soldBy: z.enum(['each', 'weight']).default('each'),
      unit: z.enum(['lb', 'oz', 'kg']).nullable().default(null),
      snapEligible: z.boolean().default(false),
      wicEligible: z.boolean().default(false),
    }),
  ),
});
export type KioskPriceRequest = z.infer<typeof kioskPriceRequestSchema>;
export type KioskChargeRequest = z.infer<typeof kioskChargeRequestSchema>;
export type KioskCatalog = z.infer<typeof kioskCatalogResponseSchema>;

export interface KioskSummary {
  id: string;
  name: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface KioskServerSettings {
  enabled: boolean;
  port: number;
  running: boolean;
  addresses: string[];
  kiosks: KioskSummary[];
}
