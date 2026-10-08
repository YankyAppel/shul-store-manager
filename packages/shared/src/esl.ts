import { z } from 'zod';

/** Ink/e-paper shelf tag (ESL) integration. 'simulated' runs against an
 * in-memory access point for testing without hardware; 'openepaperlink'
 * talks to an OpenEPaperLink ESP32 access point over HTTP on the LAN. */
export const eslModeSchema = z.enum(['none', 'simulated', 'openepaperlink']);
export type EslMode = z.infer<typeof eslModeSchema>;

/** Tag MACs are uppercase hex, 12 or 16 chars (the AP emits 16). */
export const tagMacSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .regex(
        /^[0-9A-F]{12}([0-9A-F]{4})?$/,
        'Tag MAC must be 12 or 16 hex characters',
      ),
  );
export type TagMac = z.infer<typeof tagMacSchema>;

export const eslTagSchema = z.object({
  mac: tagMacSchema,
  alias: z.string().default(''),
  /** Hardware type id; the AP serves the display descriptor at
   * /tagtypes/<hex>.json (width/height). */
  hwType: z.number().int().min(0),
  batteryMv: z.number().int().nullable().default(null),
  rssi: z.number().int().nullable().default(null),
  lastSeenAt: z.string().nullable().default(null),
  /** Pending data transfers queued on the AP for this tag. */
  pending: z.number().int().min(0).default(0),
  widthPx: z.number().int().positive().nullable().default(null),
  heightPx: z.number().int().positive().nullable().default(null),
});
export type EslTag = z.infer<typeof eslTagSchema>;

export const eslProbeResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string().nullable().default(null),
  tagCount: z.number().int().nullable().default(null),
});
export type EslProbeResult = z.infer<typeof eslProbeResultSchema>;

export const eslStatusSchema = z.object({
  mode: eslModeSchema,
  connected: z.boolean(),
  baseUrl: z.string().nullable().default(null),
  tagCount: z.number().int().nullable().default(null),
  pendingPushes: z.number().int().min(0).default(0),
  error: z.string().nullable().default(null),
});
export type EslStatus = z.infer<typeof eslStatusSchema>;

export const priceTagPushStatusSchema = z.enum(['pending', 'synced', 'error']);
export type PriceTagPushStatus = z.infer<typeof priceTagPushStatusSchema>;

export const priceTagLinkSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  tagMac: tagMacSchema,
  tagType: z.number().int().min(0).nullable().default(null),
  pushStatus: priceTagPushStatusSchema,
  pushError: z.string().nullable().default(null),
  pushAttempts: z.number().int().min(0).default(0),
  lastPushedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PriceTagLink = z.infer<typeof priceTagLinkSchema>;

export const priceTagAssignInputSchema = z.object({
  productId: z.string().min(1),
  tagMac: tagMacSchema,
  tagType: z.number().int().min(0).nullable().default(null),
});
export type PriceTagAssignInput = z.infer<typeof priceTagAssignInputSchema>;
