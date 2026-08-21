import { z } from 'zod';
import type { StoreSettings } from './checkout.js';

const nameSchema = z.string().trim().min(1).max(200);
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

export const customerInputSchema = z.object({
  accountNumber: z.string().trim().min(1).max(50),
  accountBarcode: optionalText(100),
  name: nameSchema,
  secondaryName: optionalText(200),
  phone: optionalText(50),
  email: optionalEmail,
  address: optionalText(500),
  notes: optionalText(2000),
  creditLimitCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable()
    .optional(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

export interface Customer {
  id: string;
  accountNumber: string;
  accountBarcode: string | null;
  name: string;
  secondaryName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  blocked: boolean;
  creditLimitCents: number | null;
  effectiveCreditLimitCents: number;
  currentBalanceCents: number;
  availableCreditCents: number;
  createdAt: string;
  updatedAt: string;
}

export const ledgerEntryTypeSchema = z.enum([
  'sale_charge',
  'payment',
  'manual_debit_adjustment',
  'manual_credit_adjustment',
]);
export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>;

export interface CustomerLedgerEntry {
  id: string;
  operationId: string;
  customerId: string;
  amountCents: number;
  entryType: LedgerEntryType;
  occurredAt: string;
  relatedSaleId: string | null;
  relatedSaleReceiptNumber: number | null;
  relatedAccountPaymentId: string | null;
  relatedPaymentReceiptNumber: number | null;
  deviceId: string | null;
  notes: string;
  sequence: number;
  resultingBalanceCents: number;
}

export const recordAccountPaymentInputSchema = z.object({
  operationId: z.string().uuid(),
  customerId: z.string().uuid(),
  amountCents: z.number().int().safe().positive().max(100_000_000),
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
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type RecordAccountPaymentInput = z.infer<
  typeof recordAccountPaymentInputSchema
>;

export interface AccountPayment {
  id: string;
  operationId: string;
  receiptNumber: number;
  customerId: string;
  customerName: string;
  accountNumber: string;
  amountCents: number;
  method: 'cash' | 'external_terminal';
  cashReceivedCents: number | null;
  changeDueCents: number | null;
  terminalReference: string | null;
  externalApproved: boolean | null;
  previousBalanceCents: number;
  newBalanceCents: number;
  notes: string | null;
  createdAt: string;
}

export interface AccountPaymentReceiptData {
  payment: AccountPayment;
  settings: StoreSettings;
}

export const statementDateRangeSchema = z.enum([
  'last_30_days',
  'last_90_days',
  'all_activity',
  'custom',
]);
export type StatementDateRange = z.infer<typeof statementDateRangeSchema>;

export const statementOptionsSchema = z
  .object({
    range: statementDateRangeSchema,
    startDate: z.string().trim().nullable().optional(),
    endDate: z.string().trim().nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.range === 'custom') {
      if (!val.startDate || !val.endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Both start date and end date are required for a custom date range.',
          path: ['startDate'],
        });
        return;
      }
      const start = new Date(val.startDate).getTime();
      const end = new Date(val.endDate).getTime();
      if (Number.isNaN(start)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid start date format.',
          path: ['startDate'],
        });
      }
      if (Number.isNaN(end)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid end date format.',
          path: ['endDate'],
        });
      }
      if (!Number.isNaN(start) && !Number.isNaN(end) && start > end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Start date cannot be after end date.',
          path: ['startDate'],
        });
      }
    }
  });
export type StatementOptions = z.infer<typeof statementOptionsSchema>;

export interface StatementEntry {
  id: string;
  occurredAt: string;
  entryType: LedgerEntryType;
  notes: string;
  relatedSaleId: string | null;
  relatedSaleReceiptNumber: number | null;
  relatedAccountPaymentId: string | null;
  relatedPaymentReceiptNumber: number | null;
  chargeCents: number | null;
  paymentCents: number | null;
  runningBalanceCents: number;
}

export interface CustomerStatementData {
  customer: Customer;
  settings: StoreSettings;
  period: {
    startDate: string | null;
    endDate: string | null;
    label: string;
  };
  openingBalanceCents: number;
  entries: StatementEntry[];
  closingBalanceCents: number;
  totalChargesCents: number;
  totalPaymentsCents: number;
  generatedAt: string;
}
