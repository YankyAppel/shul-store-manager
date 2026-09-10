import { z } from 'zod';

export const paymentMethodSchema = z.enum([
  'cash',
  'external_terminal',
  'account',
  'integrated_card',
]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const receiptPaperWidthMmSchema = z.union([
  z.literal(58),
  z.literal(80),
]);
export type ReceiptPaperWidthMm = z.infer<typeof receiptPaperWidthMmSchema>;

const optionalPrinterNameSchema = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

/**
 * Store logos are kept as `data:` URLs inside store_settings so the bytes sync
 * to the cloud with the settings payload (the images table never leaves the
 * device) and can be embedded directly in receipt/email HTML.
 */
export const storeLogoSchema = z
  .string()
  .max(2_000_000)
  .refine(
    (value) =>
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value),
    { message: 'Logo must be a PNG, JPEG or WebP image' },
  );

export function parseImageDataUrl(
  value: string | null,
): { mimeType: string; base64: string } | null {
  if (!value) return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
    value,
  );
  if (!match) return null;
  return { mimeType: match[1]!, base64: match[2]! };
}

export const storeSettingsSchema = z.object({
  storeName: z.string().trim().min(1).max(200),
  contactLines: z.array(z.string().trim().min(1).max(200)).max(4),
  currency: z.literal('USD'),
  taxRateBps: z.number().int().min(0).max(10000),
  pricesIncludeTax: z.boolean(),
  receiptFooter: z.string().trim().max(1000),
  customerAccountsEnabled: z.boolean().default(true),
  defaultCreditLimitCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .default(50_000),
  allowCustomerCredit: z.boolean().default(false),
  statementFooter: z.string().trim().max(1000).default(''),
  overdueDays: z.number().int().min(0).max(365).default(30),
  receiptPrinterName: optionalPrinterNameSchema,
  receiptPaperWidthMm: receiptPaperWidthMmSchema.default(80),
  labelPrinterName: optionalPrinterNameSchema,
  defaultLabelTemplate: z
    .enum(['thermal_40x30', 'thermal_57x32', 'letter_avery_5160'])
    .default('thermal_40x30'),
  cardProcessingEnabled: z.boolean().default(false),
  cardProcessorId: z.string().nullable().default(null),
  logoDataUrl: storeLogoSchema.nullable().default(null),
  /** Set once the onboarding store-profile wizard has run (or been skipped). */
  profileCompleted: z.boolean().default(false),
});
export type StoreSettings = z.infer<typeof storeSettingsSchema>;

/** Processor ids the onboarding wizard can pick. */
export const cardProcessorChoiceSchema = z.enum([
  'cardknox-bbpos',
  'usaepay-payment-engine',
  'simulated',
]);
export type CardProcessorChoice = z.infer<typeof cardProcessorChoiceSchema>;

/** Inputs the post-sign-up store profile wizard collects. */
export const storeProfileInputSchema = z.object({
  storeName: z.string().trim().min(1).max(200),
  addressLines: z.array(z.string().trim().min(1).max(200)).max(2),
  phone: z.string().trim().max(200),
  email: z.union([z.literal(''), z.string().trim().email().max(200)]),
  receiptFooter: z.string().trim().max(1000),
  logoDataUrl: storeLogoSchema.nullable(),
  orderFromName: z.string().trim().max(100),
  orderCcSelf: z.boolean(),
  cardProcessorId: cardProcessorChoiceSchema.nullable().default(null),
});
export type StoreProfileInput = z.infer<typeof storeProfileInputSchema>;

export const integrationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email().max(320),
  processor: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).default(''),
});
export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;

/** A subscription plan offered during onboarding billing. */
export interface StorePlan {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  interval: 'month' | 'year';
}

export interface StorePlansResult {
  plans: StorePlan[];
  /** True when the account already has an active subscription. */
  active: boolean;
  status: string;
  /** False when the site lacks Stripe keys — the step shows a skip notice. */
  billingConfigured: boolean;
}

/** Response for mounting Stripe embedded checkout in the app. */
export interface EmbeddedCheckoutPayload {
  clientSecret: string;
  publishableKey: string;
  plan: StorePlan;
}

const httpsUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((value) => isHttpsUpdateFeedUrl(value), {
    message: 'Update feed URL must use HTTPS',
  });

export function isHttpsUpdateFeedUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export const deviceSettingsSchema = z.object({
  updateFeedUrl: z
    .union([httpsUrlSchema, z.literal('')])
    .nullable()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null))
    .default(null),
  automaticUpdatesEnabled: z.boolean().default(true),
  idleLockMinutes: z.number().int().min(0).max(1440).default(5),
  staffModeEnabled: z.boolean().default(false),
  explainDismissals: z
    .array(z.string().trim().min(1).max(100))
    .max(1000)
    .default([]),
});
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;

export const processorConfigInputSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, 'Processor configuration must be valid JSON')
  .nullable();
export type ProcessorConfigInput = z.infer<typeof processorConfigInputSchema>;

export const checkoutLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().safe().positive().max(10000),
  barcodeUsed: z.string().trim().min(1).max(100).nullable(),
});
export type CheckoutLine = z.infer<typeof checkoutLineSchema>;

export const initiateChargeInputSchema = z.object({
  chargeReference: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  lines: z.array(checkoutLineSchema).min(1).max(500),
});
export type InitiateChargeInput = z.infer<typeof initiateChargeInputSchema>;

export const getChargeStatusInputSchema = z.string().uuid();

export const completeSaleInputSchema = z.object({
  completionKey: z.string().uuid(),
  lines: z.array(checkoutLineSchema).min(1).max(500),
  payment: z.discriminatedUnion('method', [
    z.object({
      method: z.literal('cash'),
      cashReceivedCents: z.number().int().safe().nonnegative(),
    }),
    z.object({
      method: z.literal('external_terminal'),
      approved: z.literal(true),
      terminalReference: z.string().trim().max(100).nullable(),
    }),
    z.object({
      method: z.literal('account'),
      customerId: z.string().uuid(),
      confirmed: z.literal(true),
    }),
    z.object({
      method: z.literal('integrated_card'),
      chargeReference: z.string().uuid(),
    }),
  ]),
});
export type CompleteSaleInput = z.infer<typeof completeSaleInputSchema>;

export const cartSnapshotLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().safe().positive().max(10000),
  barcodeUsed: z.string().trim().min(1).max(100).nullable(),
  productName: z.string(),
  secondaryName: z.string().nullable(),
  unitSellingPriceCents: z.number().int().safe().nonnegative(),
  unitPurchaseCostCents: z.number().int().safe().nonnegative(),
  taxable: z.boolean(),
  unitPriceCents: z.number().int().safe().nonnegative(),
  subtotalCents: z.number().int().safe().nonnegative(),
  taxCents: z.number().int().safe().nonnegative(),
  totalCents: z.number().int().safe().nonnegative(),
});

export const cartSnapshotSchema = z.object({
  lines: z.array(cartSnapshotLineSchema).min(1).max(500),
  totals: z.object({
    subtotalCents: z.number().int().safe().nonnegative(),
    taxCents: z.number().int().safe().nonnegative(),
    totalCents: z.number().int().safe().nonnegative(),
    lines: z.any().optional(), // calculateCart includes lines but we only need totals here
  }),
});

export type CartSnapshotLine = z.infer<typeof cartSnapshotLineSchema>;
export type CartSnapshot = z.infer<typeof cartSnapshotSchema>;

export interface CartProduct {
  id: string;
  name: string;
  secondaryName: string | null;
  sellingPriceCents: number;
  taxable: boolean;
  stockQuantity: number;
  active: boolean;
}
export interface CalculatedLine {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
export interface CartTotals {
  lines: CalculatedLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_CENTS)
    throw new Error(`${label} exceeds the supported safe integer range`);
  return Number(value);
}
function safeBigInt(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
  return BigInt(value);
}

/** Tax rounds to the nearest cent, with exact half cents rounded upward. */
export function roundRatio(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n || denominator <= 0n)
    throw new Error('Invalid financial ratio');
  return safeNumber(
    (numerator + denominator / 2n) / denominator,
    'Rounded financial value',
  );
}

export function calculateCart(
  lines: Array<{ product: CartProduct; quantity: number }>,
  settings: Pick<StoreSettings, 'taxRateBps' | 'pricesIncludeTax'>,
): CartTotals {
  const rate = safeBigInt(settings.taxRateBps, 'Tax rate');
  if (rate > 10000n) throw new Error('Tax rate is out of range');
  let subtotal = 0n;
  let tax = 0n;
  let total = 0n;
  const calculated = lines.map(({ product, quantity }) => {
    const price = safeBigInt(product.sellingPriceCents, 'Unit price');
    const count = safeBigInt(quantity, 'Quantity');
    if (count < 1n) throw new Error('Quantity must be a positive integer');
    const displayedBig = price * count;
    const displayed = safeNumber(displayedBig, 'Line displayed amount');
    const taxCents = product.taxable
      ? settings.pricesIncludeTax
        ? roundRatio(displayedBig * rate, 10000n + rate)
        : roundRatio(displayedBig * rate, 10000n)
      : 0;
    const subtotalCents = settings.pricesIncludeTax
      ? displayed - taxCents
      : displayed;
    const totalCents = settings.pricesIncludeTax
      ? displayed
      : safeNumber(displayedBig + BigInt(taxCents), 'Line total');
    subtotal += BigInt(subtotalCents);
    tax += BigInt(taxCents);
    total += BigInt(totalCents);
    safeNumber(subtotal, 'Cart subtotal');
    safeNumber(tax, 'Cart tax');
    safeNumber(total, 'Cart total');
    return {
      productId: product.id,
      quantity,
      unitPriceCents: product.sellingPriceCents,
      subtotalCents,
      taxCents,
      totalCents,
    };
  });
  return {
    lines: calculated,
    subtotalCents: safeNumber(subtotal, 'Cart subtotal'),
    taxCents: safeNumber(tax, 'Cart tax'),
    totalCents: safeNumber(total, 'Cart total'),
  };
}

export function parseUsdToCents(input: string): number {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(input.trim());
  if (!match)
    throw new Error('Enter a valid amount with at most two decimal places');
  const dollars = BigInt(match[1]!);
  const cents = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return safeNumber(dollars * 100n + cents, 'Cash amount');
}

export function calculateCashChange(
  amountDueCents: number,
  cashReceivedCents: number,
): number {
  const due = safeBigInt(amountDueCents, 'Amount due');
  const received = safeBigInt(cashReceivedCents, 'Cash received');
  if (received < due) throw new Error('Cash received is less than amount due');
  return safeNumber(received - due, 'Cash change');
}

export function formatMoneyCents(cents: number): string {
  const isNegative = cents < 0;
  const absoluteCents = Math.abs(cents);
  const dollars = Math.floor(absoluteCents / 100);
  const remainingCents = absoluteCents % 100;
  const formatted = `$${dollars.toLocaleString('en-US')}.${remainingCents.toString().padStart(2, '0')}`;
  return isNegative ? `-${formatted}` : formatted;
}

export function formatCustomerBalance(cents: number): string {
  if (cents > 0) return `Amount owed: ${formatMoneyCents(cents)}`;
  if (cents < 0) return `Customer credit: ${formatMoneyCents(Math.abs(cents))}`;
  return 'Settled ($0.00)';
}

export interface SaleItem {
  id: string;
  productId: string;
  productName: string;
  secondaryName: string | null;
  barcodeUsed: string | null;
  quantity: number;
  unitSellingPriceCents: number;
  unitPurchaseCostCents: number;
  taxable: boolean;
  taxCents: number;
  lineSubtotalCents: number;
  lineTotalCents: number;
}

export interface SaleCustomerSnapshot {
  id: string;
  name: string;
  accountNumber: string;
  previousBalanceCents: number;
  newBalanceCents: number;
}

export interface SalePayment {
  method: PaymentMethod;
  amountCents: number;
  cashReceivedCents: number | null;
  changeDueCents: number | null;
  terminalReference: string | null;
  externalApproved: boolean | null;
  customerId?: string | null;
  customerName?: string | null;
  accountNumber?: string | null;
  previousBalanceCents?: number | null;
  newBalanceCents?: number | null;
  chargeReference?: string | null;
  processorTransactionId?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
}

export interface Sale {
  id: string;
  receiptNumber: number;
  status:
    'open' | 'awaiting_payment' | 'paid' | 'completed' | 'voided' | 'refunded';
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
  completedAt: string | null;
  channel: 'manager' | 'kiosk';
  kioskId: string | null;
  items: SaleItem[];
  payment: SalePayment;
  customer: SaleCustomerSnapshot | null;
}

export interface ReceiptData {
  sale: Sale;
  settings: StoreSettings;
}
