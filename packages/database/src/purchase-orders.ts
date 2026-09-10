import { randomBytes, randomUUID } from 'node:crypto';
import {
  emailConfigSchema,
  purchaseOrderInputSchema,
  purchaseOrderTotalCents,
  receivePurchaseOrderInputSchema,
  type EmailAttachment,
  type EmailConfig,
  type EmailConfigStatus,
  type OutboundEmail,
  type OutboundEmailStatus,
  type PurchaseOrder,
  type PurchaseOrderInput,
  type PurchaseOrderLine,
  type PurchaseOrderSentVia,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
  type ReceivePurchaseOrderInput,
  type SecretStore,
} from '@shul-store/shared';
import type { SqliteDatabase } from './sqlite.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const int = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** Called for every received line; the owner posts the inventory movement. */
export type ReceiveMovementSink = (input: {
  productId: string;
  quantity: number;
  notes: string;
}) => void;

function mapLine(row: Row): PurchaseOrderLine {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    productName: String(row.product_name),
    barcode: text(row.barcode),
    vendorSku: text(row.vendor_sku),
    quantity: Number(row.quantity),
    unitCostCents: int(row.unit_cost_cents),
    receivedQuantity: Number(row.received_quantity),
  };
}

function mapEmail(row: Row): OutboundEmail {
  let attachments: EmailAttachment[] = [];
  try {
    attachments = JSON.parse(
      String(row.attachments_json ?? '[]'),
    ) as EmailAttachment[];
  } catch {
    attachments = [];
  }
  return {
    id: String(row.id),
    purchaseOrderId: text(row.purchase_order_id),
    to: String(row.to_address),
    subject: String(row.subject),
    textBody: String(row.text_body),
    htmlBody: String(row.html_body),
    attachments,
    status: String(row.status) as OutboundEmailStatus,
    attempts: Number(row.attempts),
    lastError: text(row.last_error),
    createdAt: String(row.created_at),
    sentAt: text(row.sent_at),
  };
}

/** Mutations must run inside a StoreDatabase transaction (they don't open their own). */
export class PurchaseOrderStore {
  constructor(
    private readonly connection: SqliteDatabase,
    private readonly secretStore: SecretStore,
  ) {}

  private nextNumber(): string {
    const row = this.connection
      .prepare('SELECT COUNT(*) AS count FROM purchase_orders')
      .get() as Row;
    const sequence = Number(row.count ?? 0) + 1;
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `PO-${stamp}-${sequence.toString().padStart(3, '0')}`;
  }

  get(id: string): PurchaseOrder {
    const order = this.find(id);
    if (!order) throw new Error('Purchase order not found');
    return order;
  }

  find(id: string): PurchaseOrder | null {
    const row = this.connection
      .prepare('SELECT * FROM purchase_orders WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) return null;
    const lines = (
      this.connection
        .prepare(
          'SELECT * FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY position',
        )
        .all(id) as Row[]
    ).map(mapLine);
    return {
      id: String(row.id),
      number: String(row.number),
      vendorId: String(row.vendor_id),
      vendorName: String(row.vendor_name),
      vendorEmail: text(row.vendor_email),
      status: String(row.status) as PurchaseOrderStatus,
      sentVia: text(row.sent_via) as PurchaseOrderSentVia | null,
      subject: String(row.subject),
      message: String(row.message),
      notes: String(row.notes),
      accessToken: String(row.access_token),
      totalCents: purchaseOrderTotalCents(lines),
      lineCount: lines.length,
      unitCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      sentAt: text(row.sent_at),
      publishedAt: text(row.published_at),
      receivedAt: text(row.received_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lines,
    };
  }

  list(vendorId?: string): PurchaseOrderSummary[] {
    const rows = this.connection
      .prepare(
        `SELECT o.id, o.number, o.vendor_id, o.vendor_name, o.status, o.sent_at, o.created_at,
                (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id = o.id) AS line_count,
                (SELECT COALESCE(SUM(l.quantity), 0) FROM purchase_order_lines l WHERE l.purchase_order_id = o.id) AS unit_count,
                (SELECT COALESCE(SUM(l.received_quantity), 0) FROM purchase_order_lines l WHERE l.purchase_order_id = o.id) AS received_units,
                (SELECT COALESCE(SUM(l.quantity * COALESCE(l.unit_cost_cents, 0)), 0) FROM purchase_order_lines l WHERE l.purchase_order_id = o.id) AS total_cents,
                (SELECT e.status FROM outbound_emails e WHERE e.purchase_order_id = o.id ORDER BY e.created_at DESC LIMIT 1) AS email_status,
                (SELECT e.last_error FROM outbound_emails e WHERE e.purchase_order_id = o.id ORDER BY e.created_at DESC LIMIT 1) AS email_error
         FROM purchase_orders o
         WHERE (? IS NULL OR o.vendor_id = ?)
         ORDER BY o.created_at DESC`,
      )
      .all(vendorId ?? null, vendorId ?? null) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      number: String(row.number),
      vendorId: String(row.vendor_id),
      vendorName: String(row.vendor_name),
      status: String(row.status) as PurchaseOrderStatus,
      totalCents: Number(row.total_cents),
      lineCount: Number(row.line_count),
      unitCount: Number(row.unit_count),
      receivedUnitCount: Number(row.received_units),
      sentAt: text(row.sent_at),
      createdAt: String(row.created_at),
      emailStatus: text(row.email_status) as OutboundEmailStatus | null,
      emailError: text(row.email_error),
    }));
  }

  /**
   * Create a draft from reviewed buying-list lines. Matching open/dismissed
   * suggestions for the same vendor flip to `ordered` so they are not
   * re-suggested while the shipment is in transit.
   */
  create(input: PurchaseOrderInput): PurchaseOrder {
    const value = purchaseOrderInputSchema.parse(input);
    const vendor = this.connection
      .prepare('SELECT name, email FROM vendors WHERE id = ?')
      .get(value.vendorId) as Row | undefined;
    if (!vendor) throw new Error('Vendor not found');
    const id = randomUUID();
    const timestamp = now();
    this.connection
      .prepare(
        `INSERT INTO purchase_orders
           (id, number, vendor_id, vendor_name, vendor_email, status, subject, message, notes, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.nextNumber(),
        value.vendorId,
        String(vendor.name),
        text(vendor.email),
        value.subject,
        value.message,
        value.notes,
        randomBytes(24).toString('base64url'),
        timestamp,
        timestamp,
      );
    const productLookup = this.connection.prepare(
      `SELECT p.name,
              (SELECT b.value FROM product_barcodes b WHERE b.product_id = p.id ORDER BY b.created_at LIMIT 1) AS barcode,
              (SELECT pv.vendor_sku FROM product_vendors pv WHERE pv.product_id = p.id AND pv.vendor_id = ?) AS vendor_sku
       FROM products p WHERE p.id = ?`,
    );
    const insertLine = this.connection.prepare(
      `INSERT INTO purchase_order_lines
         (id, purchase_order_id, product_id, product_name, barcode, vendor_sku, quantity, unit_cost_cents, received_quantity, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const markOrdered = this.connection.prepare(
      `UPDATE reorder_list SET status = 'ordered', purchase_order_id = ?, updated_at = ?
       WHERE product_id = ? AND status IN ('open', 'dismissed')`,
    );
    value.lines.forEach((line, index) => {
      const product = productLookup.get(value.vendorId, line.productId) as
        Row | undefined;
      if (!product) throw new Error('Product not found');
      insertLine.run(
        randomUUID(),
        id,
        line.productId,
        String(product.name),
        text(product.barcode),
        text(product.vendor_sku),
        line.quantity,
        line.unitCostCents,
        index,
      );
      markOrdered.run(id, timestamp, line.productId);
    });
    return this.get(id);
  }

  updateDraft(
    id: string,
    input: Pick<PurchaseOrderInput, 'subject' | 'message' | 'notes'>,
  ): PurchaseOrder {
    const order = this.get(id);
    if (order.status !== 'draft') throw new Error('Only drafts can be edited');
    const value = purchaseOrderInputSchema
      .pick({ subject: true, message: true, notes: true })
      .parse(input);
    this.connection
      .prepare(
        'UPDATE purchase_orders SET subject = ?, message = ?, notes = ?, updated_at = ? WHERE id = ?',
      )
      .run(value.subject, value.message, value.notes, now(), id);
    return this.get(id);
  }

  markSent(id: string, via: PurchaseOrderSentVia): PurchaseOrder {
    const order = this.get(id);
    if (order.status !== 'draft')
      throw new Error('Purchase order already sent');
    const timestamp = now();
    this.connection
      .prepare(
        `UPDATE purchase_orders SET status = 'sent', sent_via = ?, sent_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(via, timestamp, timestamp, id);
    return this.get(id);
  }

  markPublished(id: string): void {
    this.connection
      .prepare(
        'UPDATE purchase_orders SET published_at = COALESCE(published_at, ?) WHERE id = ?',
      )
      .run(now(), id);
  }

  cancel(id: string): PurchaseOrder {
    const order = this.get(id);
    if (order.status === 'received' || order.status === 'cancelled')
      throw new Error('Purchase order can no longer be cancelled');
    if (order.lines.some((line) => line.receivedQuantity > 0))
      throw new Error('Partially received orders cannot be cancelled');
    const timestamp = now();
    this.connection
      .prepare(
        `UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, id);
    // Release the suggestions so the buying list can refill them.
    this.connection
      .prepare(`DELETE FROM reorder_list WHERE purchase_order_id = ?`)
      .run(id);
    this.connection
      .prepare(
        `UPDATE outbound_emails SET status = 'failed', last_error = 'Order cancelled' WHERE purchase_order_id = ? AND status = 'pending'`,
      )
      .run(id);
    return this.get(id);
  }

  /**
   * Record received quantities. Each positive quantity posts a
   * `stock_received` movement through `sink`; when every line is fully
   * received the order closes and its buying-list rows are released.
   */
  receive(
    id: string,
    input: ReceivePurchaseOrderInput,
    sink: ReceiveMovementSink,
  ): PurchaseOrder {
    const value = receivePurchaseOrderInputSchema.parse(input);
    const order = this.get(id);
    if (order.status !== 'sent' && order.status !== 'partially_received')
      throw new Error('Only sent orders can be received');
    const timestamp = now();
    const update = this.connection.prepare(
      'UPDATE purchase_order_lines SET received_quantity = received_quantity + ? WHERE id = ? AND purchase_order_id = ?',
    );
    for (const received of value.lines) {
      if (received.quantity === 0) continue;
      const line = order.lines.find(
        (candidate) => candidate.id === received.lineId,
      );
      if (!line) throw new Error('Purchase order line not found');
      update.run(received.quantity, line.id, id);
      sink({
        productId: line.productId,
        quantity: received.quantity,
        notes: `Received on ${order.number} from ${order.vendorName}${value.notes ? ` — ${value.notes}` : ''}`,
      });
    }
    const remaining = this.connection
      .prepare(
        'SELECT COUNT(*) AS count FROM purchase_order_lines WHERE purchase_order_id = ? AND received_quantity < quantity',
      )
      .get(id) as Row;
    const complete = Number(remaining.count) === 0;
    this.connection
      .prepare(
        `UPDATE purchase_orders SET status = ?, received_at = CASE WHEN ? THEN ? ELSE received_at END, updated_at = ? WHERE id = ?`,
      )
      .run(
        complete ? 'received' : 'partially_received',
        complete ? 1 : 0,
        timestamp,
        timestamp,
        id,
      );
    if (complete)
      this.connection
        .prepare(`DELETE FROM reorder_list WHERE purchase_order_id = ?`)
        .run(id);
    return this.get(id);
  }

  // --- Outbound email queue ---

  enqueueEmail(input: {
    purchaseOrderId: string | null;
    to: string;
    subject: string;
    textBody: string;
    htmlBody: string;
    attachments?: EmailAttachment[];
  }): OutboundEmail {
    const id = randomUUID();
    this.connection
      .prepare(
        `INSERT INTO outbound_emails (id, purchase_order_id, to_address, subject, text_body, html_body, attachments_json, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(
        id,
        input.purchaseOrderId,
        input.to,
        input.subject,
        input.textBody,
        input.htmlBody,
        JSON.stringify(input.attachments ?? []),
        now(),
      );
    return this.getEmail(id);
  }

  getEmail(id: string): OutboundEmail {
    const row = this.connection
      .prepare('SELECT * FROM outbound_emails WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) throw new Error('Email not found');
    return mapEmail(row);
  }

  latestEmailForOrder(purchaseOrderId: string): OutboundEmail | null {
    const row = this.connection
      .prepare(
        'SELECT * FROM outbound_emails WHERE purchase_order_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(purchaseOrderId) as Row | undefined;
    return row ? mapEmail(row) : null;
  }

  pendingEmails(limit = 20): OutboundEmail[] {
    return (
      this.connection
        .prepare(
          `SELECT * FROM outbound_emails WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map(mapEmail);
  }

  markEmailSent(id: string): void {
    this.connection
      .prepare(
        `UPDATE outbound_emails SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = ? WHERE id = ?`,
      )
      .run(now(), id);
  }

  markEmailFailed(id: string, error: string, final: boolean): void {
    this.connection
      .prepare(
        `UPDATE outbound_emails SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`,
      )
      .run(final ? 'failed' : 'pending', error.slice(0, 500), id);
  }

  requeueEmail(id: string): OutboundEmail {
    this.connection
      .prepare(
        `UPDATE outbound_emails SET status = 'pending', attempts = 0, last_error = NULL WHERE id = ? AND status = 'failed'`,
      )
      .run(id);
    return this.getEmail(id);
  }

  // --- Seller SMTP configuration (device-local, encrypted at rest) ---

  getEmailConfig(): EmailConfig | null {
    const row = this.connection
      .prepare(
        'SELECT email_config_secret FROM device_settings WHERE singleton_id = 1',
      )
      .get() as Row | undefined;
    if (!row?.email_config_secret) return null;
    try {
      return emailConfigSchema.parse(
        JSON.parse(this.secretStore.decrypt(String(row.email_config_secret))),
      );
    } catch {
      return null;
    }
  }

  getEmailConfigStatus(gmailAvailable = false): EmailConfigStatus {
    const row = this.connection
      .prepare(
        'SELECT email_config_secret, email_config_encrypted FROM device_settings WHERE singleton_id = 1',
      )
      .get() as Row | undefined;
    const config = this.getEmailConfig();
    const counts = this.connection
      .prepare(
        `SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed FROM outbound_emails`,
      )
      .get() as Row;
    return {
      configured: Boolean(row?.email_config_secret),
      encrypted: Number(row?.email_config_encrypted ?? 0) === 1,
      authType: config?.authType ?? null,
      gmailAvailable,
      host: config?.host ?? null,
      port: config?.port ?? null,
      secure: config?.secure ?? null,
      username: config?.username ?? null,
      fromName: config?.fromName ?? null,
      fromAddress: config?.fromAddress ?? null,
      ccSelf: config?.ccSelf ?? false,
      pendingCount: Number(counts.pending ?? 0),
      failedCount: Number(counts.failed ?? 0),
    };
  }

  setEmailConfig(
    config: EmailConfig | null,
    gmailAvailable = false,
  ): EmailConfigStatus {
    const value = config === null ? null : emailConfigSchema.parse(config);
    this.connection
      .prepare(
        `UPDATE device_settings SET email_config_secret = ?, email_config_encrypted = ?, updated_at = ? WHERE singleton_id = 1`,
      )
      .run(
        value === null ? null : this.secretStore.encrypt(JSON.stringify(value)),
        value === null ? 0 : this.secretStore.available ? 1 : 0,
        now(),
      );
    return this.getEmailConfigStatus(gmailAvailable);
  }
}
