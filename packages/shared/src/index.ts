import { z } from 'zod';

const name = z.string().trim().min(1).max(200);
const optionalName = z.string().trim().max(200).nullable().optional();
const optionalImageId = z.string().uuid().nullable().optional();

export const categoryInputSchema = z.object({
  name,
  secondaryName: optionalName,
  imageId: optionalImageId,
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

export const productInputSchema = z.object({
  categoryId: z.string().uuid(),
  name,
  secondaryName: optionalName,
  imageId: optionalImageId,
  purchaseCostCents: z.number().int().min(0).max(100_000_000),
  sellingPriceCents: z.number().int().min(0).max(100_000_000),
  taxable: z.boolean(),
  lowStockThreshold: z.number().int().min(0).max(1_000_000),
  barcodes: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});
export type ProductInput = z.infer<typeof productInputSchema>;

export const movementReasonSchema = z.enum([
  'stock_received',
  'damaged',
  'customer_return',
  'manual_increase',
  'manual_decrease',
  'stock_count_correction',
  'sale',
]);
export type MovementReason = z.infer<typeof movementReasonSchema>;

export const inventoryMovementInputSchema = z
  .object({
    productId: z.string().uuid(),
    quantityChange: z
      .number()
      .int()
      .refine((value) => value !== 0, 'Quantity cannot be zero'),
    reason: movementReasonSchema,
    notes: z.string().trim().min(1).max(1000),
    deviceId: z.string().uuid().nullable().optional(),
    relatedSaleId: z.string().uuid().nullable().optional(),
    operationId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.reason === 'stock_received' && value.quantityChange < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Received stock must be positive',
        path: ['quantityChange'],
      });
    }
    if (value.reason === 'damaged' && value.quantityChange > -1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Damaged stock must reduce inventory',
        path: ['quantityChange'],
      });
    }
  });
export type InventoryMovementInput = z.infer<
  typeof inventoryMovementInputSchema
>;

export interface Category {
  id: string;
  name: string;
  secondaryName: string | null;
  imageId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  secondaryName: string | null;
  imageId: string | null;
  purchaseCostCents: number;
  sellingPriceCents: number;
  taxable: boolean;
  lowStockThreshold: number;
  active: boolean;
  stockQuantity: number;
  barcodes: Barcode[];
  createdAt: string;
  updatedAt: string;
}

export interface Barcode {
  id: string;
  value: string;
  kind: 'EXTERNAL' | 'CODE128_INTERNAL';
}
export interface InventoryMovement {
  id: string;
  productId: string;
  quantityChange: number;
  reason: MovementReason;
  notes: string;
  occurredAt: string;
}
export interface StoredImage {
  id: string;
  url: string;
  originalName: string;
  mimeType: string;
}

export interface StoreApi {
  categories: {
    list(includeInactive?: boolean): Promise<Category[]>;
    create(input: CategoryInput): Promise<Category>;
    update(id: string, input: CategoryInput): Promise<Category>;
    setActive(id: string, active: boolean): Promise<void>;
  };
  products: {
    list(includeInactive?: boolean): Promise<Product[]>;
    create(input: ProductInput): Promise<Product>;
    update(id: string, input: ProductInput): Promise<Product>;
    setActive(id: string, active: boolean): Promise<void>;
    generateInternalBarcode(): Promise<string>;
  };
  inventory: {
    addMovement(input: InventoryMovementInput): Promise<InventoryMovement>;
    list(productId: string): Promise<InventoryMovement[]>;
  };
  images: { choose(): Promise<StoredImage | null> };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred';
}
