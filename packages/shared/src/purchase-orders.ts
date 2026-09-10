import { z } from 'zod';

/**
 * Purchase orders. A PO is created from the reviewed buying list, sent to the
 * vendor (by email from the seller's own account, or marked as sent manually)
 * and later received, which posts `stock_received` inventory movements.
 */

export const purchaseOrderStatusSchema = z.enum([
  'draft',
  'sent',
  'partially_received',
  'received',
  'cancelled',
]);
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;

export const purchaseOrderSentViaSchema = z.enum(['email', 'manual']);
export type PurchaseOrderSentVia = z.infer<typeof purchaseOrderSentViaSchema>;

export const purchaseOrderLineInputSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1_000_000),
  unitCostCents: z.number().int().min(0).max(100_000_000).nullable(),
});
export type PurchaseOrderLineInput = z.infer<
  typeof purchaseOrderLineInputSchema
>;

export const purchaseOrderInputSchema = z.object({
  vendorId: z.string().uuid(),
  lines: purchaseOrderLineInputSchema.array().min(1).max(500),
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().max(5000).default(''),
  notes: z.string().trim().max(2000).default(''),
});
export type PurchaseOrderInput = z.infer<typeof purchaseOrderInputSchema>;

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  productName: string;
  barcode: string | null;
  vendorSku: string | null;
  quantity: number;
  unitCostCents: number | null;
  receivedQuantity: number;
}

export interface PurchaseOrder {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  vendorEmail: string | null;
  status: PurchaseOrderStatus;
  sentVia: PurchaseOrderSentVia | null;
  subject: string;
  message: string;
  notes: string;
  /** Random token embedded in the vendor link so only the recipient can open it. */
  accessToken: string;
  totalCents: number;
  lineCount: number;
  unitCount: number;
  sentAt: string | null;
  /** When the order was published to the SUMA cloud for the vendor portal. */
  publishedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseOrderLine[];
}

export interface PurchaseOrderSummary {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  status: PurchaseOrderStatus;
  totalCents: number;
  lineCount: number;
  unitCount: number;
  receivedUnitCount: number;
  sentAt: string | null;
  createdAt: string;
  /** Delivery state of the queued email, if the PO was sent by email. */
  emailStatus: OutboundEmailStatus | null;
  emailError: string | null;
}

export const receiveLineSchema = z.object({
  lineId: z.string().uuid(),
  quantity: z.number().int().min(0).max(1_000_000),
});
export const receivePurchaseOrderInputSchema = z.object({
  lines: receiveLineSchema.array().min(1),
  notes: z.string().trim().max(1000).optional(),
});
export type ReceivePurchaseOrderInput = z.infer<
  typeof receivePurchaseOrderInputSchema
>;

export const outboundEmailStatusSchema = z.enum(['pending', 'sent', 'failed']);
export type OutboundEmailStatus = z.infer<typeof outboundEmailStatusSchema>;

export interface EmailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  /** Content-ID used to embed inline images (e.g. `<img src="cid:...">`). */
  cid: string | null;
}

export interface OutboundEmail {
  id: string;
  purchaseOrderId: string | null;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: EmailAttachment[];
  status: OutboundEmailStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Google OAuth grant for XOAUTH2 SMTP; the refresh token is long-lived. */
export const gmailOAuthSchema = z.object({
  refreshToken: z.string().min(1).max(2000),
  accessToken: z.string().max(4000).nullable(),
  /** Unix ms when `accessToken` stops working. */
  expiresAt: z.number().int().nullable(),
});
export type GmailOAuth = z.infer<typeof gmailOAuthSchema>;

/** Seller-configured SMTP account used to send purchase orders. */
export const emailConfigSchema = z.object({
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().max(200),
  password: z.string().max(500),
  /** `password` = SMTP login; `gmail` = XOAUTH2 with `oauth`. */
  authType: z.enum(['password', 'gmail']).default('password'),
  oauth: gmailOAuthSchema.nullable().default(null),
  fromName: z.string().trim().min(1).max(100),
  fromAddress: z
    .string()
    .trim()
    .max(200)
    .refine((val) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val), {
      message: 'Invalid email address format',
    }),
  /** Copy every sent purchase order to this address (usually the seller). */
  ccSelf: z.boolean(),
});
export type EmailConfig = z.infer<typeof emailConfigSchema>;

export interface EmailConfigStatus {
  configured: boolean;
  encrypted: boolean;
  authType: EmailConfig['authType'] | null;
  /** The app ships with a Google OAuth client, so "Sign in with Google" works. */
  gmailAvailable: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  username: string | null;
  fromName: string | null;
  fromAddress: string | null;
  ccSelf: boolean;
  pendingCount: number;
  failedCount: number;
}

/** Well-known SMTP presets shown in the settings form. */
export const EMAIL_PRESETS = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false,
  },
  {
    id: 'custom',
    label: 'Other (custom SMTP)',
    host: '',
    port: 587,
    secure: false,
  },
] as const;

export const VENDOR_PORTAL_URL = 'https://vendorportal.sumasystems.com';

/** Vendor-only link: the token is random and never shown to other stores. */
export function purchaseOrderPortalUrl(order: {
  id: string;
  accessToken: string;
}): string {
  return `${VENDOR_PORTAL_URL}/orders/${order.id}?token=${order.accessToken}`;
}

export function purchaseOrderTotalCents(
  lines: ReadonlyArray<{ quantity: number; unitCostCents: number | null }>,
): number {
  return lines.reduce(
    (sum, line) => sum + line.quantity * (line.unitCostCents ?? 0),
    0,
  );
}

export function defaultPurchaseOrderSubject(
  storeName: string,
  number: string,
): string {
  return `Purchase order ${number} from ${storeName}`;
}

export function defaultPurchaseOrderMessage(vendorName: string): string {
  return `Hi ${vendorName},\n\nPlease find our purchase order below. Let us know if anything is out of stock or if prices have changed.\n\nThank you!`;
}
