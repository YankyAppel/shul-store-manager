import { randomUUID } from 'node:crypto';
import { SqliteDatabase } from './sqlite.js';
import { PaymentService } from './payment-service.js';
import {
  calculateCart,
  calculateCashChange,
  categoryInputSchema,
  completeSaleInputSchema,
  customerInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
  PlaintextSecretStore,
  recordAccountPaymentInputSchema,
  statementOptionsSchema,
  storeSettingsSchema,
  syncOperationFor,
  type AccountPayment,
  type AccountPaymentPayload,
  type AuditEventPayload,
  type Barcode,
  type Category,
  type CategoryInput,
  type CategoryPayload,
  type CompleteSaleInput,
  type Customer,
  type CustomerInput,
  type CustomerLedgerEntry,
  type CustomerPayload,
  type CustomerStatementData,
  type InventoryMovement,
  type InventoryMovementInput,
  type InventoryMovementPayload,
  type KioskPayload,
  type KioskSummary,
  type LedgerEntryPayload,
  type PaymentTransactionPayload,
  type Product,
  type ProductInput,
  type ProductPayload,
  type RecordAccountPaymentInput,
  type Sale,
  type SaleItemPayload,
  type SalePayload,
  type SalePaymentPayload,
  type SecretStore,
  type SettingsPayload,
  type StatementEntry,
  type StatementOptions,
  type StoreSettings,
  type SyncConfigView,
  type SyncEntityType,
  type SyncStatus,
} from '@shul-store/shared';
import { migrations, runMigrations } from './migrations.js';
import {
  createBackup as createBackupFile,
  listBackups as listBackupFiles,
  recordBackupAttempt,
  type BackupAttempt,
  type BackupKind,
  type BackupListing,
} from './backup.js';
import {
  enqueueOutboxEvent,
  listAllOutboxEvents,
  listPendingOutboxEvents,
  markOutboxPushed,
  maxOutboxSequence,
  pendingOutboxCount,
  type OutboxEvent,
} from './sync-outbox.js';
import {
  isBusinessDataEmpty,
  hasBusinessRows,
  restoreFromEvents,
  type RestoreOutcome,
  type ValidatedRestoreEvent,
} from './sync-restore.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function readSafeCents(value: unknown, label = 'value'): number {
  if (value === null || value === undefined) {
    return 0;
  }
  let b: bigint;
  if (typeof value === 'bigint') {
    b = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${label} must be a safe integer: ${value}`);
    }
    b = BigInt(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Invalid numeric format for ${label}: ${value}`);
    }
    b = BigInt(trimmed);
  } else {
    throw new Error(
      `Invalid type for financial value ${label}: ${typeof value}`,
    );
  }

  if (b < -MAX_SAFE_INTEGER_BIGINT || b > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error(
      `${label} exceeds the supported safe integer range: ${b.toString()}`,
    );
  }
  const n = Number(b);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${label} must be a safe integer: ${n}`);
  }
  return n;
}

export function readNullableSafeCents(
  value: unknown,
  label = 'value',
): number | null {
  if (value === null || value === undefined) return null;
  return readSafeCents(value, label);
}

/** Raw cloud-sync configuration as stored locally (key secret is opaque). */
export interface SyncConfigRecord {
  storeId: string | null;
  supabaseUrl: string | null;
  apiKeySecret: string | null;
  apiKeyEncrypted: boolean;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  backfillCompleted: boolean;
}

export interface StoreDatabaseOptions {
  backupDirectory?: string;
}

export class StoreDatabase {
  readonly connection: SqliteDatabase;
  private paymentService: PaymentService | null = null;
  private readonly secretStore: SecretStore;
  private readonly backupDirectory: string | null;

  constructor(
    filename: string,
    secretStore: SecretStore = new PlaintextSecretStore(),
    options: StoreDatabaseOptions = {},
  ) {
    this.secretStore = secretStore;
    this.backupDirectory = options.backupDirectory ?? null;
    this.connection = new SqliteDatabase(filename);
    this.connection.pragma('busy_timeout = 5000');
    const currentVersion = this.schemaVersion();
    const latestVersion = migrations.at(-1)?.version ?? currentVersion;
    let preMigrationAttempt: BackupAttempt | null = null;
    if (
      this.backupDirectory &&
      currentVersion > 0 &&
      currentVersion < latestVersion &&
      hasBusinessRows(this.connection)
    ) {
      preMigrationAttempt = createBackupFile(
        this.connection,
        this.backupDirectory,
        'premigration',
        currentVersion,
      );
      if (!preMigrationAttempt.ok) {
        this.connection.close();
        throw new Error(
          `Pre-migration backup failed: ${preMigrationAttempt.message}`,
        );
      }
    }
    try {
      runMigrations(this.connection);
      if (preMigrationAttempt) {
        try {
          recordBackupAttempt(this.connection, preMigrationAttempt);
        } catch {
          // A migration must not be rolled back because its history row could
          // not be written after the verified snapshot was created.
        }
      }
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  schemaVersion(): number {
    return this.connection.pragma('user_version', { simple: true }) as number;
  }

  createBackup(kind: BackupKind): BackupAttempt {
    if (!this.backupDirectory)
      return {
        attemptedAt: now(),
        kind,
        filename: '',
        bytes: 0,
        ok: false,
        message: 'A backup directory is not configured.',
      };
    const attempt = createBackupFile(
      this.connection,
      this.backupDirectory,
      kind,
      this.schemaVersion(),
    );
    try {
      recordBackupAttempt(this.connection, attempt);
    } catch {
      // Backup failures are surfaced through the returned attempt and should
      // never crash the manager process.
    }
    return attempt;
  }

  listBackups(): BackupListing[] {
    return this.backupDirectory
      ? listBackupFiles(this.connection, this.backupDirectory)
      : [];
  }

  getBackupDirectory(): string | null {
    return this.backupDirectory;
  }

  // --- SETTINGS ---

  getSettings(): StoreSettings {
    const row = this.connection
      .prepare('SELECT * FROM store_settings WHERE singleton_id = 1')
      .get() as Row;
    return {
      storeName: String(row.store_name),
      contactLines: JSON.parse(String(row.contact_lines_json)) as string[],
      currency: 'USD',
      taxRateBps: readSafeCents(row.tax_rate_bps, 'taxRateBps'),
      pricesIncludeTax: Boolean(row.prices_include_tax),
      receiptFooter: String(row.receipt_footer),
      customerAccountsEnabled:
        row.customer_accounts_enabled === undefined
          ? true
          : Boolean(row.customer_accounts_enabled),
      defaultCreditLimitCents:
        row.default_credit_limit_cents === undefined
          ? 50000
          : readSafeCents(
              row.default_credit_limit_cents,
              'defaultCreditLimitCents',
            ),
      allowCustomerCredit:
        row.allow_customer_credit === undefined
          ? false
          : Boolean(row.allow_customer_credit),
      statementFooter:
        row.statement_footer === undefined ? '' : String(row.statement_footer),
      overdueDays:
        row.overdue_days === undefined
          ? 30
          : readSafeCents(row.overdue_days, 'overdueDays'),
      receiptPrinterName:
        row.receipt_printer_name === undefined ||
        row.receipt_printer_name === null ||
        String(row.receipt_printer_name).trim() === ''
          ? null
          : String(row.receipt_printer_name),
      receiptPaperWidthMm:
        row.receipt_paper_width_mm === undefined
          ? 80
          : readSafeCents(row.receipt_paper_width_mm, 'receiptPaperWidthMm') ===
              58
            ? 58
            : 80,
      labelPrinterName:
        row.label_printer_name === undefined ||
        row.label_printer_name === null ||
        String(row.label_printer_name).trim() === ''
          ? null
          : String(row.label_printer_name),
      defaultLabelTemplate: parseLabelTemplate(row.default_label_template),
      cardProcessingEnabled: Boolean(row.card_processing_enabled),
      cardProcessorId: row.card_processor_id
        ? String(row.card_processor_id)
        : null,
      cardProcessorConfigJson: row.card_processor_config_json
        ? String(row.card_processor_config_json)
        : null,
    };
  }

  updateSettings(input: StoreSettings): StoreSettings {
    const value = storeSettingsSchema.parse(input);
    this.connection.transaction(() => {
      this.connection
        .prepare(
          `UPDATE store_settings SET
            store_name=?,
            contact_lines_json=?,
            currency=?,
            tax_rate_bps=?,
            prices_include_tax=?,
            receipt_footer=?,
            customer_accounts_enabled=?,
            default_credit_limit_cents=?,
            allow_customer_credit=?,
            statement_footer=?,
            overdue_days=?,
            receipt_printer_name=?,
            receipt_paper_width_mm=?,
            label_printer_name=?,
            default_label_template=?,
            card_processing_enabled=?,
            card_processor_id=?,
            card_processor_config_json=?,
            updated_at=?
          WHERE singleton_id=1`,
        )
        .run(
          value.storeName,
          JSON.stringify(value.contactLines),
          value.currency,
          value.taxRateBps,
          value.pricesIncludeTax ? 1 : 0,
          value.receiptFooter,
          value.customerAccountsEnabled ? 1 : 0,
          value.defaultCreditLimitCents,
          value.allowCustomerCredit ? 1 : 0,
          value.statementFooter,
          value.overdueDays,
          value.receiptPrinterName,
          value.receiptPaperWidthMm,
          value.labelPrinterName,
          value.defaultLabelTemplate,
          value.cardProcessingEnabled ? 1 : 0,
          value.cardProcessorId,
          value.cardProcessorConfigJson,
          now(),
        );
      this.enqueueEntity('settings', 'settings');
    })();
    return this.getSettings();
  }

  // --- CATEGORIES ---

  listCategories(includeInactive = false): Category[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM categories ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map(mapCategory);
  }

  createCategory(input: CategoryInput): Category {
    const value = categoryInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = now();
    this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO categories (id, name, secondary_name, image_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          value.name,
          value.secondaryName ?? null,
          value.imageId ?? null,
          timestamp,
          timestamp,
        );
      this.enqueueEntity('category', id);
    })();
    return this.getCategory(id);
  }

  updateCategory(id: string, input: CategoryInput): Category {
    const value = categoryInputSchema.parse(input);
    this.connection.transaction(() => {
      const result = this.connection
        .prepare(
          `UPDATE categories SET name = ?, secondary_name = ?, image_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          value.name,
          value.secondaryName ?? null,
          value.imageId ?? null,
          now(),
          id,
        );
      if (result.changes === 0) throw new Error('Category not found');
      this.enqueueEntity('category', id);
    })();
    return this.getCategory(id);
  }

  setCategoryActive(id: string, active: boolean): void {
    this.connection.transaction(() => {
      const result = this.connection
        .prepare(
          'UPDATE categories SET active = ?, updated_at = ? WHERE id = ?',
        )
        .run(active ? 1 : 0, now(), id);
      if (result.changes === 0) throw new Error('Category not found');
      this.enqueueEntity('category', id);
    })();
  }

  private getCategory(id: string): Category {
    const row = this.connection
      .prepare('SELECT * FROM categories WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) throw new Error('Category not found');
    return mapCategory(row);
  }

  // --- PRODUCTS ---

  listProducts(includeInactive = false): Product[] {
    const rows = this.connection
      .prepare(
        `
        SELECT p.*, c.name AS category_name, COALESCE(SUM(m.quantity_change), 0) AS stock_quantity
        FROM products p
        JOIN categories c ON c.id = p.category_id
        LEFT JOIN inventory_movements m ON m.product_id = p.id
        ${includeInactive ? '' : 'WHERE p.active = 1'}
        GROUP BY p.id
        ORDER BY p.name COLLATE NOCASE
      `,
      )
      .all() as Row[];
    return rows.map((row) => this.mapProduct(row));
  }

  createProduct(input: ProductInput): Product {
    const value = productInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = now();
    try {
      this.connection.transaction(() => {
        this.assertCategoryExists(value.categoryId);
        this.connection
          .prepare(
            `INSERT INTO products
            (id, category_id, name, secondary_name, image_id, purchase_cost_cents, selling_price_cents, taxable, low_stock_threshold, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            value.categoryId,
            value.name,
            value.secondaryName ?? null,
            value.imageId ?? null,
            value.purchaseCostCents,
            value.sellingPriceCents,
            value.taxable ? 1 : 0,
            value.lowStockThreshold,
            timestamp,
            timestamp,
          );
        this.insertBarcodes(id, value.barcodes, timestamp);
        this.enqueueEntity('product', id);
        this.addAudit('product.created', 'product', id, { name: value.name });
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }
    return this.getProduct(id);
  }

  updateProduct(id: string, input: ProductInput): Product {
    const value = productInputSchema.parse(input);
    try {
      this.connection.transaction(() => {
        const currentBarcodes = this.getProduct(id)
          .barcodes.map((b) => b.value.toLowerCase())
          .sort();
        const nextBarcodes = value.barcodes.map((b) => b.toLowerCase()).sort();
        const barcodeSetChanged =
          JSON.stringify(currentBarcodes) !== JSON.stringify(nextBarcodes);
        const held = this.connection
          .prepare(
            "SELECT 1 FROM payment_inventory_reservations WHERE product_id=? AND status='held' LIMIT 1",
          )
          .get(id);
        if (held && barcodeSetChanged)
          throw new Error(
            'Product barcode cannot change while card payment is pending',
          );
        this.assertCategoryExists(value.categoryId);
        const result = this.connection
          .prepare(
            `UPDATE products SET category_id = ?, name = ?, secondary_name = ?, image_id = ?, purchase_cost_cents = ?, selling_price_cents = ?, taxable = ?, low_stock_threshold = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            value.categoryId,
            value.name,
            value.secondaryName ?? null,
            value.imageId ?? null,
            value.purchaseCostCents,
            value.sellingPriceCents,
            value.taxable ? 1 : 0,
            value.lowStockThreshold,
            now(),
            id,
          );
        if (result.changes === 0) throw new Error('Product not found');
        if (barcodeSetChanged) {
          this.connection
            .prepare('DELETE FROM product_barcodes WHERE product_id = ?')
            .run(id);
          this.insertBarcodes(id, value.barcodes, now());
        }
        this.enqueueEntity('product', id);
        this.addAudit('product.updated', 'product', id, { name: value.name });
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }
    return this.getProduct(id);
  }

  setProductActive(id: string, active: boolean): void {
    this.connection.transaction(() => {
      if (!active) {
        const held = this.connection
          .prepare(
            "SELECT 1 FROM payment_inventory_reservations WHERE product_id=? AND status='held' LIMIT 1",
          )
          .get(id);
        if (held)
          throw new Error('Product has a pending card-payment reservation');
      }
      const result = this.connection
        .prepare('UPDATE products SET active = ?, updated_at = ? WHERE id = ?')
        .run(active ? 1 : 0, now(), id);
      if (result.changes === 0) throw new Error('Product not found');
      this.enqueueEntity('product', id);
      this.addAudit(
        active ? 'product.activated' : 'product.deactivated',
        'product',
        id,
        {},
      );
    })();
  }

  generateInternalBarcode(): string {
    return `SSM-${Date.now().toString(36).toUpperCase()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  }

  // --- INVENTORY ---

  addInventoryMovement(input: InventoryMovementInput): InventoryMovement {
    const value = inventoryMovementInputSchema.parse(input);
    const id = randomUUID();
    const operationId = value.operationId ?? randomUUID();
    const timestamp = now();
    try {
      this.connection.transaction(() => {
        const product = this.connection
          .prepare('SELECT id FROM products WHERE id = ?')
          .get(value.productId);
        if (!product) throw new Error('Product not found');
        this.connection
          .prepare(
            `INSERT INTO inventory_movements
            (id, operation_id, product_id, quantity_change, reason, occurred_at, device_id, related_sale_id, notes, sequence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM inventory_movements))`,
          )
          .run(
            id,
            operationId,
            value.productId,
            value.quantityChange,
            value.reason,
            timestamp,
            value.deviceId ?? null,
            value.relatedSaleId ?? null,
            value.notes,
          );
        this.enqueueEntity('inventory_movement', id);
        this.addAudit('inventory.movement_added', 'product', value.productId, {
          movementId: id,
          quantityChange: value.quantityChange,
          reason: value.reason,
        });
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }
    return this.getMovement(id);
  }

  listInventoryMovements(productId: string): InventoryMovement[] {
    const rows = this.connection
      .prepare(
        `
        SELECT *, SUM(quantity_change) OVER (
          PARTITION BY product_id ORDER BY occurred_at, sequence ROWS UNBOUNDED PRECEDING
        ) AS resulting_stock
        FROM inventory_movements
        WHERE product_id = ?
        ORDER BY occurred_at DESC, sequence DESC
      `,
      )
      .all(productId) as Row[];
    return rows.map(mapMovement);
  }

  // --- IMAGES ---

  registerImage(image: {
    id: string;
    relativePath: string;
    originalName: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
  }): void {
    this.connection
      .prepare(
        'INSERT INTO images (id, relative_path, original_name, mime_type, byte_size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        image.id,
        image.relativePath,
        image.originalName,
        image.mimeType,
        image.byteSize,
        image.sha256,
        now(),
      );
  }

  getImagePath(id: string): string | null {
    const row = this.connection
      .prepare('SELECT relative_path FROM images WHERE id = ?')
      .get(id) as { relative_path: string } | undefined;
    return row?.relative_path ?? null;
  }

  removeImageIfUnreferenced(id: string): string | null {
    return this.connection.transaction(() => {
      const referenced = this.connection
        .prepare(
          `
        SELECT 1 FROM categories WHERE image_id = ?
        UNION ALL SELECT 1 FROM products WHERE image_id = ? LIMIT 1
      `,
        )
        .get(id, id);
      if (referenced) return null;
      const row = this.connection
        .prepare('SELECT relative_path FROM images WHERE id = ?')
        .get(id) as { relative_path: string } | undefined;
      if (!row) return null;
      this.connection.prepare('DELETE FROM images WHERE id = ?').run(id);
      return row.relative_path;
    })();
  }

  // --- CUSTOMERS ---

  listCustomers(includeInactive = false): Customer[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM customers ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name COLLATE NOCASE`,
      )
      .all() as Row[];
    const settings = this.getSettings();
    return rows.map((row) => this.mapCustomer(row, settings));
  }

  getCustomer(id: string): Customer {
    const row = this.connection
      .prepare('SELECT * FROM customers WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) throw new Error('Customer not found');
    const settings = this.getSettings();
    return this.mapCustomer(row, settings);
  }

  searchCustomers(query: string, includeInactive = false): Customer[] {
    const clean = query.trim();
    if (!clean) return this.listCustomers(includeInactive);
    const pattern = `%${clean}%`;
    const rows = this.connection
      .prepare(
        `SELECT * FROM customers
        WHERE (name LIKE ? OR secondary_name LIKE ? OR phone LIKE ? OR email LIKE ? OR account_number LIKE ? OR account_barcode LIKE ?)
        ${includeInactive ? '' : 'AND active = 1'}
        ORDER BY name COLLATE NOCASE`,
      )
      .all(pattern, pattern, pattern, pattern, pattern, pattern) as Row[];
    const settings = this.getSettings();
    return rows.map((row) => this.mapCustomer(row, settings));
  }

  createCustomer(input: CustomerInput): Customer {
    const value = customerInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = now();
    try {
      this.connection.transaction(() => {
        this.connection
          .prepare(
            `INSERT INTO customers
            (id, account_number, account_barcode, name, secondary_name, phone, email, address, notes, active, blocked, credit_limit_cents, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
          )
          .run(
            id,
            value.accountNumber.trim(),
            value.accountBarcode?.trim() || null,
            value.name.trim(),
            value.secondaryName?.trim() || null,
            value.phone?.trim() || null,
            value.email?.trim() || null,
            value.address?.trim() || null,
            value.notes?.trim() || null,
            value.creditLimitCents ?? null,
            timestamp,
            timestamp,
          );
        this.enqueueEntity('customer', id);
        this.addAudit('customer.created', 'customer', id, {
          name: value.name,
          accountNumber: value.accountNumber,
        });
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }
    return this.getCustomer(id);
  }

  updateCustomer(id: string, input: CustomerInput): Customer {
    const value = customerInputSchema.parse(input);
    const timestamp = now();
    try {
      this.connection.transaction(() => {
        const result = this.connection
          .prepare(
            `UPDATE customers SET
              account_number = ?,
              account_barcode = ?,
              name = ?,
              secondary_name = ?,
              phone = ?,
              email = ?,
              address = ?,
              notes = ?,
              credit_limit_cents = ?,
              updated_at = ?
            WHERE id = ?`,
          )
          .run(
            value.accountNumber.trim(),
            value.accountBarcode?.trim() || null,
            value.name.trim(),
            value.secondaryName?.trim() || null,
            value.phone?.trim() || null,
            value.email?.trim() || null,
            value.address?.trim() || null,
            value.notes?.trim() || null,
            value.creditLimitCents ?? null,
            timestamp,
            id,
          );
        if (result.changes === 0) throw new Error('Customer not found');
        this.enqueueEntity('customer', id);
        this.addAudit('customer.updated', 'customer', id, {
          name: value.name,
          accountNumber: value.accountNumber,
        });
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }
    return this.getCustomer(id);
  }

  setCustomerActive(id: string, active: boolean): void {
    this.connection.transaction(() => {
      const result = this.connection
        .prepare('UPDATE customers SET active = ?, updated_at = ? WHERE id = ?')
        .run(active ? 1 : 0, now(), id);
      if (result.changes === 0) throw new Error('Customer not found');
      this.enqueueEntity('customer', id);
      this.addAudit(
        active ? 'customer.activated' : 'customer.deactivated',
        'customer',
        id,
        {},
      );
    })();
  }

  setCustomerBlocked(id: string, blocked: boolean): void {
    this.connection.transaction(() => {
      const result = this.connection
        .prepare(
          'UPDATE customers SET blocked = ?, updated_at = ? WHERE id = ?',
        )
        .run(blocked ? 1 : 0, now(), id);
      if (result.changes === 0) throw new Error('Customer not found');
      this.enqueueEntity('customer', id);
      this.addAudit(
        blocked ? 'customer.blocked' : 'customer.unblocked',
        'customer',
        id,
        {},
      );
    })();
  }

  generateAccountNumber(): string {
    const rows = this.connection
      .prepare('SELECT account_number FROM customers')
      .all() as Array<{ account_number: string }>;
    let max = 1000;
    for (const row of rows) {
      const match = /^(\d+)$/.exec(row.account_number.trim());
      if (match) {
        const num = Number(match[1]);
        if (num > max && num < 1_000_000_000) max = num;
      }
    }
    return String(max + 1);
  }

  generateCustomerBarcode(): string {
    return `SSM-CUST-${Date.now().toString(36).toUpperCase()}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  }

  lookupCustomerByBarcodeOrAccount(value: string): Customer | null {
    const clean = value.trim();
    if (!clean) return null;
    const row = this.connection
      .prepare(
        'SELECT * FROM customers WHERE account_barcode = ? COLLATE NOCASE OR account_number = ? COLLATE NOCASE',
      )
      .get(clean, clean) as Row | undefined;
    if (!row) return null;
    const settings = this.getSettings();
    return this.mapCustomer(row, settings);
  }

  getCustomerBalance(customerId: string): number {
    const row = this.connection
      .prepare(
        'SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM customer_ledger WHERE customer_id = ?',
      )
      .get(customerId) as { balance: unknown } | undefined;
    return readSafeCents(row?.balance ?? 0, 'Customer balance');
  }

  listCustomerLedger(customerId: string): CustomerLedgerEntry[] {
    const rows = this.connection
      .prepare(
        `
        SELECT
          l.*,
          s.receipt_number AS sale_receipt_number,
          p.receipt_number AS payment_receipt_number,
          SUM(l.amount_cents) OVER (
            PARTITION BY l.customer_id ORDER BY l.occurred_at, l.sequence ROWS UNBOUNDED PRECEDING
          ) AS resulting_balance_cents
        FROM customer_ledger l
        LEFT JOIN sales s ON s.id = l.related_sale_id
        LEFT JOIN account_payments p ON p.id = l.related_account_payment_id
        WHERE l.customer_id = ?
        ORDER BY l.occurred_at DESC, l.sequence DESC
      `,
      )
      .all(customerId) as Row[];
    return rows.map(mapLedgerEntry);
  }

  // --- CHECKOUT & SALES ---

  lookupProductByBarcode(value: string): Product | null {
    const clean = value.trim();
    if (!clean) throw new Error('Barcode is required');
    const row = this.connection
      .prepare(
        'SELECT product_id FROM product_barcodes WHERE value = ? COLLATE NOCASE',
      )
      .get(clean) as { product_id: string } | undefined;
    if (!row) return null;
    const product = this.getProduct(row.product_id);
    return product.active ? product : null;
  }

  getProcessorStorage() {
    return {
      get: async (key: string) => {
        const row = this.connection
          .prepare(
            'SELECT payload_json FROM simulated_processor_store WHERE key = ?',
          )
          .get(key) as { payload_json: string } | undefined;
        if (!row) return undefined;
        return JSON.parse(row.payload_json);
      },
      set: async (key: string, value: any) => {
        this.connection
          .prepare(
            'INSERT INTO simulated_processor_store (key, payload_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json',
          )
          .run(key, JSON.stringify(value));
      },
      delete: async (key: string) => {
        this.connection
          .prepare('DELETE FROM simulated_processor_store WHERE key = ?')
          .run(key);
      },
    };
  }

  /**
   * The shared Manager/Kiosk payment service. Created lazily so that the database stays
   * usable without payments being wired up (tests, restores, migrations).
   */
  get payments(): PaymentService {
    this.paymentService ??= new PaymentService(this, this.secretStore);
    return this.paymentService;
  }

  /**
   * Sweeps every unresolved charge through the shared payment service. Transactions that
   * already need an operator are left alone; use `payments.resolveNeedsAttention`.
   */
  async runStartupReconciliation() {
    await this.payments.reconcileAll();
  }

  createPaymentTransaction(
    chargeReference: string,
    processorId: string,
    amountCents: number,
    cartSnapshotJson: string,
    idempotencyKey: string,
    kioskId: string | null = null,
    reservations: { productId: string; quantity: number }[] = [],
    identity: {
      snapshotHash?: string | null;
      processorConfigHash?: string | null;
      processorConfigSecret?: string | null;
      originChannel?: 'manager' | 'kiosk';
    } = {},
  ): void {
    const timestamp = now();
    const normalizedReservations = new Map<string, number>();
    for (const reservation of reservations) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          reservation.productId,
        ) ||
        !Number.isSafeInteger(reservation.quantity) ||
        reservation.quantity < 1 ||
        reservation.quantity > 10000
      )
        throw new Error('Invalid inventory reservation');
      if (normalizedReservations.has(reservation.productId))
        throw new Error('Duplicate inventory reservation product');
      normalizedReservations.set(reservation.productId, reservation.quantity);
    }
    this.connection.transaction(() => {
      // Check finding 6: Nothing blocks re-charging while an 'unknown'/'initiated' transaction exists
      const existingActive = this.connection
        .prepare(
          "SELECT id FROM payment_transactions WHERE idempotency_key = ? AND status IN ('initiated', 'unknown')",
        )
        .get(idempotencyKey);
      if (existingActive)
        throw new Error(
          'A payment is already in progress for this cart. Please check its status.',
        );

      for (const [productId, quantity] of normalizedReservations) {
        const product = this.getProduct(productId);
        if (
          !product.active ||
          quantity >
            product.stockQuantity - this.heldQuantityFor(productId, null)
        )
          throw new Error('Cart is no longer available');
      }
      this.connection
        .prepare(
          `INSERT INTO payment_transactions (
            id, charge_reference, processor_id, amount_cents, status,
            cart_snapshot_json, idempotency_key, kiosk_id, created_at, updated_at,
            snapshot_hash, processor_config_hash, processor_config_secret, origin_channel
          ) VALUES (?, ?, ?, ?, 'initiated', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          chargeReference,
          processorId,
          amountCents,
          cartSnapshotJson,
          idempotencyKey,
          kioskId,
          timestamp,
          timestamp,
          identity.snapshotHash ?? null,
          identity.processorConfigHash ?? null,
          identity.processorConfigSecret ?? null,
          identity.originChannel ?? (kioskId ? 'kiosk' : 'manager'),
        );

      const tx = this.connection
        .prepare(
          'SELECT id FROM payment_transactions WHERE charge_reference = ?',
        )
        .get(chargeReference) as { id: string };

      for (const [productId, quantity] of normalizedReservations) {
        this.connection
          .prepare(
            "INSERT INTO payment_inventory_reservations (id,charge_reference,product_id,quantity,status,created_at) VALUES (?, ?, ?, ?, 'held', ?)",
          )
          .run(randomUUID(), chargeReference, productId, quantity, timestamp);
      }
      this.enqueueEntity('payment_transaction', tx.id);
    })();
  }

  updatePaymentTransactionStatus(
    chargeReference: string,
    status:
      | 'approved'
      | 'declined'
      | 'error'
      | 'unknown'
      | 'reconciled'
      | 'needs-attention',
    processorTransactionId?: string | null,
    cardBrand?: string | null,
    cardLast4?: string | null,
  ): void {
    const timestamp = now();
    this.connection.transaction(() => {
      const tx = this.connection
        .prepare(
          'SELECT id FROM payment_transactions WHERE charge_reference = ?',
        )
        .get(chargeReference) as { id: string } | undefined;

      if (!tx) throw new Error('Payment transaction not found');

      this.connection
        .prepare(
          `UPDATE payment_transactions SET
            status = ?,
            processor_transaction_id = COALESCE(?, processor_transaction_id),
            card_brand = COALESCE(?, card_brand),
            card_last4 = COALESCE(?, card_last4),
            updated_at = ?
           WHERE charge_reference = ?`,
        )
        .run(
          status,
          processorTransactionId ?? null,
          cardBrand ?? null,
          cardLast4 ?? null,
          timestamp,
          chargeReference,
        );

      if (status === 'declined' || status === 'error') {
        this.connection
          .prepare(
            "UPDATE payment_inventory_reservations SET status='released', resolved_at=? WHERE charge_reference=? AND status='held'",
          )
          .run(timestamp, chargeReference);
      }
      this.enqueueEntity('payment_transaction', tx.id);
    })();
  }

  getPendingPaymentTransactions() {
    return this.connection
      .prepare(
        `SELECT * FROM payment_transactions WHERE status IN ('initiated', 'unknown', 'needs-attention') AND sale_id IS NULL`,
      )
      .all() as Row[];
  }

  /** Charges the automatic sweep may still resolve on its own. */
  getReconcilablePaymentTransactions() {
    return this.connection
      .prepare(
        `SELECT * FROM payment_transactions WHERE status IN ('initiated', 'unknown') AND sale_id IS NULL ORDER BY created_at`,
      )
      .all() as Row[];
  }

  /** Approved-but-unfinalizable charges waiting on an operator. */
  getNeedsAttentionPaymentTransactions() {
    return this.connection
      .prepare(
        `SELECT * FROM payment_transactions WHERE status = 'needs-attention' AND sale_id IS NULL ORDER BY updated_at`,
      )
      .all() as Row[];
  }

  /** Quantity currently held by card reservations, optionally ignoring one charge. */
  heldQuantityFor(productId: string, excludeChargeReference: string | null) {
    const row = this.connection
      .prepare(
        "SELECT COALESCE(SUM(quantity),0) AS quantity FROM payment_inventory_reservations WHERE product_id=? AND status='held' AND (? IS NULL OR charge_reference != ?)",
      )
      .get(productId, excludeChargeReference, excludeChargeReference) as Row;
    return Number(row.quantity);
  }

  listReservations(
    chargeReference: string,
  ): { productId: string; quantity: number; status: string }[] {
    return (
      this.connection
        .prepare(
          'SELECT product_id, quantity, status FROM payment_inventory_reservations WHERE charge_reference=? ORDER BY product_id',
        )
        .all(chargeReference) as Row[]
    ).map((row) => ({
      productId: String(row.product_id),
      quantity: Number(row.quantity),
      status: String(row.status),
    }));
  }

  releaseReservations(chargeReference: string): void {
    this.connection.transaction(() => {
      this.connection
        .prepare(
          "UPDATE payment_inventory_reservations SET status='released', resolved_at=? WHERE charge_reference=? AND status='held'",
        )
        .run(now(), chargeReference);
    })();
  }

  /**
   * Records why an approved charge could not be finalized. `setStatus` promotes the row to
   * `needs-attention`; pass false to only annotate a charge an operator already triaged.
   */
  markPaymentNeedsAttention(
    chargeReference: string,
    reason: string,
    setStatus = true,
  ): void {
    const timestamp = now();
    this.connection.transaction(() => {
      const tx = this.connection
        .prepare(
          'SELECT id, status FROM payment_transactions WHERE charge_reference = ?',
        )
        .get(chargeReference) as { id: string; status: string } | undefined;
      if (!tx) throw new Error('Payment transaction not found');
      if (setStatus)
        this.connection
          .prepare(
            `UPDATE payment_transactions SET status='needs-attention', attention_reason=?, updated_at=? WHERE id=?`,
          )
          .run(reason, timestamp, tx.id);
      else
        this.connection
          .prepare(
            'UPDATE payment_transactions SET attention_reason=?, updated_at=? WHERE id=?',
          )
          .run(reason, timestamp, tx.id);
      this.enqueueEntity('payment_transaction', tx.id);
    })();
  }

  /** Marks a charge as successfully finalized from its frozen snapshot. */
  markPaymentFinalized(chargeReference: string): void {
    const timestamp = now();
    this.connection.transaction(() => {
      const tx = this.connection
        .prepare(
          'SELECT id FROM payment_transactions WHERE charge_reference = ?',
        )
        .get(chargeReference) as { id: string } | undefined;
      if (!tx) throw new Error('Payment transaction not found');
      this.connection
        .prepare(
          'UPDATE payment_transactions SET attention_reason=NULL, finalized_at=?, updated_at=? WHERE id=?',
        )
        .run(timestamp, timestamp, tx.id);
      this.enqueueEntity('payment_transaction', tx.id);
    })();
  }

  /** Active (non-revoked) kiosk identity, used to authorize kiosk-originated charges. */
  getActiveKiosk(
    id: string,
  ): { id: string; name: string; lastSeenAt: string | null } | null {
    const row = this.connection
      .prepare(
        'SELECT id,name,last_seen_at FROM kiosks WHERE id=? AND revoked_at IS NULL',
      )
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    };
  }

  getKioskServerSettings(): { enabled: boolean; port: number } {
    const r = this.connection
      .prepare(
        'SELECT enabled,port FROM kiosk_server_settings WHERE singleton_id=1',
      )
      .get() as Row;
    return { enabled: Boolean(r.enabled), port: Number(r.port) };
  }
  setKioskServerSettings(enabled: boolean, port: number): void {
    this.connection
      .prepare(
        'UPDATE kiosk_server_settings SET enabled=?,port=? WHERE singleton_id=1',
      )
      .run(enabled ? 1 : 0, port);
  }

  // --- KIOSK PAIRING ---
  createKiosk(
    id: string,
    name: string,
    tokenHash: string,
    pinHash: string,
  ): void {
    this.connection
      .prepare(
        'INSERT INTO kiosks (id,name,token_hash,admin_pin_hash,created_at) VALUES (?,?,?,?,?)',
      )
      .run(id, name, tokenHash, pinHash, now());
    this.enqueueEntity('kiosk', id);
  }
  getKioskAdminPinHash(id: string): string | null {
    const row = this.connection
      .prepare('SELECT admin_pin_hash FROM kiosks WHERE id=?')
      .get(id) as { admin_pin_hash?: unknown } | undefined;
    return row?.admin_pin_hash === undefined || row.admin_pin_hash === null
      ? null
      : String(row.admin_pin_hash);
  }
  setKioskAdminPinHash(id: string, pinHash: string): void {
    this.connection
      .prepare('UPDATE kiosks SET admin_pin_hash=? WHERE id=?')
      .run(pinHash, id);
  }
  findKioskByTokenHash(
    tokenHash: string,
  ): { id: string; name: string; last_seen_at: string | null } | undefined {
    return this.connection
      .prepare(
        'SELECT id,name,last_seen_at FROM kiosks WHERE token_hash=? AND revoked_at IS NULL',
      )
      .get(tokenHash) as
      { id: string; name: string; last_seen_at: string | null } | undefined;
  }
  listKiosks(): KioskSummary[] {
    return (
      this.connection
        .prepare(
          'SELECT id,name,last_seen_at,revoked_at FROM kiosks ORDER BY name',
        )
        .all() as Row[]
    ).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      lastSeenAt: r.last_seen_at ? String(r.last_seen_at) : null,
      revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    }));
  }
  touchKiosk(id: string): void {
    this.connection
      .prepare('UPDATE kiosks SET last_seen_at=? WHERE id=?')
      .run(now(), id);
  }
  revokeKiosk(id: string): void {
    const result = this.connection
      .prepare(
        'UPDATE kiosks SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
      )
      .run(now(), id);
    if (result.changes === 0)
      throw new Error('Kiosk not found or already revoked');
    this.enqueueEntity('kiosk', id);
  }
  attributeKioskSale(saleId: string, kioskId: string): void {
    this.connection
      .prepare("UPDATE sales SET channel='kiosk', kiosk_id=? WHERE id=?")
      .run(kioskId, saleId);
  }

  getPaymentTransactionByIdempotencyKey(idempotencyKey: string) {
    return this.connection
      .prepare(`SELECT * FROM payment_transactions WHERE idempotency_key = ?`)
      .get(idempotencyKey) as Row | undefined;
  }

  getPaymentTransaction(chargeReference: string) {
    return this.connection
      .prepare(`SELECT * FROM payment_transactions WHERE charge_reference = ?`)
      .get(chargeReference) as Row | undefined;
  }

  completeSale(
    input: import('@shul-store/shared').CompleteSaleInput,
    snapshot?: import('@shul-store/shared').CartSnapshot,
    kioskId: string | null = null,
  ): import('@shul-store/shared').Sale {
    const value = completeSaleInputSchema.parse(input);
    const settings = this.getSettings();

    // Check existing completion key idempotency before transaction
    const existingPre = this.connection
      .prepare('SELECT id FROM sales WHERE completion_key = ?')
      .get(value.completionKey) as { id: string } | undefined;
    if (existingPre) {
      // Exact-once: the shared payment service may already have finalized this charge
      // from its frozen snapshot, so replaying the same completion returns the same sale.
      if (value.payment.method === 'integrated_card') {
        const linked = this.connection
          .prepare(
            'SELECT sale_id FROM payment_transactions WHERE charge_reference = ?',
          )
          .get(value.payment.chargeReference) as
          { sale_id: string | null } | undefined;
        if (linked?.sale_id === existingPre.id)
          return this.getSale(existingPre.id);
      }
      this.validateExistingSaleMatch(existingPre.id, value);
      if (value.payment.method === 'integrated_card') {
        const existingTx = this.connection
          .prepare(
            'SELECT id, status, amount_cents FROM payment_transactions WHERE sale_id = ?',
          )
          .get(existingPre.id) as any;
        if (
          existingTx &&
          value.payment.chargeReference !== existingTx.charge_reference
        ) {
          throw new Error(
            'A sale with this completion key was already paid for with a different charge reference',
          );
        }
      }
      return this.getSale(existingPre.id);
    }

    const saleId = randomUUID();

    try {
      this.connection.transaction(() => {
        const again = this.connection
          .prepare('SELECT id FROM sales WHERE completion_key = ?')
          .get(value.completionKey) as { id: string } | undefined;
        if (again) {
          if (value.payment.method === 'integrated_card') {
            const linked = this.connection
              .prepare(
                'SELECT sale_id FROM payment_transactions WHERE charge_reference = ?',
              )
              .get(value.payment.chargeReference) as
              { sale_id: string | null } | undefined;
            if (linked?.sale_id === again.id) return;
          }
          this.validateExistingSaleMatch(again.id, value);
          if (value.payment.method === 'integrated_card') {
            const existingTx = this.connection
              .prepare(
                'SELECT id, charge_reference FROM payment_transactions WHERE sale_id = ?',
              )
              .get(again.id) as any;
            if (
              existingTx &&
              value.payment.chargeReference !== existingTx.charge_reference
            ) {
              throw new Error(
                'A sale with this completion key was already paid for with a different charge reference',
              );
            }
          }
          return;
        }

        // Merge cart lines with normalized barcode provenance
        const merged = new Map<
          string,
          { product: Product; quantity: number; barcodeUsed: string | null }
        >();
        for (const line of value.lines) {
          const cleanBarcode = line.barcodeUsed?.trim() || null;
          const key = `${line.productId}::${cleanBarcode ?? ''}`;
          const current = merged.get(key);
          if (current) {
            current.quantity += line.quantity;
          } else {
            merged.set(key, {
              product: this.getProduct(line.productId),
              quantity: line.quantity,
              barcodeUsed: cleanBarcode,
            });
          }
        }
        const snapshots = [...merged.values()];

        // Aggregate stock demand per product ID
        const productDemand = new Map<string, number>();
        for (const line of snapshots) {
          productDemand.set(
            line.product.id,
            (productDemand.get(line.product.id) ?? 0) + line.quantity,
          );
        }

        for (const [prodId, qty] of productDemand) {
          const product = this.getProduct(prodId);
          if (!product.active) {
            throw new Error(`${product.name} is inactive and cannot be sold.`);
          }
          const held = this.connection
            .prepare(
              "SELECT COALESCE(SUM(quantity),0) AS quantity FROM payment_inventory_reservations WHERE product_id=? AND status='held' AND charge_reference != ?",
            )
            .get(
              prodId,
              value.payment.method === 'integrated_card'
                ? value.payment.chargeReference
                : '',
            ) as Row;
          const available = product.stockQuantity - Number(held.quantity);
          if (qty > available) {
            throw new Error(
              `Insufficient stock for ${product.name}. Available: ${available}.`,
            );
          }
        }

        for (const line of snapshots) {
          if (
            line.barcodeUsed &&
            !line.product.barcodes.some(
              (barcode) =>
                barcode.value.toLowerCase() === line.barcodeUsed?.toLowerCase(),
            )
          ) {
            throw new Error('Barcode does not belong to the selected product.');
          }
        }

        const totals =
          snapshot?.totals ||
          calculateCart(
            snapshots.map((line) => ({
              product: line.product,
              quantity: line.quantity,
            })),
            settings,
          );

        let customerSnapshot: {
          id: string;
          name: string;
          accountNumber: string;
          balanceBeforeCents: number;
          balanceAfterCents: number;
        } | null = null;

        if (value.payment.method === 'account') {
          if (totals.totalCents <= 0) {
            throw new Error(
              'Account tender cannot be used for a $0.00 sale. Please use cash or external terminal checkout.',
            );
          }

          if (!settings.customerAccountsEnabled) {
            throw new Error(
              'Customer accounts are currently disabled in store settings.',
            );
          }
          const customerRow = this.connection
            .prepare('SELECT * FROM customers WHERE id = ?')
            .get(value.payment.customerId) as Row | undefined;
          if (!customerRow) throw new Error('Customer not found');
          if (!customerRow.active) {
            throw new Error(
              'Customer is inactive and cannot place charges on account.',
            );
          }
          if (customerRow.blocked) {
            throw new Error(
              'Customer is blocked from placing charges on account.',
            );
          }

          const currentBalance = this.getCustomerBalance(
            String(customerRow.id),
          );
          const effectiveCreditLimit =
            customerRow.credit_limit_cents !== null &&
            customerRow.credit_limit_cents !== undefined
              ? readSafeCents(
                  customerRow.credit_limit_cents,
                  'credit_limit_cents',
                )
              : settings.defaultCreditLimitCents;

          readSafeCents(effectiveCreditLimit, 'Credit limit');
          const projectedBalanceBig =
            BigInt(currentBalance) + BigInt(totals.totalCents);
          const projectedBalance = readSafeCents(
            projectedBalanceBig,
            'Projected balance',
          );

          if (projectedBalance > effectiveCreditLimit) {
            throw new Error(
              `Credit limit exceeded. Account limit is $${(effectiveCreditLimit / 100).toFixed(2)}, current balance is $${(currentBalance / 100).toFixed(2)}, and purchase total is $${(totals.totalCents / 100).toFixed(2)}.`,
            );
          }

          customerSnapshot = {
            id: String(customerRow.id),
            name: String(customerRow.name),
            accountNumber: String(customerRow.account_number),
            balanceBeforeCents: currentBalance,
            balanceAfterCents: projectedBalance,
          };
        } else if (
          value.payment.method === 'cash' &&
          value.payment.cashReceivedCents < totals.totalCents
        ) {
          throw new Error('Cash received is less than the amount due.');
        }

        const timestamp = now();
        const receipt = Number(
          (
            this.connection
              .prepare(
                'SELECT COALESCE(MAX(receipt_number),0)+1 AS next FROM sales',
              )
              .get() as Row
          ).next,
        );

        this.connection
          .prepare(
            `INSERT INTO sales (
              id, receipt_number, completion_key, status, subtotal_cents, tax_cents, total_cents,
              created_at, customer_id, customer_name, customer_account_number, customer_balance_before_cents,
              customer_balance_after_cents, tender_type, channel, kiosk_id
            ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            saleId,
            receipt,
            value.completionKey,
            totals.subtotalCents,
            totals.taxCents,
            totals.totalCents,
            timestamp,
            customerSnapshot?.id ?? null,
            customerSnapshot?.name ?? null,
            customerSnapshot?.accountNumber ?? null,
            customerSnapshot?.balanceBeforeCents ?? null,
            customerSnapshot?.balanceAfterCents ?? null,
            value.payment.method === 'integrated_card'
              ? 'immediate_payment'
              : value.payment.method,
            kioskId ? 'kiosk' : 'manager',
            kioskId,
          );

        this.connection
          .prepare("UPDATE sales SET status='awaiting_payment' WHERE id=?")
          .run(saleId);

        const insertItem = this.connection.prepare(
          `INSERT INTO sale_items (
            id, sale_id, product_id, product_name, secondary_name, barcode_used,
            quantity, unit_selling_price_cents, unit_purchase_cost_cents, taxable,
            tax_cents, line_subtotal_cents, line_total_cents
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        if (snapshot && snapshot.lines) {
          snapshot.lines.forEach((line) => {
            insertItem.run(
              randomUUID(),
              saleId,
              line.productId,
              line.productName,
              line.secondaryName,
              line.barcodeUsed,
              line.quantity,
              line.unitSellingPriceCents,
              line.unitPurchaseCostCents,
              line.taxable ? 1 : 0,
              line.taxCents,
              line.subtotalCents,
              line.totalCents,
            );
          });
        } else {
          snapshots.forEach((line, index) => {
            const calculated = totals.lines[index]!;
            insertItem.run(
              randomUUID(),
              saleId,
              line.product.id,
              line.product.name,
              line.product.secondaryName,
              line.barcodeUsed ?? null,
              line.quantity,
              line.product.sellingPriceCents,
              line.product.purchaseCostCents,
              line.product.taxable ? 1 : 0,
              calculated.taxCents,
              calculated.subtotalCents,
              calculated.totalCents,
            );
          });
        }

        const sumLineTotals = this.connection
          .prepare(
            'SELECT COALESCE(SUM(line_total_cents), 0) as s FROM sale_items WHERE sale_id = ?',
          )
          .get(saleId) as { s: number };
        if (sumLineTotals.s !== totals.totalCents) {
          throw new Error(
            `Line totals sum ${sumLineTotals.s} does not match sale total ${totals.totalCents}`,
          );
        }

        for (const [prodId, totalQty] of productDemand) {
          this.connection
            .prepare(
              `INSERT INTO inventory_movements (
                id, operation_id, product_id, quantity_change, reason, occurred_at,
                device_id, related_sale_id, notes, sequence
              ) VALUES (?, ?, ?, ?, 'sale', ?, NULL, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM inventory_movements))`,
            )
            .run(
              randomUUID(),
              randomUUID(),
              prodId,
              -totalQty,
              timestamp,
              saleId,
              `Sale #${receipt}`,
            );
        }

        if (value.payment.method === 'cash') {
          this.connection
            .prepare(
              `INSERT INTO payments (id, sale_id, method, amount_cents, cash_received_cents, change_due_cents, created_at) VALUES (?, ?, 'cash', ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              saleId,
              totals.totalCents,
              value.payment.cashReceivedCents,
              calculateCashChange(
                totals.totalCents,
                value.payment.cashReceivedCents,
              ),
              timestamp,
            );
          this.connection
            .prepare("UPDATE sales SET status='paid' WHERE id=?")
            .run(saleId);
        } else if (value.payment.method === 'external_terminal') {
          const cleanRef = value.payment.terminalReference?.trim() || null;
          this.connection
            .prepare(
              `INSERT INTO payments (id, sale_id, method, amount_cents, terminal_reference, external_approved, created_at) VALUES (?, ?, 'external_terminal', ?, ?, 1, ?)`,
            )
            .run(randomUUID(), saleId, totals.totalCents, cleanRef, timestamp);
          this.connection
            .prepare("UPDATE sales SET status='paid' WHERE id=?")
            .run(saleId);
        } else if (value.payment.method === 'account' && customerSnapshot) {
          this.connection
            .prepare(
              `INSERT INTO customer_ledger (
                id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
                related_sale_id, related_account_payment_id, device_id, notes, sequence
              ) VALUES (?, ?, ?, ?, 'sale_charge', ?, ?, NULL, NULL, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM customer_ledger))`,
            )
            .run(
              randomUUID(),
              randomUUID(),
              customerSnapshot.id,
              totals.totalCents,
              timestamp,
              saleId,
              `Sale #${receipt}`,
            );
        } else if (value.payment.method === 'integrated_card') {
          const txRow = this.connection
            .prepare(
              `SELECT id, status, amount_cents, sale_id FROM payment_transactions WHERE charge_reference = ?`,
            )
            .get(value.payment.chargeReference) as
            | {
                id: string;
                status: string;
                amount_cents: number;
                sale_id: string | null;
              }
            | undefined;

          if (!txRow)
            throw new Error(
              'Payment transaction not found for integrated card checkout',
            );
          if (txRow.status !== 'approved')
            throw new Error(
              `Cannot complete sale for payment transaction in status: ${txRow.status}`,
            );
          if (txRow.amount_cents !== totals.totalCents && !snapshot)
            throw new Error(
              'Payment transaction amount mismatch with sale total',
            );
          if (txRow.sale_id)
            throw new Error('Payment transaction is already linked to a sale');

          this.connection
            .prepare(
              `UPDATE payment_transactions SET sale_id = ?, updated_at = ? WHERE id = ?`,
            )
            .run(saleId, timestamp, txRow.id);

          this.connection
            .prepare(
              "UPDATE payment_inventory_reservations SET status='consumed', resolved_at=? WHERE charge_reference=? AND status='held'",
            )
            .run(timestamp, value.payment.chargeReference);

          this.connection
            .prepare("UPDATE sales SET status='paid' WHERE id=?")
            .run(saleId);
        }

        this.connection
          .prepare(
            "UPDATE sales SET status='completed', completed_at=? WHERE id=?",
          )
          .run(timestamp, saleId);

        this.enqueueEntity('sale', saleId);

        if (value.payment.method === 'integrated_card') {
          const txRow = this.connection
            .prepare(
              'SELECT id FROM payment_transactions WHERE charge_reference = ?',
            )
            .get(value.payment.chargeReference) as any;
          if (txRow) this.enqueueEntity('payment_transaction', txRow.id);
        }
        this.addAudit('sale.completed', 'sale', saleId, {
          receiptNumber: receipt,
          totalCents: totals.totalCents,
          paymentMethod: value.payment.method,
          customerId: customerSnapshot?.id,
          customerName: customerSnapshot?.name,
          accountNumber: customerSnapshot?.accountNumber,
          previousBalanceCents: customerSnapshot?.balanceBeforeCents,
          newBalanceCents: customerSnapshot?.balanceAfterCents,
        });
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }

    const completed = this.connection
      .prepare('SELECT id FROM sales WHERE completion_key=?')
      .get(value.completionKey) as { id: string } | undefined;
    if (!completed) throw new Error('Sale completion failed');
    return this.getSale(completed.id);
  }

  private validateExistingSaleMatch(
    existingSaleId: string,
    input: CompleteSaleInput,
  ): void {
    const sale = this.connection
      .prepare('SELECT * FROM sales WHERE id = ?')
      .get(existingSaleId) as Row | undefined;
    if (!sale) {
      throw new Error('Existing sale not found for idempotency comparison');
    }

    const items = this.connection
      .prepare(
        'SELECT product_id, quantity, barcode_used FROM sale_items WHERE sale_id = ?',
      )
      .all(existingSaleId) as Row[];

    const payment = this.connection
      .prepare('SELECT * FROM payments WHERE sale_id = ?')
      .get(existingSaleId) as Row | undefined;

    // 1. Compare tender method
    const existingTender = String(sale.tender_type ?? '');
    if (existingTender !== input.payment.method) {
      throw new Error(
        'A sale with this completion key already exists with different details.',
      );
    }

    // 2. Compare payment-specific details
    if (input.payment.method === 'account') {
      const existingCustomerId = sale.customer_id
        ? String(sale.customer_id)
        : null;
      if (existingCustomerId !== input.payment.customerId) {
        throw new Error(
          'A sale with this completion key already exists with different details.',
        );
      }
    } else if (input.payment.method === 'cash') {
      if (!payment) {
        throw new Error(
          'A sale with this completion key already exists with different details.',
        );
      }
      const existingCashReceived = readNullableSafeCents(
        payment!.cash_received_cents,
        'cash_received_cents',
      );
      if (existingCashReceived !== input.payment.cashReceivedCents) {
        throw new Error(
          'A sale with this completion key already exists with different details.',
        );
      }
    } else if (input.payment.method === 'external_terminal') {
      if (!payment) {
        throw new Error(
          'A sale with this completion key already exists with different details.',
        );
      }
      const existingRef =
        (payment!.terminal_reference
          ? String(payment!.terminal_reference).trim()
          : null) || null;
      const inputRef = input.payment.terminalReference?.trim() || null;
      if (existingRef !== inputRef) {
        throw new Error(
          'A sale with this completion key already exists with different details.',
        );
      }
    }

    // 3. Compare normalized cart lines (order-independent comparison of product_id, barcode_used, quantity)
    const incomingMerged = new Map<
      string,
      { productId: string; barcodeUsed: string | null; quantity: number }
    >();
    for (const line of input.lines) {
      const cleanBarcode = line.barcodeUsed?.trim() || null;
      const key = `${line.productId}::${cleanBarcode ?? ''}`;
      const current = incomingMerged.get(key);
      if (current) {
        current.quantity += line.quantity;
      } else {
        incomingMerged.set(key, {
          productId: line.productId,
          barcodeUsed: cleanBarcode,
          quantity: line.quantity,
        });
      }
    }

    const persistedMerged = new Map<
      string,
      { productId: string; barcodeUsed: string | null; quantity: number }
    >();
    for (const item of items) {
      const cleanBarcode = item.barcode_used
        ? String(item.barcode_used).trim() || null
        : null;
      const key = `${String(item.product_id)}::${cleanBarcode ?? ''}`;
      const current = persistedMerged.get(key);
      if (current) {
        current.quantity += Number(item.quantity);
      } else {
        persistedMerged.set(key, {
          productId: String(item.product_id),
          barcodeUsed: cleanBarcode,
          quantity: Number(item.quantity),
        });
      }
    }

    if (incomingMerged.size !== persistedMerged.size) {
      throw new Error(
        'A sale with this completion key already exists with different details.',
      );
    }

    for (const [key, incomingItem] of incomingMerged) {
      const persistedItem = persistedMerged.get(key);
      if (!persistedItem || persistedItem.quantity !== incomingItem.quantity) {
        throw new Error(
          'A sale with this completion key already exists with different details.',
        );
      }
    }
  }

  listSales(): Sale[] {
    return (
      this.connection
        .prepare(
          "SELECT id FROM sales WHERE status IN ('completed','refunded') ORDER BY completed_at DESC, receipt_number DESC",
        )
        .all() as Array<{ id: string }>
    ).map((row) => this.getSale(row.id));
  }

  getSale(id: string): Sale {
    const sale = this.connection
      .prepare('SELECT * FROM sales WHERE id=?')
      .get(id) as Row | undefined;
    if (!sale) throw new Error('Sale not found');

    const items = this.connection
      .prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY rowid')
      .all(id) as Row[];

    const payment = this.connection
      .prepare('SELECT * FROM payments WHERE sale_id=?')
      .get(id) as Row | undefined;

    const tenderType = String(sale.tender_type || 'cash');

    let salePayment: Sale['payment'];
    if (tenderType === 'account') {
      salePayment = {
        method: 'account',
        amountCents: readSafeCents(sale.total_cents, 'sale total_cents'),
        cashReceivedCents: null,
        changeDueCents: null,
        terminalReference: null,
        externalApproved: null,
        customerId: sale.customer_id ? String(sale.customer_id) : null,
        customerName: sale.customer_name ? String(sale.customer_name) : null,
        accountNumber: sale.customer_account_number
          ? String(sale.customer_account_number)
          : null,
        previousBalanceCents: readNullableSafeCents(
          sale.customer_balance_before_cents,
          'customer_balance_before_cents',
        ),
        newBalanceCents: readNullableSafeCents(
          sale.customer_balance_after_cents,
          'customer_balance_after_cents',
        ),
      };
    } else if (tenderType === 'immediate_payment') {
      const tx = this.connection
        .prepare('SELECT * FROM payment_transactions WHERE sale_id=?')
        .get(id) as Row | undefined;

      if (tx) {
        salePayment = {
          method: 'integrated_card',
          amountCents: readSafeCents(sale.total_cents, 'sale total_cents'),
          cashReceivedCents: null,
          changeDueCents: null,
          terminalReference: null,
          externalApproved: null,
          chargeReference: String(tx.charge_reference),
          processorTransactionId: tx.processor_transaction_id
            ? String(tx.processor_transaction_id)
            : null,
          cardBrand: tx.card_brand ? String(tx.card_brand) : null,
          cardLast4: tx.card_last4 ? String(tx.card_last4) : null,
        };
      } else {
        if (!payment) {
          console.error('Sale payment not found');
          salePayment = {
            method: 'cash',
            amountCents: 0,
            cashReceivedCents: null,
            changeDueCents: null,
            terminalReference: null,
            externalApproved: null,
          };
        } else {
          salePayment = {
            method: String(payment.method) as 'cash' | 'external_terminal',
            amountCents: readSafeCents(
              payment!.amount_cents,
              'payment amount_cents',
            ),
            cashReceivedCents: readNullableSafeCents(
              payment!.cash_received_cents,
              'cash_received_cents',
            ),
            changeDueCents: readNullableSafeCents(
              payment!.change_due_cents,
              'change_due_cents',
            ),
            terminalReference:
              payment!.terminal_reference === null
                ? null
                : String(payment!.terminal_reference),
            externalApproved:
              payment!.external_approved === null
                ? null
                : Boolean(payment!.external_approved),
          };
        }
      }
    } else {
      if (!payment) {
        console.error('Sale payment not found');
        salePayment = {
          method: 'cash',
          amountCents: 0,
          cashReceivedCents: null,
          changeDueCents: null,
          terminalReference: null,
          externalApproved: null,
        };
      } else {
        salePayment = {
          method: String(payment.method) as 'cash' | 'external_terminal',
          amountCents: readSafeCents(
            payment!.amount_cents,
            'payment amount_cents',
          ),
          cashReceivedCents: readNullableSafeCents(
            payment!.cash_received_cents,
            'cash_received_cents',
          ),
          changeDueCents: readNullableSafeCents(
            payment!.change_due_cents,
            'change_due_cents',
          ),
          terminalReference:
            payment!.terminal_reference === null
              ? null
              : String(payment!.terminal_reference),
          externalApproved:
            payment!.external_approved === null
              ? null
              : Boolean(payment!.external_approved),
        };
      }
    }

    const customerSnapshot = sale.customer_id
      ? {
          id: String(sale.customer_id),
          name: String(sale.customer_name ?? ''),
          accountNumber: String(sale.customer_account_number ?? ''),
          previousBalanceCents: readSafeCents(
            sale.customer_balance_before_cents,
            'customer_balance_before_cents',
          ),
          newBalanceCents: readSafeCents(
            sale.customer_balance_after_cents,
            'customer_balance_after_cents',
          ),
        }
      : null;

    return {
      id: String(sale.id),
      receiptNumber: Number(sale.receipt_number),
      status: String(sale.status) as Sale['status'],
      subtotalCents: readSafeCents(sale.subtotal_cents, 'subtotal_cents'),
      taxCents: readSafeCents(sale.tax_cents, 'tax_cents'),
      totalCents: readSafeCents(sale.total_cents, 'total_cents'),
      createdAt: String(sale.created_at),
      completedAt: sale.completed_at ? String(sale.completed_at) : null,
      channel: sale.channel === 'kiosk' ? 'kiosk' : 'manager',
      kioskId: sale.kiosk_id ? String(sale.kiosk_id) : null,
      items: items.map((row) => ({
        id: String(row.id),
        productId: String(row.product_id),
        productName: String(row.product_name),
        secondaryName: row.secondary_name ? String(row.secondary_name) : null,
        barcodeUsed: row.barcode_used ? String(row.barcode_used) : null,
        quantity: Number(row.quantity),
        unitSellingPriceCents: readSafeCents(
          row.unit_selling_price_cents,
          'unit_selling_price_cents',
        ),
        unitPurchaseCostCents: readSafeCents(
          row.unit_purchase_cost_cents,
          'unit_purchase_cost_cents',
        ),
        taxable: Boolean(row.taxable),
        taxCents: readSafeCents(row.tax_cents, 'tax_cents'),
        lineSubtotalCents: readSafeCents(
          row.line_subtotal_cents,
          'line_subtotal_cents',
        ),
        lineTotalCents: readSafeCents(row.line_total_cents, 'line_total_cents'),
      })),
      payment: salePayment,
      customer: customerSnapshot,
    };
  }

  recordPrintAttempt(
    saleId: string,
    success: boolean,
    error: string | null,
  ): void {
    if (!this.connection.prepare('SELECT id FROM sales WHERE id=?').get(saleId))
      throw new Error('Sale not found');
    this.connection
      .prepare(
        'INSERT INTO print_attempts (id,sale_id,attempted_at,success,error_message) VALUES (?,?,?,?,?)',
      )
      .run(randomUUID(), saleId, now(), success ? 1 : 0, error);
  }

  // --- ACCOUNT PAYMENTS ---

  recordAccountPayment(input: RecordAccountPaymentInput): AccountPayment {
    const value = recordAccountPaymentInputSchema.parse(input);

    const existing = this.connection
      .prepare('SELECT * FROM account_payments WHERE operation_id = ?')
      .get(value.operationId) as Row | undefined;
    if (existing) {
      this.validateExistingAccountPaymentMatch(existing, value);
      return mapAccountPayment(existing);
    }

    const paymentId = randomUUID();
    const timestamp = now();
    const settings = this.getSettings();

    try {
      this.connection.transaction(() => {
        const again = this.connection
          .prepare('SELECT * FROM account_payments WHERE operation_id = ?')
          .get(value.operationId) as Row | undefined;
        if (again) {
          this.validateExistingAccountPaymentMatch(again, value);
          return;
        }

        const customerRow = this.connection
          .prepare('SELECT * FROM customers WHERE id = ?')
          .get(value.customerId) as Row | undefined;
        if (!customerRow) throw new Error('Customer not found');

        const currentBalance = this.getCustomerBalance(String(customerRow.id));
        const paymentAmount = readSafeCents(
          value.amountCents,
          'Payment amount',
        );
        const projectedBalanceBig =
          BigInt(currentBalance) - BigInt(paymentAmount);
        const projectedBalance = readSafeCents(
          projectedBalanceBig,
          'Projected balance',
        );

        if (!settings.allowCustomerCredit && projectedBalance < 0) {
          throw new Error(
            `Payment amount ($${(paymentAmount / 100).toFixed(2)}) exceeds current amount owed ($${(currentBalance / 100).toFixed(2)}) and customer credits are not permitted.`,
          );
        }

        let cashReceivedCents: number | null = null;
        let changeDueCents: number | null = null;
        let terminalReference: string | null = null;
        let externalApproved: number | null = null;

        if (value.payment.method === 'cash') {
          if (value.payment.cashReceivedCents < paymentAmount) {
            throw new Error('Cash received is less than the payment amount.');
          }
          cashReceivedCents = readSafeCents(
            value.payment.cashReceivedCents,
            'Cash received',
          );
          changeDueCents = calculateCashChange(
            paymentAmount,
            cashReceivedCents,
          );
        } else {
          terminalReference = value.payment.terminalReference?.trim() || null;
          externalApproved = 1;
        }

        const receiptNumber = Number(
          (
            this.connection
              .prepare(
                'SELECT COALESCE(MAX(receipt_number), 0) + 1 AS next FROM account_payments',
              )
              .get() as Row
          ).next,
        );

        this.connection
          .prepare(
            `INSERT INTO account_payments (
              id, operation_id, receipt_number, customer_id, customer_name, account_number,
              amount_cents, method, cash_received_cents, change_due_cents, terminal_reference,
              external_approved, previous_balance_cents, new_balance_cents, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            paymentId,
            value.operationId,
            receiptNumber,
            String(customerRow.id),
            String(customerRow.name),
            String(customerRow.account_number),
            paymentAmount,
            value.payment.method,
            cashReceivedCents,
            changeDueCents,
            terminalReference,
            externalApproved,
            currentBalance,
            projectedBalance,
            value.notes?.trim() || null,
            timestamp,
          );

        this.connection
          .prepare(
            `INSERT INTO customer_ledger (
              id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
              related_sale_id, related_account_payment_id, device_id, notes, sequence
            ) VALUES (?, ?, ?, ?, 'payment', ?, NULL, ?, NULL, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM customer_ledger))`,
          )
          .run(
            randomUUID(),
            randomUUID(),
            String(customerRow.id),
            -paymentAmount,
            timestamp,
            paymentId,
            value.notes?.trim() || `Payment #${receiptNumber}`,
          );

        this.enqueueEntity('account_payment', paymentId);
        this.addAudit(
          'customer.payment_recorded',
          'account_payment',
          paymentId,
          {
            receiptNumber,
            customerId: String(customerRow.id),
            customerName: String(customerRow.name),
            accountNumber: String(customerRow.account_number),
            amountCents: paymentAmount,
            method: value.payment.method,
            previousBalanceCents: currentBalance,
            newBalanceCents: projectedBalance,
          },
        );
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }

    const completed = this.connection
      .prepare('SELECT id FROM account_payments WHERE operation_id = ?')
      .get(value.operationId) as { id: string } | undefined;
    if (!completed) throw new Error('Account payment failed');
    return this.getAccountPayment(completed.id);
  }

  private validateExistingAccountPaymentMatch(
    existingRow: Row,
    input: RecordAccountPaymentInput,
  ): void {
    const existingCust = String(existingRow.customer_id);
    const existingAmount = readSafeCents(
      existingRow.amount_cents,
      'existing payment amount_cents',
    );
    const existingMethod = String(existingRow.method);

    if (
      existingCust !== input.customerId ||
      existingAmount !== input.amountCents ||
      existingMethod !== input.payment.method
    ) {
      throw new Error(
        'An account payment with this operation ID already exists with different details.',
      );
    }

    if (input.payment.method === 'cash') {
      const existingCashReceived = readNullableSafeCents(
        existingRow.cash_received_cents,
        'existing cash_received_cents',
      );
      if (existingCashReceived !== input.payment.cashReceivedCents) {
        throw new Error(
          'An account payment with this operation ID already exists with different details.',
        );
      }
    } else if (input.payment.method === 'external_terminal') {
      const existingRef =
        (existingRow.terminal_reference
          ? String(existingRow.terminal_reference).trim()
          : null) || null;
      const inputRef = input.payment.terminalReference?.trim() || null;
      if (existingRef !== inputRef) {
        throw new Error(
          'An account payment with this operation ID already exists with different details.',
        );
      }
    }

    const existingNotes =
      (existingRow.notes ? String(existingRow.notes).trim() : null) || null;
    const inputNotes = input.notes?.trim() || null;
    if (existingNotes !== inputNotes) {
      throw new Error(
        'An account payment with this operation ID already exists with different details.',
      );
    }
  }

  listAccountPayments(customerId?: string): AccountPayment[] {
    const rows = (
      customerId
        ? this.connection
            .prepare(
              'SELECT * FROM account_payments WHERE customer_id = ? ORDER BY created_at DESC, receipt_number DESC',
            )
            .all(customerId)
        : this.connection
            .prepare(
              'SELECT * FROM account_payments ORDER BY created_at DESC, receipt_number DESC',
            )
            .all()
    ) as Row[];
    return rows.map(mapAccountPayment);
  }

  getAccountPayment(id: string): AccountPayment {
    const row = this.connection
      .prepare('SELECT * FROM account_payments WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) throw new Error('Account payment not found');
    return mapAccountPayment(row);
  }

  recordAccountPaymentPrintAttempt(
    paymentId: string,
    success: boolean,
    error: string | null,
  ): void {
    if (
      !this.connection
        .prepare('SELECT id FROM account_payments WHERE id = ?')
        .get(paymentId)
    ) {
      throw new Error('Account payment not found');
    }
    this.connection
      .prepare(
        'INSERT INTO account_payment_print_attempts (id, account_payment_id, attempted_at, success, error_message) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), paymentId, now(), success ? 1 : 0, error);
  }

  // --- STATEMENTS ---

  getCustomerStatement(
    customerId: string,
    optionsInput?: StatementOptions,
  ): CustomerStatementData {
    const customer = this.getCustomer(customerId);
    const settings = this.getSettings();
    const options = statementOptionsSchema.parse(
      optionsInput ?? { range: 'all_activity' },
    );

    let startDate: string | null = null;
    let endDate: string | null = null;
    let label = 'All activity';
    let ledgerRows: Row[];
    let openingBalanceCents = 0;

    if (options.range === 'all_activity') {
      startDate = null;
      endDate = null;
      label = 'All account activity';
      openingBalanceCents = 0;
      ledgerRows = this.connection
        .prepare(
          `
          SELECT
            l.*,
            s.receipt_number AS sale_receipt_number,
            p.receipt_number AS payment_receipt_number
          FROM customer_ledger l
          LEFT JOIN sales s ON s.id = l.related_sale_id
          LEFT JOIN account_payments p ON p.id = l.related_account_payment_id
          WHERE l.customer_id = ?
          ORDER BY l.occurred_at ASC, l.sequence ASC
        `,
        )
        .all(customerId) as Row[];
    } else if (
      options.range === 'last_30_days' ||
      options.range === 'last_90_days'
    ) {
      const days = options.range === 'last_30_days' ? 30 : 90;
      const d = new Date();
      d.setDate(d.getDate() - days);
      startDate = d.toISOString();
      endDate = null;
      label =
        options.range === 'last_30_days' ? 'Last 30 days' : 'Last 90 days';

      const openRow = this.connection
        .prepare(
          'SELECT COALESCE(SUM(amount_cents), 0) AS opening FROM customer_ledger WHERE customer_id = ? AND occurred_at < ?',
        )
        .get(customerId, startDate) as { opening: unknown } | undefined;
      openingBalanceCents = readSafeCents(
        openRow?.opening ?? 0,
        'Opening balance',
      );

      ledgerRows = this.connection
        .prepare(
          `
          SELECT
            l.*,
            s.receipt_number AS sale_receipt_number,
            p.receipt_number AS payment_receipt_number
          FROM customer_ledger l
          LEFT JOIN sales s ON s.id = l.related_sale_id
          LEFT JOIN account_payments p ON p.id = l.related_account_payment_id
          WHERE l.customer_id = ?
            AND l.occurred_at >= ?
          ORDER BY l.occurred_at ASC, l.sequence ASC
        `,
        )
        .all(customerId, startDate) as Row[];
    } else if (options.range === 'custom') {
      startDate = options.startDate ?? null;
      endDate = options.endDate ?? null;

      const startDisplay = startDate
        ? new Date(startDate).toLocaleDateString()
        : '';
      const endDisplay = endDate
        ? new Date(new Date(endDate).getTime() - 1000).toLocaleDateString()
        : '';
      label = `Custom (${startDisplay} to ${endDisplay})`;

      if (startDate) {
        const openRow = this.connection
          .prepare(
            'SELECT COALESCE(SUM(amount_cents), 0) AS opening FROM customer_ledger WHERE customer_id = ? AND occurred_at < ?',
          )
          .get(customerId, startDate) as { opening: unknown } | undefined;
        openingBalanceCents = readSafeCents(
          openRow?.opening ?? 0,
          'Opening balance',
        );
      }

      ledgerRows = this.connection
        .prepare(
          `
          SELECT
            l.*,
            s.receipt_number AS sale_receipt_number,
            p.receipt_number AS payment_receipt_number
          FROM customer_ledger l
          LEFT JOIN sales s ON s.id = l.related_sale_id
          LEFT JOIN account_payments p ON p.id = l.related_account_payment_id
          WHERE l.customer_id = ?
            AND (? IS NULL OR l.occurred_at >= ?)
            AND (? IS NULL OR l.occurred_at < ?)
          ORDER BY l.occurred_at ASC, l.sequence ASC
        `,
        )
        .all(customerId, startDate, startDate, endDate, endDate) as Row[];
    } else {
      ledgerRows = [];
    }

    let currentRunning = BigInt(openingBalanceCents);
    let totalChargesBig = 0n;
    let totalPaymentsBig = 0n;

    const entries: StatementEntry[] = ledgerRows.map((row) => {
      const amt = BigInt(readSafeCents(row.amount_cents, 'amount_cents'));
      currentRunning += amt;
      const runningBalanceCents = readSafeCents(
        currentRunning,
        'Statement running balance',
      );

      const isCharge = amt > 0n;
      if (isCharge) {
        totalChargesBig += amt;
      } else {
        totalPaymentsBig += -amt;
      }

      return {
        id: String(row.id),
        occurredAt: String(row.occurred_at),
        entryType: String(row.entry_type) as StatementEntry['entryType'],
        notes: String(row.notes),
        relatedSaleId: row.related_sale_id ? String(row.related_sale_id) : null,
        relatedSaleReceiptNumber:
          row.sale_receipt_number !== null &&
          row.sale_receipt_number !== undefined
            ? Number(row.sale_receipt_number)
            : null,
        relatedAccountPaymentId: row.related_account_payment_id
          ? String(row.related_account_payment_id)
          : null,
        relatedPaymentReceiptNumber:
          row.payment_receipt_number !== null &&
          row.payment_receipt_number !== undefined
            ? Number(row.payment_receipt_number)
            : null,
        chargeCents: isCharge ? readSafeCents(amt, 'chargeCents') : null,
        paymentCents: !isCharge ? readSafeCents(-amt, 'paymentCents') : null,
        runningBalanceCents,
      };
    });

    const closingBalanceCents = readSafeCents(
      currentRunning,
      'Closing balance',
    );
    const totalChargesCents = readSafeCents(totalChargesBig, 'Total charges');
    const totalPaymentsCents = readSafeCents(
      totalPaymentsBig,
      'Total payments',
    );

    return {
      customer,
      settings,
      period: {
        startDate,
        endDate,
        label,
      },
      openingBalanceCents,
      entries,
      closingBalanceCents,
      totalChargesCents,
      totalPaymentsCents,
      generatedAt: now(),
    };
  }

  // --- CLOUD SYNC ---

  /** Raw cloud-sync configuration including the opaque (encrypted or plaintext)
   *  API key secret. The main process decrypts the key; it is never exposed to
   *  the renderer in plaintext. */
  getSyncConfigRecord(): SyncConfigRecord {
    const row = this.connection
      .prepare('SELECT * FROM sync_settings WHERE singleton_id = 1')
      .get() as Row | undefined;
    if (!row) {
      return {
        storeId: null,
        supabaseUrl: null,
        apiKeySecret: null,
        apiKeyEncrypted: false,
        enabled: false,
        lastSyncAt: null,
        lastError: null,
        backfillCompleted: false,
      };
    }
    return {
      storeId: row.store_id === null ? null : String(row.store_id),
      supabaseUrl:
        row.supabase_url === null || row.supabase_url === undefined
          ? null
          : String(row.supabase_url),
      apiKeySecret:
        row.api_key_secret === null || row.api_key_secret === undefined
          ? null
          : String(row.api_key_secret),
      apiKeyEncrypted: Boolean(row.api_key_encrypted),
      enabled: Boolean(row.enabled),
      lastSyncAt:
        row.last_sync_at === null || row.last_sync_at === undefined
          ? null
          : String(row.last_sync_at),
      lastError:
        row.last_error === null || row.last_error === undefined
          ? null
          : String(row.last_error),
      backfillCompleted: Boolean(row.backfill_completed),
    };
  }

  /** Returns the existing store id, generating and persisting one on first call. */
  ensureStoreId(): string {
    const existing = this.getSyncConfigRecord().storeId;
    if (existing) return existing;
    const id = randomUUID();
    this.connection
      .prepare('UPDATE sync_settings SET store_id = ? WHERE singleton_id = 1')
      .run(id);
    return id;
  }

  /** Persist cloud credentials and the enabled flag. The key is already
   *  encrypted by the main process via Electron safeStorage (or a documented
   *  plaintext fallback). */
  applySyncCredentials(input: {
    enabled: boolean;
    supabaseUrl: string;
    apiKeySecret: string;
    apiKeyEncrypted: boolean;
  }): void {
    this.connection
      .prepare(
        `UPDATE sync_settings SET
          supabase_url = ?, api_key_secret = ?, api_key_encrypted = ?, enabled = ?
        WHERE singleton_id = 1`,
      )
      .run(
        input.supabaseUrl,
        input.apiKeySecret,
        input.apiKeyEncrypted ? 1 : 0,
        input.enabled ? 1 : 0,
      );
  }

  setSyncEnabled(enabled: boolean): void {
    this.connection
      .prepare('UPDATE sync_settings SET enabled = ? WHERE singleton_id = 1')
      .run(enabled ? 1 : 0);
  }

  recordSyncResult(success: boolean, error: string | null): void {
    if (success) {
      this.connection
        .prepare(
          'UPDATE sync_settings SET last_sync_at = ?, last_error = NULL WHERE singleton_id = 1',
        )
        .run(now());
    } else {
      this.connection
        .prepare(
          'UPDATE sync_settings SET last_error = ? WHERE singleton_id = 1',
        )
        .run(error);
    }
  }

  markBackfillCompleted(): void {
    this.connection
      .prepare(
        'UPDATE sync_settings SET backfill_completed = 1 WHERE singleton_id = 1',
      )
      .run();
  }

  /** Sanitised status for the renderer: no secrets, just counts and hints. */
  getSyncStatus(): SyncStatus {
    const record = this.getSyncConfigRecord();
    return {
      enabled: record.enabled,
      configured: record.supabaseUrl !== null && record.apiKeySecret !== null,
      lastSyncAt: record.lastSyncAt,
      pendingEventCount: pendingOutboxCount(this.connection),
      lastError: record.lastError,
      backfillCompleted: record.backfillCompleted,
    };
  }

  /** Sanitised configuration view for the renderer, including a masked key hint
   *  computed from the decrypted key (provided by the main process). */
  getSyncConfigView(apiKeyHint: string | null): SyncConfigView {
    const record = this.getSyncConfigRecord();
    return {
      enabled: record.enabled,
      configured: record.supabaseUrl !== null && record.apiKeySecret !== null,
      supabaseUrl: record.supabaseUrl,
      storeId: record.storeId,
      apiKeyHint,
      apiKeyEncryptionAvailable: record.apiKeyEncrypted,
      backfillCompleted: record.backfillCompleted,
    };
  }

  pendingSyncEventCount(): number {
    return pendingOutboxCount(this.connection);
  }

  pendingSyncEvents(limit: number): OutboxEvent[] {
    return listPendingOutboxEvents(this.connection, limit);
  }

  markSyncEventsPushed(eventIds: string[]): void {
    markOutboxPushed(this.connection, eventIds);
  }

  syncOutboxMaxSequence(): number {
    return maxOutboxSequence(this.connection);
  }

  /** Every outbox event in sequence order (used by tests to seed a fake cloud). */
  exportOutboxSnapshot(): OutboxEvent[] {
    return listAllOutboxEvents(this.connection);
  }

  /** A restore is only permitted when the local database has no business rows. */
  isRestoreAllowed(): boolean {
    return isBusinessDataEmpty(this.connection);
  }

  needsBackfill(): boolean {
    return !this.getSyncConfigRecord().backfillCompleted;
  }

  /**
   * Enqueue a one-time snapshot of all existing data so historical records reach
   * the cloud. Idempotent: rows already present in the outbox (captured by
   * enqueue-on-write after this migration) are skipped, so backfill covers every
   * pre-existing row exactly once regardless of when it ran relative to writes.
   * Runs in a single transaction with the backfill-completed flag so a crash
   * cannot partially backfill.
   */
  backfillOutbox(): number {
    if (this.getSyncConfigRecord().backfillCompleted) return 0;
    let enqueued = 0;
    this.connection.transaction(() => {
      enqueued += this.backfillEntityType('settings', 'SELECT 1 AS id', () =>
        this.buildSettingsPayload(),
      );
      enqueued += this.backfillRows(
        'category',
        'SELECT id FROM categories ORDER BY created_at, name',
      );
      enqueued += this.backfillRows(
        'product',
        'SELECT id FROM products ORDER BY created_at, name',
      );
      enqueued += this.backfillRows(
        'customer',
        'SELECT id FROM customers ORDER BY created_at, name',
      );
      enqueued += this.backfillRows(
        'inventory_movement',
        'SELECT id FROM inventory_movements ORDER BY sequence',
      );
      enqueued += this.backfillRows(
        'sale',
        'SELECT id FROM sales ORDER BY receipt_number',
      );
      enqueued += this.backfillRows(
        'account_payment',
        'SELECT id FROM account_payments ORDER BY receipt_number',
      );
      enqueued += this.backfillRows(
        'payment_transaction',
        'SELECT id FROM payment_transactions ORDER BY created_at',
      );
      enqueued += this.backfillRows(
        'kiosk',
        'SELECT id FROM kiosks ORDER BY created_at, name',
      );
      enqueued += this.backfillRows(
        'audit_event',
        'SELECT id FROM audit_events ORDER BY occurred_at, rowid',
      );
      this.markBackfillCompleted();
    })();
    return enqueued;
  }

  private backfillRows(entityType: SyncEntityType, sql: string): number {
    const rows = this.connection.prepare(sql).all() as Array<{ id: unknown }>;
    let count = 0;
    for (const row of rows) {
      const entityId = String(row.id);
      if (this.outboxHasEntity(entityType, entityId)) continue;
      this.enqueueEntity(entityType, entityId);
      count += 1;
    }
    return count;
  }

  private backfillEntityType(
    entityType: 'settings',
    _sql: string,
    build: () => SettingsPayload,
  ): number {
    if (this.outboxHasEntity('settings', 'settings')) return 0;
    enqueueOutboxEvent(this.connection, {
      entityType,
      entityId: 'settings',
      operation: 'upsert',
      payload: build(),
    });
    return 1;
  }

  private outboxHasEntity(entityType: string, entityId: string): boolean {
    const row = this.connection
      .prepare(
        'SELECT 1 AS hit FROM sync_outbox WHERE entity_type = ? AND entity_id = ? LIMIT 1',
      )
      .get(entityType, entityId) as { hit: number } | undefined;
    return Boolean(row);
  }

  /**
   * Replay already-validated cloud events into this database. The caller (sync
   * layer) is responsible for Zod-validating every payload first; this method
   * applies them in one all-or-nothing transaction, seeds the local outbox so
   * the device resumes pushing from the restored sequence, and verifies
   * financial integrity. Throws and rolls back on any failure.
   */
  replayValidatedEvents(events: ValidatedRestoreEvent[]): RestoreOutcome {
    return this.connection.transaction(() =>
      restoreFromEvents(this.connection, events),
    )();
  }

  // --- PRIVATE HELPERS ---

  getProduct(id: string): Product {
    const row = this.connection
      .prepare(
        `SELECT p.*, c.name AS category_name, COALESCE(SUM(m.quantity_change), 0) AS stock_quantity FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN inventory_movements m ON m.product_id = p.id WHERE p.id = ? GROUP BY p.id`,
      )
      .get(id) as Row | undefined;
    if (!row) throw new Error('Product not found');
    return this.mapProduct(row);
  }

  private mapProduct(row: Row): Product {
    const barcodes = this.connection
      .prepare(
        'SELECT id, value, kind FROM product_barcodes WHERE product_id = ? ORDER BY position',
      )
      .all(String(row.id)) as Row[];
    return {
      id: String(row.id),
      categoryId: String(row.category_id),
      categoryName: String(row.category_name),
      name: String(row.name),
      secondaryName:
        row.secondary_name === null ? null : String(row.secondary_name),
      imageId: row.image_id === null ? null : String(row.image_id),
      purchaseCostCents: readSafeCents(
        row.purchase_cost_cents,
        'purchaseCostCents',
      ),
      sellingPriceCents: readSafeCents(
        row.selling_price_cents,
        'sellingPriceCents',
      ),
      taxable: Boolean(row.taxable),
      lowStockThreshold: readSafeCents(
        row.low_stock_threshold,
        'lowStockThreshold',
      ),
      active: Boolean(row.active),
      stockQuantity: readSafeCents(row.stock_quantity, 'stockQuantity'),
      barcodes: barcodes.map((barcode): Barcode => ({
        id: String(barcode.id),
        value: String(barcode.value),
        kind: String(barcode.kind) as Barcode['kind'],
      })),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapCustomer(row: Row, settings: StoreSettings): Customer {
    const currentBalance = this.getCustomerBalance(String(row.id));
    const creditLimitCents = readNullableSafeCents(
      row.credit_limit_cents,
      'credit_limit_cents',
    );
    const effectiveLimit =
      creditLimitCents !== null
        ? creditLimitCents
        : settings.defaultCreditLimitCents;
    const availableCredit = readSafeCents(
      BigInt(effectiveLimit) - BigInt(currentBalance),
      'availableCreditCents',
    );

    return {
      id: String(row.id),
      accountNumber: String(row.account_number),
      accountBarcode:
        row.account_barcode === null ? null : String(row.account_barcode),
      name: String(row.name),
      secondaryName:
        row.secondary_name === null ? null : String(row.secondary_name),
      phone: row.phone === null ? null : String(row.phone),
      email: row.email === null ? null : String(row.email),
      address: row.address === null ? null : String(row.address),
      notes: row.notes === null ? null : String(row.notes),
      active: Boolean(row.active),
      blocked: Boolean(row.blocked),
      creditLimitCents,
      effectiveCreditLimitCents: effectiveLimit,
      currentBalanceCents: currentBalance,
      availableCreditCents: availableCredit,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private insertBarcodes(
    productId: string,
    values: string[],
    timestamp: string,
  ): void {
    const insert = this.connection.prepare(
      'INSERT INTO product_barcodes (id, product_id, value, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    values.forEach((rawValue, position) => {
      const value = rawValue.trim();
      insert.run(
        randomUUID(),
        productId,
        value,
        value.startsWith('SSM-') ? 'CODE128_INTERNAL' : 'EXTERNAL',
        position,
        timestamp,
      );
    });
  }

  private assertCategoryExists(id: string): void {
    if (
      !this.connection.prepare('SELECT id FROM categories WHERE id = ?').get(id)
    )
      throw new Error('Category not found');
  }

  private addAudit(
    eventType: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
  ): void {
    const id = randomUUID();
    const occurredAt = now();
    this.connection
      .prepare(
        'INSERT INTO audit_events (id, event_type, entity_type, entity_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        eventType,
        entityType,
        entityId,
        JSON.stringify(payload),
        occurredAt,
      );
    enqueueOutboxEvent(this.connection, {
      entityType: 'audit_event',
      entityId: id,
      operation: 'append',
      payload: {
        id,
        eventType,
        entityType,
        entityId,
        payload,
        occurredAt,
      } satisfies AuditEventPayload,
    });
  }

  private enqueueEntity(entityType: SyncEntityType, entityId: string): void {
    const payload = this.buildPayload(entityType, entityId);
    if (payload === null) return;
    enqueueOutboxEvent(this.connection, {
      entityType,
      entityId,
      operation: syncOperationFor(entityType),
      payload,
    });
  }

  private buildPayload(
    entityType: SyncEntityType,
    entityId: string,
  ):
    | SettingsPayload
    | CategoryPayload
    | ProductPayload
    | CustomerPayload
    | InventoryMovementPayload
    | SalePayload
    | AccountPaymentPayload
    | PaymentTransactionPayload
    | KioskPayload
    | null {
    switch (entityType) {
      case 'settings':
        return this.buildSettingsPayload();
      case 'category':
        return this.buildCategoryPayload(entityId);
      case 'product':
        return this.buildProductPayload(entityId);
      case 'customer':
        return this.buildCustomerPayload(entityId);
      case 'inventory_movement':
        return this.buildInventoryMovementPayload(entityId);
      case 'sale':
        return this.buildSalePayload(entityId);
      case 'account_payment':
        return this.buildAccountPaymentPayload(entityId);
      case 'payment_transaction':
        return this.buildPaymentTransactionPayload(entityId);
      case 'kiosk':
        return this.buildKioskPayload(entityId);
      default:
        return null;
    }
  }

  private buildPaymentTransactionPayload(
    id: string,
  ): PaymentTransactionPayload | null {
    const tx = this.connection
      .prepare('SELECT * FROM payment_transactions WHERE id = ?')
      .get(id) as Row | undefined;
    if (!tx) return null;
    return {
      id: String(tx.id),
      chargeReference: String(tx.charge_reference),
      processorId: String(tx.processor_id),
      amountCents: Number(tx.amount_cents),
      status: String(tx.status) as PaymentTransactionPayload['status'],
      processorTransactionId: tx.processor_transaction_id
        ? String(tx.processor_transaction_id)
        : null,
      cardBrand: tx.card_brand ? String(tx.card_brand) : null,
      cardLast4: tx.card_last4 ? String(tx.card_last4) : null,
      saleId: tx.sale_id != null ? String(tx.sale_id) : null,
      cartSnapshotJson: tx.cart_snapshot_json
        ? String(tx.cart_snapshot_json)
        : null,
      idempotencyKey: tx.idempotency_key ? String(tx.idempotency_key) : null,
      snapshotHash: tx.snapshot_hash ? String(tx.snapshot_hash) : null,
      processorConfigHash: tx.processor_config_hash
        ? String(tx.processor_config_hash)
        : null,
      kioskId: tx.kiosk_id != null ? String(tx.kiosk_id) : null,
      originChannel:
        String(tx.origin_channel ?? 'manager') === 'kiosk'
          ? 'kiosk'
          : 'manager',
      attentionReason: tx.attention_reason ? String(tx.attention_reason) : null,
      createdAt: String(tx.created_at),
      updatedAt: String(tx.updated_at),
    };
  }

  private buildKioskPayload(id: string): KioskPayload | null {
    const row = this.connection
      .prepare('SELECT id,name,created_at,revoked_at FROM kiosks WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    };
  }

  private buildSettingsPayload(): SettingsPayload {
    return this.getSettings();
  }

  private buildCategoryPayload(id: string): CategoryPayload {
    return this.getCategory(id);
  }

  private buildProductPayload(productId: string): ProductPayload {
    const row = this.connection
      .prepare('SELECT * FROM products WHERE id = ?')
      .get(productId) as Row | undefined;
    if (!row) throw new Error('Product not found');
    const barcodes = this.connection
      .prepare(
        'SELECT id, value, kind, position FROM product_barcodes WHERE product_id = ? ORDER BY position',
      )
      .all(productId) as Row[];
    return {
      id: String(row.id),
      categoryId: String(row.category_id),
      name: String(row.name),
      secondaryName:
        row.secondary_name === null ? null : String(row.secondary_name),
      imageId: row.image_id === null ? null : String(row.image_id),
      purchaseCostCents: readSafeCents(
        row.purchase_cost_cents,
        'purchaseCostCents',
      ),
      sellingPriceCents: readSafeCents(
        row.selling_price_cents,
        'sellingPriceCents',
      ),
      taxable: Boolean(row.taxable),
      lowStockThreshold: readSafeCents(
        row.low_stock_threshold,
        'lowStockThreshold',
      ),
      active: Boolean(row.active),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      barcodes: barcodes.map((barcode) => ({
        id: String(barcode.id),
        value: String(barcode.value),
        kind: String(barcode.kind) as 'EXTERNAL' | 'CODE128_INTERNAL',
        position: Number(barcode.position),
      })),
    };
  }

  private buildCustomerPayload(customerId: string): CustomerPayload {
    const row = this.connection
      .prepare('SELECT * FROM customers WHERE id = ?')
      .get(customerId) as Row | undefined;
    if (!row) throw new Error('Customer not found');
    return {
      id: String(row.id),
      accountNumber: String(row.account_number),
      accountBarcode:
        row.account_barcode === null ? null : String(row.account_barcode),
      name: String(row.name),
      secondaryName:
        row.secondary_name === null ? null : String(row.secondary_name),
      phone: row.phone === null ? null : String(row.phone),
      email: row.email === null ? null : String(row.email),
      address: row.address === null ? null : String(row.address),
      notes: row.notes === null ? null : String(row.notes),
      active: Boolean(row.active),
      blocked: Boolean(row.blocked),
      creditLimitCents: readNullableSafeCents(
        row.credit_limit_cents,
        'credit_limit_cents',
      ),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private buildInventoryMovementPayload(
    movementId: string,
  ): InventoryMovementPayload {
    const row = this.connection
      .prepare('SELECT * FROM inventory_movements WHERE id = ?')
      .get(movementId) as Row | undefined;
    if (!row) throw new Error('Inventory movement not found');
    return mapMovementPayload(row);
  }

  private buildSalePayload(saleId: string): SalePayload {
    const sale = this.connection
      .prepare('SELECT * FROM sales WHERE id = ?')
      .get(saleId) as Row | undefined;
    if (!sale) throw new Error('Sale not found');
    const items = this.connection
      .prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY rowid')
      .all(saleId) as Row[];
    const paymentRow = this.connection
      .prepare('SELECT * FROM payments WHERE sale_id = ?')
      .get(saleId) as Row | undefined;
    const movements = this.connection
      .prepare(
        'SELECT * FROM inventory_movements WHERE related_sale_id = ? ORDER BY sequence',
      )
      .all(saleId) as Row[];
    const ledgerRow = this.connection
      .prepare('SELECT * FROM customer_ledger WHERE related_sale_id = ?')
      .get(saleId) as Row | undefined;

    let payment: SalePaymentPayload = null;
    if (paymentRow) {
      payment = {
        method: String(paymentRow.method) as 'cash' | 'external_terminal',
        amountCents: readSafeCents(paymentRow.amount_cents, 'amount_cents'),
        cashReceivedCents: readNullableSafeCents(
          paymentRow.cash_received_cents,
          'cash_received_cents',
        ),
        changeDueCents: readNullableSafeCents(
          paymentRow.change_due_cents,
          'change_due_cents',
        ),
        terminalReference:
          paymentRow.terminal_reference === null
            ? null
            : String(paymentRow.terminal_reference),
        externalApproved:
          paymentRow.external_approved === null
            ? null
            : Boolean(paymentRow.external_approved),
      };
    }

    return {
      id: String(sale.id),
      receiptNumber: Number(sale.receipt_number),
      completionKey: String(sale.completion_key),
      status: String(sale.status) as SalePayload['status'],
      subtotalCents: readSafeCents(sale.subtotal_cents, 'subtotal_cents'),
      taxCents: readSafeCents(sale.tax_cents, 'tax_cents'),
      totalCents: readSafeCents(sale.total_cents, 'total_cents'),
      createdAt: String(sale.created_at),
      completedAt:
        sale.completed_at === null ? null : String(sale.completed_at),
      customerId: sale.customer_id === null ? null : String(sale.customer_id),
      customerName:
        sale.customer_name === null ? null : String(sale.customer_name),
      customerAccountNumber:
        sale.customer_account_number === null
          ? null
          : String(sale.customer_account_number),
      customerBalanceBeforeCents: readNullableSafeCents(
        sale.customer_balance_before_cents,
        'customer_balance_before_cents',
      ),
      customerBalanceAfterCents: readNullableSafeCents(
        sale.customer_balance_after_cents,
        'customer_balance_after_cents',
      ),
      channel: (sale.channel === 'kiosk'
        ? 'kiosk'
        : 'manager') as SalePayload['channel'],
      kioskId:
        sale.kiosk_id === null || sale.kiosk_id === undefined
          ? null
          : String(sale.kiosk_id),
      tenderType: String(sale.tender_type) as SalePayload['tenderType'],
      items: items.map((item): SaleItemPayload => ({
        id: String(item.id),
        productId: String(item.product_id),
        productName: String(item.product_name),
        secondaryName:
          item.secondary_name === null ? null : String(item.secondary_name),
        barcodeUsed:
          item.barcode_used === null ? null : String(item.barcode_used),
        quantity: Number(item.quantity),
        unitSellingPriceCents: readSafeCents(
          item.unit_selling_price_cents,
          'unit_selling_price_cents',
        ),
        unitPurchaseCostCents: readSafeCents(
          item.unit_purchase_cost_cents,
          'unit_purchase_cost_cents',
        ),
        taxable: Boolean(item.taxable),
        taxCents: readSafeCents(item.tax_cents, 'tax_cents'),
        lineSubtotalCents: readSafeCents(
          item.line_subtotal_cents,
          'line_subtotal_cents',
        ),
        lineTotalCents: readSafeCents(
          item.line_total_cents,
          'line_total_cents',
        ),
      })),
      payment,
      inventoryMovements: movements.map(mapMovementPayload),
      ledgerEntry: ledgerRow ? mapLedgerPayload(ledgerRow) : null,
    };
  }

  private buildAccountPaymentPayload(paymentId: string): AccountPaymentPayload {
    const row = this.connection
      .prepare('SELECT * FROM account_payments WHERE id = ?')
      .get(paymentId) as Row | undefined;
    if (!row) throw new Error('Account payment not found');
    const ledgerRow = this.connection
      .prepare(
        'SELECT * FROM customer_ledger WHERE related_account_payment_id = ?',
      )
      .get(paymentId) as Row | undefined;
    if (!ledgerRow) {
      throw new Error('Account payment ledger entry not found');
    }
    return {
      id: String(row.id),
      operationId: String(row.operation_id),
      receiptNumber: Number(row.receipt_number),
      customerId: String(row.customer_id),
      customerName: String(row.customer_name),
      accountNumber: String(row.account_number),
      amountCents: readSafeCents(row.amount_cents, 'amount_cents'),
      method: String(row.method) as 'cash' | 'external_terminal',
      cashReceivedCents: readNullableSafeCents(
        row.cash_received_cents,
        'cash_received_cents',
      ),
      changeDueCents: readNullableSafeCents(
        row.change_due_cents,
        'change_due_cents',
      ),
      terminalReference:
        row.terminal_reference === null ? null : String(row.terminal_reference),
      externalApproved:
        row.external_approved === null ? null : Boolean(row.external_approved),
      previousBalanceCents: readSafeCents(
        row.previous_balance_cents,
        'previous_balance_cents',
      ),
      newBalanceCents: readSafeCents(
        row.new_balance_cents,
        'new_balance_cents',
      ),
      notes: row.notes === null ? null : String(row.notes),
      createdAt: String(row.created_at),
      ledgerEntry: mapLedgerPayload(ledgerRow),
    };
  }

  private getMovement(id: string): InventoryMovement {
    const row = this.connection
      .prepare(
        `SELECT m.*, (
        SELECT COALESCE(SUM(x.quantity_change), 0) FROM inventory_movements x
        WHERE x.product_id = m.product_id
          AND (x.occurred_at < m.occurred_at OR (x.occurred_at = m.occurred_at AND x.sequence <= m.sequence))
      ) AS resulting_stock FROM inventory_movements m WHERE m.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) throw new Error('Inventory movement not found');
    return mapMovement(row);
  }
}

function parseLabelTemplate(
  value: unknown,
): 'thermal_40x30' | 'thermal_57x32' | 'letter_avery_5160' {
  if (
    value === 'thermal_40x30' ||
    value === 'thermal_57x32' ||
    value === 'letter_avery_5160'
  ) {
    return value;
  }
  return 'thermal_40x30';
}

function mapCategory(row: Row): Category {
  return {
    id: String(row.id),
    name: String(row.name),
    secondaryName:
      row.secondary_name === null ? null : String(row.secondary_name),
    imageId: row.image_id === null ? null : String(row.image_id),
    active: Boolean(row.active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMovement(row: Row): InventoryMovement {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    productId: String(row.product_id),
    quantityChange: Number(row.quantity_change),
    reason: String(row.reason) as InventoryMovement['reason'],
    notes: String(row.notes),
    occurredAt: String(row.occurred_at),
    deviceId: row.device_id === null ? null : String(row.device_id),
    relatedSaleId:
      row.related_sale_id === null ? null : String(row.related_sale_id),
    resultingStock: Number(row.resulting_stock),
  };
}

function mapMovementPayload(row: Row): InventoryMovementPayload {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    productId: String(row.product_id),
    quantityChange: Number(row.quantity_change),
    reason: String(row.reason) as InventoryMovementPayload['reason'],
    occurredAt: String(row.occurred_at),
    deviceId: row.device_id === null ? null : String(row.device_id),
    relatedSaleId:
      row.related_sale_id === null ? null : String(row.related_sale_id),
    notes: String(row.notes),
    sequence: Number(row.sequence),
  };
}

function mapLedgerPayload(row: Row): LedgerEntryPayload {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    customerId: String(row.customer_id),
    amountCents: readSafeCents(row.amount_cents, 'ledger amount_cents'),
    entryType: String(row.entry_type) as LedgerEntryPayload['entryType'],
    occurredAt: String(row.occurred_at),
    relatedSaleId:
      row.related_sale_id === null ? null : String(row.related_sale_id),
    relatedAccountPaymentId:
      row.related_account_payment_id === null
        ? null
        : String(row.related_account_payment_id),
    deviceId: row.device_id === null ? null : String(row.device_id),
    notes: String(row.notes),
    sequence: Number(row.sequence),
  };
}

function mapLedgerEntry(row: Row): CustomerLedgerEntry {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    customerId: String(row.customer_id),
    amountCents: readSafeCents(row.amount_cents, 'ledger amount_cents'),
    entryType: String(row.entry_type) as CustomerLedgerEntry['entryType'],
    occurredAt: String(row.occurred_at),
    relatedSaleId: row.related_sale_id ? String(row.related_sale_id) : null,
    relatedSaleReceiptNumber:
      row.sale_receipt_number !== null && row.sale_receipt_number !== undefined
        ? Number(row.sale_receipt_number)
        : null,
    relatedAccountPaymentId: row.related_account_payment_id
      ? String(row.related_account_payment_id)
      : null,
    relatedPaymentReceiptNumber:
      row.payment_receipt_number !== null &&
      row.payment_receipt_number !== undefined
        ? Number(row.payment_receipt_number)
        : null,
    deviceId: row.device_id ? String(row.device_id) : null,
    notes: String(row.notes),
    sequence: Number(row.sequence),
    resultingBalanceCents: readSafeCents(
      row.resulting_balance_cents,
      'resulting_balance_cents',
    ),
  };
}

function mapAccountPayment(row: Row): AccountPayment {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    receiptNumber: Number(row.receipt_number),
    customerId: String(row.customer_id),
    customerName: String(row.customer_name),
    accountNumber: String(row.account_number),
    amountCents: readSafeCents(row.amount_cents, 'amount_cents'),
    method: String(row.method) as AccountPayment['method'],
    cashReceivedCents: readNullableSafeCents(
      row.cash_received_cents,
      'cash_received_cents',
    ),
    changeDueCents: readNullableSafeCents(
      row.change_due_cents,
      'change_due_cents',
    ),
    terminalReference:
      row.terminal_reference === null || row.terminal_reference === undefined
        ? null
        : String(row.terminal_reference),
    externalApproved:
      row.external_approved === null || row.external_approved === undefined
        ? null
        : Boolean(row.external_approved),
    previousBalanceCents: readSafeCents(
      row.previous_balance_cents,
      'previous_balance_cents',
    ),
    newBalanceCents: readSafeCents(row.new_balance_cents, 'new_balance_cents'),
    notes:
      row.notes === null || row.notes === undefined ? null : String(row.notes),
    createdAt: String(row.created_at),
  };
}

function friendlyDatabaseError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('product_barcodes.value'))
    return new Error('That barcode is already assigned to a product.');
  if (message.includes('inventory_movements.operation_id'))
    return new Error('This inventory operation was already recorded.');
  if (message.includes('customers.account_number'))
    return new Error('That account number is already in use.');
  if (message.includes('customers.account_barcode'))
    return new Error('That account barcode is already assigned to a customer.');
  if (message.includes('account_payments.operation_id'))
    return new Error('This payment operation was already recorded.');
  if (message.includes('customer_ledger.operation_id'))
    return new Error('This ledger operation was already recorded.');
  return error instanceof Error ? error : new Error(message);
}
