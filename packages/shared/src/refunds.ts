import { z } from 'zod';
import {
  quantitySchema,
  quantityToMilli,
  roundRatio,
} from './checkout.js';

export const refundMethodSchema = z.enum([
  'cash',
  'external_terminal',
  'integrated_card',
  'account',
]);
export type RefundMethod = z.infer<typeof refundMethodSchema>;

export const refundItemInputSchema = z.object({
  saleItemId: z.string().uuid(),
  quantity: quantitySchema,
  restocked: z.boolean(),
});
export type RefundItemInput = z.infer<typeof refundItemInputSchema>;

export const recordRefundInputSchema = z.object({
  operationId: z.string().uuid(),
  saleId: z.string().uuid(),
  items: z.array(refundItemInputSchema).min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
  terminalReference: z.string().trim().max(100).nullable().optional(),
  manualExternalTerminal: z.boolean().optional().default(false),
});
export type RecordRefundInput = z.infer<typeof recordRefundInputSchema>;

export interface RefundItem {
  id: string;
  saleItemId: string;
  productId: string;
  productName: string;
  quantity: number;
  restocked: boolean;
  subtotalCents: number;
  taxCents: number;
  amountCents: number;
}

export interface Refund {
  id: string;
  operationId: string;
  receiptNumber: number;
  saleId: string;
  method: RefundMethod;
  subtotalCents: number;
  taxCents: number;
  amountCents: number;
  terminalReference: string | null;
  chargeReference: string | null;
  processorRefundId: string | null;
  customerId: string | null;
  reason: string;
  createdAt: string;
  items: RefundItem[];
}

export interface RefundableSaleItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  refundedQuantity: number;
  remainingQuantity: number;
  unitSellingPriceCents: number;
  lineSubtotalCents: number;
  lineTotalCents: number;
  taxCents: number;
  subtotalRefundedCents: number;
  taxRefundedCents: number;
  soldBy?: import('./checkout.js').SoldBy | undefined;
  unit?: import('./checkout.js').WeightUnit | null | undefined;
}

export interface RefundableSale {
  sale: import('./checkout.js').Sale;
  method: RefundMethod;
  chargeReference: string | null;
  customerId: string | null;
  items: RefundableSaleItem[];
  refunds: Refund[];
}

export interface RefundCalculationLine {
  saleItemId: string;
  quantity: number;
  restocked: boolean;
  subtotalCents: number;
  taxCents: number;
  amountCents: number;
}

export interface RefundCalculation {
  lines: RefundCalculationLine[];
  subtotalCents: number;
  taxCents: number;
  amountCents: number;
}

export interface RefundTaxInput {
  saleItemTaxCents: number;
  soldQuantity: number;
  refundedQuantity: number;
  requestedQuantity: number;
  taxAlreadyRefundedCents: number;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function safeCents(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE)
    throw new Error(`${label} exceeds the supported safe integer range`);
  return Number(value);
}

/** Quantities may carry up to 3 decimals (weight items); compare in milli. */
function qtyMilli(value: number, label: string): bigint {
  if (!Number.isSafeInteger(Math.round(value * 1000)))
    throw new Error(`${label} exceeds the supported quantity range`);
  return quantityToMilli(value);
}

function sameQuantity(a: number, b: number): boolean {
  return (
    BigInt(Math.round(a * 1000)) - BigInt(Math.round(b * 1000)) === 0n
  );
}

export function refundableQuantity(
  soldQuantity: number,
  refundedQuantity: number,
): number {
  if (!(soldQuantity > 0))
    throw new Error('Sold quantity must be positive');
  if (!(refundedQuantity >= 0))
    throw new Error('Refunded quantity must be non-negative');
  if (
    qtyMilli(refundedQuantity, 'Refunded quantity') >
    qtyMilli(soldQuantity, 'Sold quantity')
  )
    throw new Error('Refunded quantity cannot exceed sold quantity');
  return (qtyMilli(soldQuantity, 'Sold quantity') -
    qtyMilli(refundedQuantity, 'Refunded quantity')) === 0n
    ? 0
    : Math.round((soldQuantity - refundedQuantity) * 1000) / 1000;
}

export function validateRefundQuantity(
  productName: string,
  soldQuantity: number,
  refundedQuantity: number,
  requestedQuantity: number,
): number {
  if (!(requestedQuantity > 0))
    throw new Error('Requested quantity must be positive');
  const remaining = refundableQuantity(soldQuantity, refundedQuantity);
  if (qtyMilli(requestedQuantity, 'Requested quantity') > qtyMilli(remaining, 'Remaining quantity')) {
    throw new Error(
      `Cannot refund ${requestedQuantity} of ${productName}; only ${remaining} unit(s) remain refundable.`,
    );
  }
  return Math.round((remaining - requestedQuantity) * 1000) / 1000;
}

export function calculateRefundTax(input: RefundTaxInput): number {
  if (!(input.soldQuantity > 0))
    throw new Error('Sold quantity must be positive');
  if (!(input.requestedQuantity > 0))
    throw new Error('Requested quantity must be positive');
  if (!(input.refundedQuantity >= 0))
    throw new Error('Refunded quantity must be non-negative');
  if (
    !Number.isSafeInteger(input.taxAlreadyRefundedCents) ||
    input.taxAlreadyRefundedCents < 0
  )
    throw new Error('Already-refunded tax must be a non-negative safe integer');
  const finalRefund = sameQuantity(
    input.refundedQuantity + input.requestedQuantity,
    input.soldQuantity,
  );
  if (finalRefund) {
    if (input.taxAlreadyRefundedCents > input.saleItemTaxCents)
      throw new Error('Already-refunded tax exceeds the sale line tax');
    return input.saleItemTaxCents - input.taxAlreadyRefundedCents;
  }
  const soldMilli = qtyMilli(input.soldQuantity, 'Sold quantity');
  const numerator =
    BigInt(input.saleItemTaxCents) *
    qtyMilli(input.requestedQuantity, 'Requested quantity');
  return safeCents((numerator + soldMilli / 2n) / soldMilli, 'Refund tax');
}

export interface RefundCalculationInput {
  saleItemId: string;
  productName: string;
  soldQuantity: number;
  saleLineSubtotalCents: number;
  saleLineTaxCents: number;
  saleLineTotalCents: number;
  refundedQuantity: number;
  subtotalAlreadyRefundedCents: number;
  taxAlreadyRefundedCents: number;
  quantity: number;
  restocked: boolean;
}

export function calculateRefund(
  lines: RefundCalculationInput[],
): RefundCalculation {
  if (lines.length === 0)
    throw new Error('At least one refund line is required');
  const seen = new Set<string>();
  let subtotal = 0n;
  let tax = 0n;
  const calculated = lines.map((line) => {
    if (seen.has(line.saleItemId))
      throw new Error('A sale line may appear only once in a refund');
    seen.add(line.saleItemId);
    validateRefundQuantity(
      line.productName,
      line.soldQuantity,
      line.refundedQuantity,
      line.quantity,
    );
    const fullyRefunded = sameQuantity(
      line.refundedQuantity + line.quantity,
      line.soldQuantity,
    );
    const nonNegativeFields = [
      ['Sale line subtotal', line.saleLineSubtotalCents],
      ['Sale line tax', line.saleLineTaxCents],
      ['Sale line total', line.saleLineTotalCents],
      ['Already-refunded subtotal', line.subtotalAlreadyRefundedCents],
      ['Already-refunded tax', line.taxAlreadyRefundedCents],
    ] as const;
    for (const [label, value] of nonNegativeFields) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    if (
      BigInt(line.saleLineSubtotalCents) + BigInt(line.saleLineTaxCents) >
      BigInt(line.saleLineTotalCents)
    )
      throw new Error('Sale line subtotal and tax exceed the line total');
    if (fullyRefunded) {
      if (
        line.subtotalAlreadyRefundedCents > line.saleLineSubtotalCents ||
        line.taxAlreadyRefundedCents > line.saleLineTaxCents
      )
        throw new Error('Cumulative refund exceeds the sale line allocation');
    }
    const qtyRequestedMilli = qtyMilli(line.quantity, 'Refund quantity');
    const qtySoldMilli = qtyMilli(line.soldQuantity, 'Sold quantity');
    const lineSubtotal = fullyRefunded
      ? line.saleLineSubtotalCents - line.subtotalAlreadyRefundedCents
      : roundRatio(
          BigInt(line.saleLineSubtotalCents) * qtyRequestedMilli,
          qtySoldMilli,
        );
    const lineTax = fullyRefunded
      ? line.saleLineTaxCents - line.taxAlreadyRefundedCents
      : roundRatio(
          BigInt(line.saleLineTaxCents) * qtyRequestedMilli,
          qtySoldMilli,
        );
    const cumulativeQuantity =
      qtyMilli(line.refundedQuantity, 'Refunded quantity') +
      qtyRequestedMilli;
    const cumulativeSubtotal =
      BigInt(line.subtotalAlreadyRefundedCents) + BigInt(lineSubtotal);
    const cumulativeTax =
      BigInt(line.taxAlreadyRefundedCents) + BigInt(lineTax);
    const lineAmount = BigInt(lineSubtotal) + BigInt(lineTax);
    const cumulativeAmount = cumulativeSubtotal + cumulativeTax;
    if (cumulativeQuantity > qtySoldMilli)
      throw new Error('Cumulative refund quantity exceeds the sale line');
    if (cumulativeSubtotal > BigInt(line.saleLineSubtotalCents))
      throw new Error('Cumulative refund subtotal exceeds the sale line');
    if (cumulativeTax > BigInt(line.saleLineTaxCents))
      throw new Error('Cumulative refund tax exceeds the sale line');
    if (cumulativeAmount > BigInt(line.saleLineTotalCents))
      throw new Error('Cumulative refund amount exceeds the sale line');
    subtotal += BigInt(lineSubtotal);
    tax += BigInt(lineTax);
    return {
      saleItemId: line.saleItemId,
      quantity: line.quantity,
      restocked: line.restocked,
      subtotalCents: lineSubtotal,
      taxCents: lineTax,
      amountCents: safeCents(lineAmount, 'Refund line amount'),
    };
  });
  const subtotalCents = safeCents(subtotal, 'Refund subtotal');
  const taxCents = safeCents(tax, 'Refund tax');
  const amountCents = safeCents(subtotal + tax, 'Refund amount');
  if (amountCents <= 0) throw new Error('Refund amount must be positive');
  return { lines: calculated, subtotalCents, taxCents, amountCents };
}
