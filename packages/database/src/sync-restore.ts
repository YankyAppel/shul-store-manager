import type { SqliteDatabase } from './sqlite.js';
import type {
  AccountPaymentPayload,
  AuditEventPayload,
  CategoryPayload,
  CloudPayload,
  CustomerPayload,
  InventoryMovementPayload,
  KioskPayload,
  LedgerEntryPayload,
  PaymentTransactionPayload,
  ProductPayload,
  SalePayload,
  SettingsPayload,
} from '@shul-store/shared';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const RESTORED_KIOSK_CREDENTIAL_SENTINEL = 'restored';

export interface RestoreCounts {
  settings: number;
  categories: number;
  products: number;
  customers: number;
  sales: number;
  accountPayments: number;
  paymentTransactions: number;
  inventoryMovements: number;
  ledgerEntries: number;
  auditEvents: number;
  kiosks: number;
}

export interface RestoreOutcome {
  eventsReplayed: number;
  counts: RestoreCounts;
  integrityChecks: string[];
}

/**
 * A validated cloud event ready to be replayed locally. The sync layer parses
 * and Zod-validates the raw cloud payload into `CloudPayload` before handing it
 * here, so by the time `restoreFromEvents` runs every payload is typed and
 * structurally valid. The guarded inserts below still respect every foreign key,
 * CHECK constraint, and trigger — malformed-but-shape-valid data is caught by
 * the database invariants and by `verifyRestoreIntegrity`.
 *
 * Inserts use `ON CONFLICT(id) DO NOTHING` (not `INSERT OR IGNORE`) so that a
 * replayed row is idempotent on its primary key, while CHECK / foreign-key /
 * other unique-constraint violations still raise and abort the restore.
 */
export interface ValidatedRestoreEvent {
  sequence: number;
  eventId: string;
  entityType: CloudPayload['entityType'];
  entityId: string;
  operation: 'upsert' | 'append';
  payload: CloudPayload['payload'];
  createdAt: string;
}

/** A local database is "fresh" for restore when it has no business rows. */
export function isBusinessDataEmpty(connection: SqliteDatabase): boolean {
  const tables = [
    'categories',
    'products',
    'customers',
    'sales',
    'sale_items',
    'payments',
    'account_payments',
    'inventory_movements',
    'customer_ledger',
    'audit_events',
    'payment_transactions',
    'kiosks',
  ];
  for (const table of tables) {
    const exists = connection
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!exists) continue;
    const row = connection
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number } | undefined;
    if ((row?.count ?? 0) > 0) return false;
  }
  return true;
}

/** Insert a metadata-only image stub so image_id foreign keys remain valid.
 *  Image FILES are explicitly out of scope for this milestone; only enough of a
 *  row is created to preserve referential integrity (the image protocol already
 *  returns 404 for missing files). */
function ensureImageStub(connection: SqliteDatabase, imageId: string): void {
  connection
    .prepare(
      `INSERT OR IGNORE INTO images (id, relative_path, original_name, mime_type, byte_size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      imageId,
      `restored-stub/${imageId}`,
      '(image not synced)',
      'image/png',
      0,
      imageId,
      now(),
    );
}

function applySettings(
  connection: SqliteDatabase,
  payload: SettingsPayload,
): void {
  connection
    .prepare(
      `UPDATE store_settings SET
        store_name = ?, contact_lines_json = ?, currency = ?, tax_rate_bps = ?,
        prices_include_tax = ?, receipt_footer = ?, customer_accounts_enabled = ?,
        default_credit_limit_cents = ?, allow_customer_credit = ?, statement_footer = ?,
        overdue_days = ?, receipt_printer_name = ?, receipt_paper_width_mm = ?,
        label_printer_name = ?, default_label_template = ?, updated_at = ?
       WHERE singleton_id = 1`,
    )
    .run(
      payload.storeName,
      JSON.stringify(payload.contactLines),
      payload.currency,
      payload.taxRateBps,
      payload.pricesIncludeTax ? 1 : 0,
      payload.receiptFooter,
      payload.customerAccountsEnabled ? 1 : 0,
      payload.defaultCreditLimitCents,
      payload.allowCustomerCredit ? 1 : 0,
      payload.statementFooter,
      payload.overdueDays,
      payload.receiptPrinterName,
      payload.receiptPaperWidthMm,
      payload.labelPrinterName,
      payload.defaultLabelTemplate,
      now(),
    );
}

function applyCategory(
  connection: SqliteDatabase,
  payload: CategoryPayload,
): void {
  if (payload.imageId) ensureImageStub(connection, payload.imageId);
  connection
    .prepare(
      `INSERT INTO categories (id, name, secondary_name, image_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, secondary_name = excluded.secondary_name,
         image_id = excluded.image_id, active = excluded.active, updated_at = excluded.updated_at`,
    )
    .run(
      payload.id,
      payload.name,
      payload.secondaryName,
      payload.imageId,
      payload.active ? 1 : 0,
      payload.createdAt,
      payload.updatedAt,
    );
}

function applyProduct(
  connection: SqliteDatabase,
  payload: ProductPayload,
): void {
  if (payload.imageId) ensureImageStub(connection, payload.imageId);
  connection
    .prepare(
      `INSERT INTO products
        (id, category_id, name, secondary_name, image_id, purchase_cost_cents, selling_price_cents,
         taxable, low_stock_threshold, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         category_id = excluded.category_id, name = excluded.name, secondary_name = excluded.secondary_name,
         image_id = excluded.image_id, purchase_cost_cents = excluded.purchase_cost_cents,
         selling_price_cents = excluded.selling_price_cents, taxable = excluded.taxable,
         low_stock_threshold = excluded.low_stock_threshold, active = excluded.active,
         updated_at = excluded.updated_at`,
    )
    .run(
      payload.id,
      payload.categoryId,
      payload.name,
      payload.secondaryName,
      payload.imageId,
      payload.purchaseCostCents,
      payload.sellingPriceCents,
      payload.taxable ? 1 : 0,
      payload.lowStockThreshold,
      payload.active ? 1 : 0,
      payload.createdAt,
      payload.updatedAt,
    );
  // Barcodes are the product's owned children: replace them wholesale so a
  // replayed product always reflects exactly its snapshot.
  connection
    .prepare('DELETE FROM product_barcodes WHERE product_id = ?')
    .run(payload.id);
  const insertBarcode = connection.prepare(
    `INSERT INTO product_barcodes (id, product_id, value, kind, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const barcode of payload.barcodes) {
    insertBarcode.run(
      barcode.id,
      payload.id,
      barcode.value,
      barcode.kind,
      barcode.position,
      payload.createdAt,
    );
  }
}

function applyInventoryMovement(
  connection: SqliteDatabase,
  payload: InventoryMovementPayload,
): void {
  connection
    .prepare(
      `INSERT INTO inventory_movements
        (id, operation_id, product_id, quantity_change, reason, occurred_at, device_id,
         related_sale_id, notes, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      payload.id,
      payload.operationId,
      payload.productId,
      payload.quantityChange,
      payload.reason,
      payload.occurredAt,
      payload.deviceId,
      payload.relatedSaleId,
      payload.notes,
      payload.sequence,
    );
}

function applyCustomer(
  connection: SqliteDatabase,
  payload: CustomerPayload,
): void {
  connection
    .prepare(
      `INSERT INTO customers
        (id, account_number, account_barcode, name, secondary_name, phone, email, address, notes,
         active, blocked, credit_limit_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_number = excluded.account_number, account_barcode = excluded.account_barcode,
         name = excluded.name, secondary_name = excluded.secondary_name, phone = excluded.phone,
         email = excluded.email, address = excluded.address, notes = excluded.notes,
         active = excluded.active, blocked = excluded.blocked,
         credit_limit_cents = excluded.credit_limit_cents, updated_at = excluded.updated_at`,
    )
    .run(
      payload.id,
      payload.accountNumber,
      payload.accountBarcode,
      payload.name,
      payload.secondaryName,
      payload.phone,
      payload.email,
      payload.address,
      payload.notes,
      payload.active ? 1 : 0,
      payload.blocked ? 1 : 0,
      payload.creditLimitCents,
      payload.createdAt,
      payload.updatedAt,
    );
}

function applyLedgerEntry(
  connection: SqliteDatabase,
  entry: LedgerEntryPayload,
): void {
  connection
    .prepare(
      `INSERT INTO customer_ledger
        (id, operation_id, customer_id, amount_cents, entry_type, occurred_at, related_sale_id,
         related_account_payment_id, device_id, notes, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      entry.id,
      entry.operationId,
      entry.customerId,
      entry.amountCents,
      entry.entryType,
      entry.occurredAt,
      entry.relatedSaleId,
      entry.relatedAccountPaymentId,
      entry.deviceId,
      entry.notes,
      entry.sequence,
    );
}

function applySale(connection: SqliteDatabase, payload: SalePayload): void {
  connection
    .prepare(
      `INSERT INTO sales
        (id, receipt_number, completion_key, status, subtotal_cents, tax_cents, total_cents,
         created_at, completed_at, customer_id, customer_name, customer_account_number,
         customer_balance_before_cents, customer_balance_after_cents, tender_type, channel, kiosk_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      payload.id,
      payload.receiptNumber,
      payload.completionKey,
      payload.status,
      payload.subtotalCents,
      payload.taxCents,
      payload.totalCents,
      payload.createdAt,
      payload.completedAt,
      payload.customerId,
      payload.customerName,
      payload.customerAccountNumber,
      payload.customerBalanceBeforeCents,
      payload.customerBalanceAfterCents,
      payload.tenderType,
      payload.channel ?? 'manager',
      payload.kioskId ?? null,
    );

  const insertItem = connection.prepare(
    `INSERT INTO sale_items
      (id, sale_id, product_id, product_name, secondary_name, barcode_used, quantity,
       unit_selling_price_cents, unit_purchase_cost_cents, taxable, tax_cents, line_subtotal_cents,
       line_total_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const item of payload.items) {
    insertItem.run(
      item.id,
      payload.id,
      item.productId,
      item.productName,
      item.secondaryName,
      item.barcodeUsed,
      item.quantity,
      item.unitSellingPriceCents,
      item.unitPurchaseCostCents,
      item.taxable ? 1 : 0,
      item.taxCents,
      item.lineSubtotalCents,
      item.lineTotalCents,
    );
  }

  if (payload.payment) {
    const payment = payload.payment;
    connection
      .prepare(
        `INSERT INTO payments
          (id, sale_id, method, amount_cents, cash_received_cents, change_due_cents,
           terminal_reference, external_approved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        cryptoUuid(),
        payload.id,
        payment.method,
        payment.amountCents,
        payment.cashReceivedCents,
        payment.changeDueCents,
        payment.terminalReference,
        payment.externalApproved === null
          ? null
          : payment.externalApproved
            ? 1
            : 0,
        payload.createdAt,
      );
  }

  for (const movement of payload.inventoryMovements) {
    applyInventoryMovement(connection, movement);
  }
  if (payload.ledgerEntry) {
    applyLedgerEntry(connection, payload.ledgerEntry);
  }
}

function applyAccountPayment(
  connection: SqliteDatabase,
  payload: AccountPaymentPayload,
): void {
  connection
    .prepare(
      `INSERT INTO account_payments
        (id, operation_id, receipt_number, customer_id, customer_name, account_number, amount_cents,
         method, cash_received_cents, change_due_cents, terminal_reference, external_approved,
         previous_balance_cents, new_balance_cents, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      payload.id,
      payload.operationId,
      payload.receiptNumber,
      payload.customerId,
      payload.customerName,
      payload.accountNumber,
      payload.amountCents,
      payload.method,
      payload.cashReceivedCents,
      payload.changeDueCents,
      payload.terminalReference,
      payload.externalApproved === null
        ? null
        : payload.externalApproved
          ? 1
          : 0,
      payload.previousBalanceCents,
      payload.newBalanceCents,
      payload.notes,
      payload.createdAt,
    );
  applyLedgerEntry(connection, payload.ledgerEntry);
}

function applyPaymentTransaction(
  connection: SqliteDatabase,
  payload: PaymentTransactionPayload,
): void {
  if (payload.cartSnapshotJson) {
    const snap = JSON.parse(payload.cartSnapshotJson);
    if (snap.totals.totalCents !== payload.amountCents) {
      throw new Error('cartSnapshotJson totals do not match amountCents');
    }
  }

  connection
    .prepare(
      `INSERT INTO payment_transactions (
        id, charge_reference, processor_id, amount_cents, status,
        processor_transaction_id, card_brand, card_last4,
        sale_id, cart_snapshot_json, idempotency_key,
        kiosk_id, snapshot_hash, processor_config_hash, origin_channel, attention_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        processor_transaction_id = excluded.processor_transaction_id,
        card_brand = excluded.card_brand,
        card_last4 = excluded.card_last4,
        sale_id = excluded.sale_id,
        cart_snapshot_json = COALESCE(excluded.cart_snapshot_json, payment_transactions.cart_snapshot_json),
        updated_at = excluded.updated_at`,
    )
    .run(
      payload.id,
      payload.chargeReference,
      payload.processorId,
      payload.amountCents,
      payload.status,
      payload.processorTransactionId,
      payload.cardBrand,
      payload.cardLast4,
      payload.saleId ? String(payload.saleId) : null,
      payload.cartSnapshotJson ? String(payload.cartSnapshotJson) : null,
      payload.idempotencyKey ? String(payload.idempotencyKey) : null,
      payload.kioskId ? String(payload.kioskId) : null,
      payload.snapshotHash ? String(payload.snapshotHash) : null,
      payload.processorConfigHash ? String(payload.processorConfigHash) : null,
      payload.originChannel === 'kiosk' ? 'kiosk' : 'manager',
      payload.attentionReason ? String(payload.attentionReason) : null,
      payload.createdAt,
      payload.updatedAt,
    );
}

function applyKiosk(connection: SqliteDatabase, payload: KioskPayload): void {
  connection
    .prepare(
      `INSERT INTO kiosks
        (id, name, token_hash, admin_pin_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         revoked_at = excluded.revoked_at`,
    )
    .run(
      payload.id,
      payload.name,
      RESTORED_KIOSK_CREDENTIAL_SENTINEL,
      RESTORED_KIOSK_CREDENTIAL_SENTINEL,
      payload.createdAt,
      payload.revokedAt ?? now(),
    );
}

function applyAuditEvent(
  connection: SqliteDatabase,
  payload: AuditEventPayload,
): void {
  connection
    .prepare(
      `INSERT INTO audit_events
        (id, event_type, entity_type, entity_id, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      payload.id,
      payload.eventType,
      payload.entityType,
      payload.entityId,
      JSON.stringify(payload.payload),
      payload.occurredAt,
    );
}

function applyOne(
  connection: SqliteDatabase,
  event: ValidatedRestoreEvent,
  counts: RestoreCounts,
): void {
  switch (event.entityType) {
    case 'settings':
      applySettings(connection, event.payload as SettingsPayload);
      counts.settings += 1;
      break;
    case 'category':
      applyCategory(connection, event.payload as CategoryPayload);
      counts.categories += 1;
      break;
    case 'product':
      applyProduct(connection, event.payload as ProductPayload);
      counts.products += 1;
      break;
    case 'inventory_movement':
      applyInventoryMovement(
        connection,
        event.payload as InventoryMovementPayload,
      );
      counts.inventoryMovements += 1;
      break;
    case 'customer':
      applyCustomer(connection, event.payload as CustomerPayload);
      counts.customers += 1;
      break;
    case 'sale':
      applySale(connection, event.payload as SalePayload);
      counts.sales += 1;
      break;
    case 'account_payment':
      applyAccountPayment(connection, event.payload as AccountPaymentPayload);
      counts.accountPayments += 1;
      break;
    case 'payment_transaction':
      applyPaymentTransaction(
        connection,
        event.payload as PaymentTransactionPayload,
      );
      counts.paymentTransactions += 1;
      break;
    case 'kiosk':
      applyKiosk(connection, event.payload as KioskPayload);
      counts.kiosks += 1;
      break;
    case 'audit_event':
      applyAuditEvent(connection, event.payload as AuditEventPayload);
      counts.auditEvents += 1;
      break;
  }
}

/**
 * Replay validated cloud events into a fresh local database in a single
 * transaction, seed the local outbox with those events (marked as already
 * pushed) so the device resumes pushing from the restored sequence, and verify
 * financial integrity. Throws (rolling back the whole transaction) if any
 * invariant is violated — the database is left untouched on failure.
 */
export function restoreFromEvents(
  connection: SqliteDatabase,
  events: ValidatedRestoreEvent[],
): RestoreOutcome {
  const counts: RestoreCounts = {
    settings: 0,
    categories: 0,
    products: 0,
    customers: 0,
    sales: 0,
    accountPayments: 0,
    paymentTransactions: 0,
    inventoryMovements: 0,
    ledgerEntries: 0,
    auditEvents: 0,
    kiosks: 0,
  };

  connection.exec('PRAGMA defer_foreign_keys = ON');

  const seedOutbox = connection.prepare(
    `INSERT OR IGNORE INTO sync_outbox
      (sequence, event_id, entity_type, entity_id, operation, payload_json, created_at, pushed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const event of events) {
    applyOne(connection, event, counts);
    if (event.entityType === 'sale') {
      const sale = event.payload as SalePayload;
      counts.ledgerEntries += sale.ledgerEntry ? 1 : 0;
      counts.inventoryMovements += sale.inventoryMovements.length;
    } else if (event.entityType === 'account_payment') {
      counts.ledgerEntries += 1;
    }
    seedOutbox.run(
      event.sequence,
      event.eventId,
      event.entityType,
      event.entityId,
      event.operation,
      JSON.stringify(event.payload),
      event.createdAt,
      now(),
    );
  }

  const integrityChecks = verifyRestoreIntegrity(connection);

  return {
    eventsReplayed: events.length,
    counts,
    integrityChecks,
  };
}

/**
 * Verify the restored database is internally consistent. Cross-checks that every
 * customer ledger running balance matches the sale / account-payment balance
 * snapshots, that every ledger charge/payment still references its parent row,
 * and that no foreign-key violations exist. Returns a list of human-readable
 * check descriptions; throws if any check fails.
 */
export function verifyRestoreIntegrity(connection: SqliteDatabase): string[] {
  const checks: string[] = [];

  const fkViolations = connection
    .prepare('PRAGMA foreign_key_check')
    .all() as Row[];
  if (fkViolations.length > 0) {
    throw new Error(
      `Restore integrity check failed: ${fkViolations.length} foreign key violation(s) detected`,
    );
  }
  checks.push('foreign_key_check: no violations');

  const danglingSales = (
    connection
      .prepare(
        `SELECT COUNT(*) AS count FROM sales
         WHERE kiosk_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM kiosks WHERE kiosks.id = sales.kiosk_id)`,
      )
      .get() as { count: number }
  ).count;
  if (danglingSales > 0) {
    throw new Error(
      `Restore integrity check failed: ${danglingSales} sales kiosk reference(s) point to missing kiosks`,
    );
  }
  checks.push('sales.kiosk_id: no dangling kiosk references');

  const danglingPaymentTransactions = (
    connection
      .prepare(
        `SELECT COUNT(*) AS count FROM payment_transactions
         WHERE kiosk_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM kiosks WHERE kiosks.id = payment_transactions.kiosk_id
           )`,
      )
      .get() as { count: number }
  ).count;
  if (danglingPaymentTransactions > 0) {
    throw new Error(
      `Restore integrity check failed: ${danglingPaymentTransactions} payment transaction kiosk reference(s) point to missing kiosks`,
    );
  }
  checks.push('payment_transactions.kiosk_id: no dangling kiosk references');

  const customers = connection
    .prepare('SELECT id FROM customers ORDER BY created_at, name')
    .all() as Array<{ id: string }>;

  for (const customer of customers) {
    const entries = connection
      .prepare(
        'SELECT * FROM customer_ledger WHERE customer_id = ? ORDER BY sequence ASC',
      )
      .all(customer.id) as Row[];
    let running = 0;
    for (const entry of entries) {
      const amount = Number(entry.amount_cents);
      const relatedSaleId = entry.related_sale_id
        ? String(entry.related_sale_id)
        : null;
      const relatedPaymentId = entry.related_account_payment_id
        ? String(entry.related_account_payment_id)
        : null;
      if (relatedSaleId) {
        const sale = connection
          .prepare(
            'SELECT customer_balance_before_cents, customer_balance_after_cents FROM sales WHERE id = ?',
          )
          .get(relatedSaleId) as Row | undefined;
        if (!sale) {
          throw new Error(
            `Restore integrity check failed: ledger entry references missing sale ${relatedSaleId}`,
          );
        }
        const before =
          sale.customer_balance_before_cents === null
            ? null
            : Number(sale.customer_balance_before_cents);
        const after =
          sale.customer_balance_after_cents === null
            ? null
            : Number(sale.customer_balance_after_cents);
        if (before !== null && before !== running) {
          throw new Error(
            `Restore integrity check failed: sale ${relatedSaleId} opening balance ${before} does not match ledger running balance ${running}`,
          );
        }
        running += amount;
        if (after !== null && after !== running) {
          throw new Error(
            `Restore integrity check failed: sale ${relatedSaleId} closing balance ${after} does not match ledger running balance ${running}`,
          );
        }
      } else if (relatedPaymentId) {
        const payment = connection
          .prepare(
            'SELECT previous_balance_cents, new_balance_cents FROM account_payments WHERE id = ?',
          )
          .get(relatedPaymentId) as Row | undefined;
        if (!payment) {
          throw new Error(
            `Restore integrity check failed: ledger entry references missing account payment ${relatedPaymentId}`,
          );
        }
        const previous = Number(payment.previous_balance_cents);
        const next = Number(payment.new_balance_cents);
        if (previous !== running) {
          throw new Error(
            `Restore integrity check failed: payment ${relatedPaymentId} opening balance ${previous} does not match ledger running balance ${running}`,
          );
        }
        running += amount;
        if (next !== running) {
          throw new Error(
            `Restore integrity check failed: payment ${relatedPaymentId} closing balance ${next} does not match ledger running balance ${running}`,
          );
        }
      } else {
        running += amount;
      }
    }
  }
  checks.push(
    `customer ledger balances reconciled for ${customers.length} customer(s)`,
  );

  const ledgerCount = (
    connection
      .prepare('SELECT COUNT(*) AS count FROM customer_ledger')
      .get() as { count: number }
  ).count;
  const computedBalance = (
    connection
      .prepare(
        'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM customer_ledger',
      )
      .get() as { total: number }
  ).total;
  checks.push(
    `ledger integrity: ${ledgerCount} entries, net balance ${computedBalance}`,
  );

  return checks;
}

// payments.id is an implementation detail generated per device; on restore we
// mint a fresh id without importing node:crypto at module scope. globalThis.crypto
// is available in Node 22 and Electron's main process.
function cryptoUuid(): string {
  return globalThis.crypto.randomUUID();
}
