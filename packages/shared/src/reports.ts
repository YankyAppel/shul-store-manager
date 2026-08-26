import { z } from 'zod';

export interface BusinessDayRange {
  from: string;
  to: string;
}

export function businessDayRange(businessDate: string): BusinessDayRange {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (!match) throw new Error('Business date must use YYYY-MM-DD format.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(0);
  start.setHours(0, 0, 0, 0);
  start.setFullYear(year, month - 1, day);
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day
  )
    throw new Error('Business date is not a valid calendar date.');
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export const dailyReportInputSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  openingFloatCents: z.number().int().nonnegative().safe(),
});

export const dailyCloseInputSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  openingFloatCents: z.number().int().nonnegative().safe(),
  countedCashCents: z.number().int().nonnegative().safe(),
  notes: z.string().max(2000).optional().default(''),
});

const dailyReportSchema = z.object({
  rangeStart: z.string(),
  rangeEnd: z.string(),
  openingFloatCents: z.number().int().safe(),
  sales: z.object({
    saleCount: z.number().int().safe(),
    subtotalCents: z.number().int().safe(),
    taxCents: z.number().int().safe(),
    totalCents: z.number().int().safe(),
  }),
  refunded: z.object({
    count: z.number().int().safe(),
    totalCents: z.number().int().safe(),
  }),
  refunds: z.array(
    z.object({
      method: z.string(),
      refundCount: z.number().int().safe(),
      amountCents: z.number().int().safe(),
    }),
  ),
  voided: z.object({
    count: z.number().int().safe(),
    totalCents: z.number().int().safe(),
  }),
  tenders: z.array(
    z.object({
      tender: z.string(),
      saleCount: z.number().int().safe(),
      totalCents: z.number().int().safe(),
    }),
  ),
  cash: z.object({
    salesCents: z.number().int().safe(),
    receivedCents: z.number().int().safe(),
    changeGivenCents: z.number().int().safe(),
  }),
  accountPayments: z.array(
    z.object({
      method: z.string(),
      paymentCount: z.number().int().safe(),
      amountCents: z.number().int().safe(),
    }),
  ),
  receivables: z.object({
    debitsCents: z.number().int().safe(),
    creditsCents: z.number().int().safe(),
  }),
  cardTransactions: z.array(
    z.object({
      status: z.string(),
      transactionCount: z.number().int().safe(),
      amountCents: z.number().int().safe(),
    }),
  ),
  unresolvedCard: z.object({
    count: z.number().int().safe(),
    amountCents: z.number().int().safe(),
  }),
  channels: z.array(
    z.object({
      channel: z.string(),
      saleCount: z.number().int().safe(),
      totalCents: z.number().int().safe(),
    }),
  ),
  profit: z.object({
    costCents: z.number().int().safe(),
    netSalesCents: z.number().int().safe(),
    grossProfitCents: z.number().int().safe(),
  }),
  topItems: z.array(
    z.object({
      productId: z.string(),
      productName: z.string(),
      quantity: z.number().int().safe(),
      totalCents: z.number().int().safe(),
    }),
  ),
  inventoryMovements: z.array(
    z.object({
      reason: z.string(),
      movementCount: z.number().int().safe(),
      quantityChange: z.number().int().safe(),
    }),
  ),
  expectedCashCents: z.number().int().safe(),
});

export const dailyReportPrintInputSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  report: dailyReportSchema,
});

export interface DailyReportInput {
  from: string;
  to: string;
  openingFloatCents: number;
}

export interface DailyTenderTotal {
  tender: string;
  saleCount: number;
  totalCents: number;
}

export interface DailyAccountPaymentTotal {
  method: string;
  paymentCount: number;
  amountCents: number;
}

export interface DailyRefundTotal {
  method: string;
  refundCount: number;
  amountCents: number;
}

export interface DailyCardTransactionTotal {
  status: string;
  transactionCount: number;
  amountCents: number;
}

export interface DailyChannelTotal {
  channel: string;
  saleCount: number;
  totalCents: number;
}

export interface DailyTopItem {
  productId: string;
  productName: string;
  quantity: number;
  totalCents: number;
}

export interface DailyInventoryMovementTotal {
  reason: string;
  movementCount: number;
  quantityChange: number;
}

export interface DailyReport {
  rangeStart: string;
  rangeEnd: string;
  openingFloatCents: number;
  sales: {
    saleCount: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  };
  refunded: {
    count: number;
    totalCents: number;
  };
  refunds: DailyRefundTotal[];
  voided: {
    count: number;
    totalCents: number;
  };
  tenders: DailyTenderTotal[];
  cash: {
    salesCents: number;
    receivedCents: number;
    changeGivenCents: number;
  };
  accountPayments: DailyAccountPaymentTotal[];
  receivables: {
    debitsCents: number;
    creditsCents: number;
  };
  cardTransactions: DailyCardTransactionTotal[];
  unresolvedCard: {
    count: number;
    amountCents: number;
  };
  channels: DailyChannelTotal[];
  profit: {
    costCents: number;
    netSalesCents: number;
    grossProfitCents: number;
  };
  topItems: DailyTopItem[];
  inventoryMovements: DailyInventoryMovementTotal[];
  expectedCashCents: number;
}

export interface DailyClose {
  id: string;
  businessDate: string;
  rangeStart: string;
  rangeEnd: string;
  openingFloatCents: number;
  countedCashCents: number;
  expectedCashCents: number;
  overShortCents: number;
  report: DailyReport;
  notes: string;
  closedAt: string;
}
