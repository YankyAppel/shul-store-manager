import { z } from 'zod';

const line = z
  .object({
    productId: z.string().uuid().optional(),
    barcode: z.string().trim().min(1).max(100).optional(),
    quantity: z.number().int().positive().max(10000),
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
            quantity: z.number().int().positive().max(10000),
            barcodeUsed: z.string().trim().min(1).max(100).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const kioskCatalogResponseSchema = z.object({
  storeName: z.string(),
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
      barcodes: z.array(z.string()),
    }),
  ),
});
export type KioskPriceRequest = z.infer<typeof kioskPriceRequestSchema>;
export type KioskChargeRequest = z.infer<typeof kioskChargeRequestSchema>;

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
