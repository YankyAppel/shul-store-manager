import { randomUUID } from 'node:crypto';
import { SqliteDatabase } from './sqlite.js';
import {
  calculateCart,
  calculateCashChange,
  categoryInputSchema,
  completeSaleInputSchema,
  customerInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
  recordAccountPaymentInputSchema,
  statementOptionsSchema,
  storeSettingsSchema,
  type AccountPayment,
  type Barcode,
  type Category,
  type CategoryInput,
  type CompleteSaleInput,
  type Customer,
  type CustomerInput,
  type CustomerLedgerEntry,
  type CustomerStatementData,
  type InventoryMovement,
  type InventoryMovementInput,
  type Product,
  type ProductInput,
  type RecordAccountPaymentInput,
  type Sale,
  type StatementEntry,
  type StatementOptions,
  type StoreSettings,
} from '@shul-store/shared';
import { runMigrations } from './migrations.js';

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

export class StoreDatabase {
  readonly connection: SqliteDatabase;

  constructor(filename: string) {
    this.connection = new SqliteDatabase(filename);
    this.connection.pragma('busy_timeout = 5000');
    runMigrations(this.connection);
  }

  close(): void {
    this.connection.close();
  }

  schemaVersion(): number {
    return this.connection.pragma('user_version', { simple: true }) as number;
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
    };
  }

  updateSettings(input: StoreSettings): StoreSettings {
    const value = storeSettingsSchema.parse(input);
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
        now(),
      );
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
    return this.getCategory(id);
  }

  updateCategory(id: string, input: CategoryInput): Category {
    const value = categoryInputSchema.parse(input);
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
    return this.getCategory(id);
  }

  setCategoryActive(id: string, active: boolean): void {
    const result = this.connection
      .prepare('UPDATE categories SET active = ?, updated_at = ? WHERE id = ?')
      .run(active ? 1 : 0, now(), id);
    if (result.changes === 0) throw new Error('Category not found');
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
        this.connection
          .prepare('DELETE FROM product_barcodes WHERE product_id = ?')
          .run(id);
        this.insertBarcodes(id, value.barcodes, now());
        this.addAudit('product.updated', 'product', id, { name: value.name });
      })();
    } catch (error) {
      throw friendlyDatabaseError(error);
    }
    return this.getProduct(id);
  }

  setProductActive(id: string, active: boolean): void {
    this.connection.transaction(() => {
      const result = this.connection
        .prepare('UPDATE products SET active = ?, updated_at = ? WHERE id = ?')
        .run(active ? 1 : 0, now(), id);
      if (result.changes === 0) throw new Error('Product not found');
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

  completeSale(input: CompleteSaleInput): Sale {
    const value = completeSaleInputSchema.parse(input);
    const settings = this.getSettings();

    // Check existing completion key idempotency before transaction
    const existingPre = this.connection
      .prepare('SELECT id FROM sales WHERE completion_key = ?')
      .get(value.completionKey) as { id: string } | undefined;
    if (existingPre) {
      this.validateExistingSaleMatch(existingPre.id, value);
      return this.getSale(existingPre.id);
    }

    const saleId = randomUUID();

    try {
      this.connection.transaction(() => {
        const again = this.connection
          .prepare('SELECT id FROM sales WHERE completion_key = ?')
          .get(value.completionKey) as { id: string } | undefined;
        if (again) {
          this.validateExistingSaleMatch(again.id, value);
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
          if (qty > product.stockQuantity) {
            throw new Error(
              `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}.`,
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

        const totals = calculateCart(
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
              customer_balance_after_cents, tender_type
            ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            value.payment.method,
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

        snapshots.forEach((line, index) => {
          const calculated = totals.lines[index]!;
          insertItem.run(
            randomUUID(),
            saleId,
            line.product.id,
            line.product.name,
            line.product.secondaryName,
            line.barcodeUsed,
            line.quantity,
            line.product.sellingPriceCents,
            line.product.purchaseCostCents,
            line.product.taxable ? 1 : 0,
            calculated.taxCents,
            calculated.subtotalCents,
            calculated.totalCents,
          );
        });

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
        }

        this.connection
          .prepare(
            "UPDATE sales SET status='completed', completed_at=? WHERE id=?",
          )
          .run(timestamp, saleId);

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
        payment.cash_received_cents,
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
        (payment.terminal_reference
          ? String(payment.terminal_reference).trim()
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
    } else {
      if (!payment) throw new Error('Sale payment not found');
      salePayment = {
        method: String(payment.method) as 'cash' | 'external_terminal',
        amountCents: readSafeCents(
          payment.amount_cents,
          'payment amount_cents',
        ),
        cashReceivedCents: readNullableSafeCents(
          payment.cash_received_cents,
          'cash_received_cents',
        ),
        changeDueCents: readNullableSafeCents(
          payment.change_due_cents,
          'change_due_cents',
        ),
        terminalReference:
          payment.terminal_reference === null
            ? null
            : String(payment.terminal_reference),
        externalApproved:
          payment.external_approved === null
            ? null
            : Boolean(payment.external_approved),
      };
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

  // --- PRIVATE HELPERS ---

  private getProduct(id: string): Product {
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
    payload: object,
  ): void {
    this.connection
      .prepare(
        'INSERT INTO audit_events (id, event_type, entity_type, entity_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        eventType,
        entityType,
        entityId,
        JSON.stringify(payload),
        now(),
      );
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
