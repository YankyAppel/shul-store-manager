import { z } from 'zod';
import { storeSettingsSchema, type StoreSettings } from './checkout.js';

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

/** Strict ISO 8601 UTC datetime validator. E.g. "2026-02-01T00:00:00.000Z" */
export const strictIsoUtcDateTimeSchema = z
  .string()
  .trim()
  .superRefine((val, ctx) => {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
        val,
      );
    if (!match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Must be a valid ISO 8601 UTC datetime string (e.g. 2026-02-01T00:00:00.000Z).',
      });
      return;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const min = Number(match[5]);
    const sec = Number(match[6]);
    const ms = match[7] ? Number(match[7].padEnd(3, '0')) : 0;

    const d = new Date(Date.UTC(year, month - 1, day, hour, min, sec, ms));
    if (
      Number.isNaN(d.getTime()) ||
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() + 1 !== month ||
      d.getUTCDate() !== day ||
      d.getUTCHours() !== hour ||
      d.getUTCMinutes() !== min ||
      d.getUTCSeconds() !== sec
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid calendar date or time.',
      });
    }
  });

export const statementOptionsSchema = z
  .object({
    range: statementDateRangeSchema,
    startDate: strictIsoUtcDateTimeSchema.nullable().optional(),
    endDate: strictIsoUtcDateTimeSchema.nullable().optional(),
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
      if (!Number.isNaN(start) && !Number.isNaN(end)) {
        if (start >= end) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Start date must be strictly before exclusive end date.',
            path: ['startDate'],
          });
        }
      }
    }
  });
export type StatementOptions = z.infer<typeof statementOptionsSchema>;

export const statementEntrySchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string(),
  entryType: ledgerEntryTypeSchema,
  notes: z.string(),
  relatedSaleId: z.string().uuid().nullable(),
  relatedSaleReceiptNumber: z.number().int().nullable(),
  relatedAccountPaymentId: z.string().uuid().nullable(),
  relatedPaymentReceiptNumber: z.number().int().nullable(),
  chargeCents: z.number().int().nonnegative().nullable(),
  paymentCents: z.number().int().nonnegative().nullable(),
  runningBalanceCents: z.number().int(),
});
export type StatementEntry = z.infer<typeof statementEntrySchema>;

export const customerStatementDataSchema = z.object({
  customer: z.object({
    id: z.string().uuid(),
    accountNumber: z.string(),
    accountBarcode: z.string().nullable(),
    name: z.string(),
    secondaryName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    address: z.string().nullable(),
    notes: z.string().nullable(),
    active: z.boolean(),
    blocked: z.boolean(),
    creditLimitCents: z.number().int().nullable(),
    effectiveCreditLimitCents: z.number().int(),
    currentBalanceCents: z.number().int(),
    availableCreditCents: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  settings: storeSettingsSchema,
  period: z.object({
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    label: z.string(),
  }),
  openingBalanceCents: z.number().int(),
  entries: z.array(statementEntrySchema),
  closingBalanceCents: z.number().int(),
  totalChargesCents: z.number().int().nonnegative(),
  totalPaymentsCents: z.number().int().nonnegative(),
  generatedAt: z.string(),
});
export type CustomerStatementData = z.infer<typeof customerStatementDataSchema>;
