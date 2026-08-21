import { z } from 'zod';

export const paymentMethodSchema = z.enum(['cash', 'external_terminal']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export const storeSettingsSchema = z.object({
  storeName: z.string().trim().min(1).max(200),
  contactLines: z.array(z.string().trim().min(1).max(200)).max(4),
  currency: z.literal('USD'),
  taxRateBps: z.number().int().min(0).max(10000),
  pricesIncludeTax: z.boolean(),
  receiptFooter: z.string().trim().max(1000),
});
export type StoreSettings = z.infer<typeof storeSettingsSchema>;

export const checkoutLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().safe().positive().max(10000),
  barcodeUsed: z.string().trim().min(1).max(100).nullable(),
});
export type CheckoutLine = z.infer<typeof checkoutLineSchema>;
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
  ]),
});
export type CompleteSaleInput = z.infer<typeof completeSaleInputSchema>;

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
export interface SalePayment {
  method: PaymentMethod;
  amountCents: number;
  cashReceivedCents: number | null;
  changeDueCents: number | null;
  terminalReference: string | null;
  externalApproved: boolean | null;
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
  items: SaleItem[];
  payment: SalePayment;
}
export interface ReceiptData {
  sale: Sale;
  settings: StoreSettings;
}
