import { z } from 'zod';

/**
 * Vendors and the automatic buying list.
 *
 * Vendors live in the shared SUMA vendor catalog (cloud) and are cached
 * locally so the buying list keeps working offline. A product can be linked to
 * several vendors; exactly one is "preferred" and receives the automatic
 * reorder suggestions. Suggested quantities resolve as:
 * product/vendor override → vendor product case size → vendor default → 1.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((val) => (val.length === 0 ? null : val))
    .nullable()
    .optional();

const optionalEmail = z
  .string()
  .trim()
  .max(200)
  .transform((val) => (val.length === 0 ? null : val))
  .refine((val) => val === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val), {
    message: 'Invalid email address format',
  })
  .nullable()
  .optional();

const positiveQty = z.number().int().min(1).max(1_000_000);

export const vendorStatusSchema = z.enum([
  'unverified',
  'verified',
  'suspended',
]);
export type VendorStatus = z.infer<typeof vendorStatusSchema>;

export const vendorInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: optionalEmail,
  phone: optionalText(50),
  website: optionalText(200),
  address: optionalText(500),
  notes: optionalText(2000),
  defaultReorderQty: positiveQty.nullable().optional(),
  accountNumber: optionalText(100),
  hideListPrice: z.boolean().optional(),
});
export type VendorInput = z.infer<typeof vendorInputSchema>;

export interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  notes: string | null;
  status: VendorStatus;
  /** The vendor has at least one login on the SUMA vendor portal. */
  hasAccount: boolean;
  /** Present in the shared cloud catalog (false while created offline). */
  shared: boolean;
  defaultReorderQty: number | null;
  accountNumber: string | null;
  hideListPrice: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A vendor row as returned by the shared catalog on sumasystems.com. */
export const catalogVendorSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  status: vendorStatusSchema,
  has_account: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CatalogVendor = z.infer<typeof catalogVendorSchema>;

export const catalogVendorProductSchema = z.object({
  id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  barcode: z.string().min(1).max(100),
  sku: z.string().nullable(),
  name: z.string().min(1).max(200),
  case_size: z.number().int().positive().nullable(),
  min_order_qty: z.number().int().positive().nullable(),
  price_cents: z.number().int().min(0).nullable(),
  updated_at: z.string(),
});
export type CatalogVendorProduct = z.infer<typeof catalogVendorProductSchema>;

export interface VendorProduct {
  id: string;
  vendorId: string;
  barcode: string;
  sku: string | null;
  name: string;
  caseSize: number | null;
  minOrderQty: number | null;
  priceCents: number | null;
  updatedAt: string;
}

export const productVendorLinkSchema = z.object({
  vendorId: z.string().uuid(),
  preferred: z.boolean(),
  /** Store-private negotiated unit cost; null = use the vendor's list price. */
  costCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  /** Per-product reorder quantity override for this vendor. */
  reorderQty: positiveQty.nullable().optional(),
  vendorSku: optionalText(100),
});
export type ProductVendorLinkInput = z.infer<typeof productVendorLinkSchema>;

export const productVendorLinksSchema = z
  .array(productVendorLinkSchema)
  .max(20)
  .superRefine((links, context) => {
    const ids = new Set<string>();
    for (const link of links) {
      if (ids.has(link.vendorId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Vendor listed twice',
        });
      ids.add(link.vendorId);
    }
    if (links.length > 0 && links.filter((l) => l.preferred).length !== 1)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one vendor must be preferred',
      });
  });

export interface ProductVendorLink {
  vendorId: string;
  vendorName: string;
  preferred: boolean;
  costCents: number | null;
  reorderQty: number | null;
  vendorSku: string | null;
}

export const reorderStatusSchema = z.enum(['open', 'dismissed', 'ordered']);
export type ReorderStatus = z.infer<typeof reorderStatusSchema>;

export interface BuyingListLine {
  id: string;
  productId: string;
  productName: string;
  barcode: string | null;
  vendorId: string;
  vendorSku: string | null;
  stockQuantity: number;
  lowStockThreshold: number;
  /** Quantity resolved from the override chain (or the manual override). */
  quantity: number;
  quantityOverride: number | null;
  /** Unit cost used for the estimate; null when no price is known. */
  unitCostCents: number | null;
  /** Vendor list price when known (hidden when the vendor is set to hide it). */
  listPriceCents: number | null;
  status: ReorderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VendorSummary extends Vendor {
  openLineCount: number;
  openQuantity: number;
  /** Sum of quantity × unit cost for lines with a known cost. */
  estimatedTotalCents: number;
  /** Open lines without any known cost. */
  unpricedLineCount: number;
  linkedProductCount: number;
}

export const buyingListLineUpdateSchema = z.object({
  quantityOverride: positiveQty.nullable().optional(),
  vendorId: z.string().uuid().optional(),
  status: z.enum(['open', 'dismissed']).optional(),
});
export type BuyingListLineUpdate = z.infer<typeof buyingListLineUpdateSchema>;

/** Resolve the suggested reorder quantity for one product/vendor pair. */
export function resolveReorderQuantity(input: {
  overrideQty: number | null;
  caseSize: number | null;
  minOrderQty: number | null;
  vendorDefaultQty: number | null;
}): number {
  const base =
    input.overrideQty ?? input.caseSize ?? input.vendorDefaultQty ?? 1;
  return Math.max(base, input.minOrderQty ?? 1);
}
