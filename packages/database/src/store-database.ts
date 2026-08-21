import { randomUUID } from 'node:crypto';
import { SqliteDatabase } from './sqlite.js';
import {
  calculateCart,
  calculateCashChange,
  categoryInputSchema,
  completeSaleInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
  storeSettingsSchema,
  type Barcode,
  type Category,
  type CategoryInput,
  type InventoryMovement,
  type InventoryMovementInput,
  type Product,
  type ProductInput,
  type CompleteSaleInput,
  type Sale,
  type StoreSettings,
} from '@shul-store/shared';
import { runMigrations } from './migrations.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

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
    // The value can be rendered with any Code 128 encoder; entropy avoids a central online allocator.
    return `SSM-${Date.now().toString(36).toUpperCase()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  }

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
    return (
      this.connection
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
        .all(productId) as Row[]
    ).map(mapMovement);
  }

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

  getSettings(): StoreSettings {
    const row = this.connection
      .prepare('SELECT * FROM store_settings WHERE singleton_id = 1')
      .get() as Row;
    return {
      storeName: String(row.store_name),
      contactLines: JSON.parse(String(row.contact_lines_json)) as string[],
      currency: 'USD',
      taxRateBps: Number(row.tax_rate_bps),
      pricesIncludeTax: Boolean(row.prices_include_tax),
      receiptFooter: String(row.receipt_footer),
    };
  }

  updateSettings(input: StoreSettings): StoreSettings {
    const value = storeSettingsSchema.parse(input);
    this.connection
      .prepare(
        `UPDATE store_settings SET store_name=?, contact_lines_json=?, currency=?, tax_rate_bps=?, prices_include_tax=?, receipt_footer=?, updated_at=? WHERE singleton_id=1`,
      )
      .run(
        value.storeName,
        JSON.stringify(value.contactLines),
        value.currency,
        value.taxRateBps,
        value.pricesIncludeTax ? 1 : 0,
        value.receiptFooter,
        now(),
      );
    return this.getSettings();
  }

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
    const existing = this.connection
      .prepare('SELECT id FROM sales WHERE completion_key = ?')
      .get(value.completionKey) as { id: string } | undefined;
    if (existing) return this.getSale(existing.id);
    const settings = this.getSettings();
    const saleId = randomUUID();
    try {
      this.connection.transaction(() => {
        const again = this.connection
          .prepare('SELECT id FROM sales WHERE completion_key = ?')
          .get(value.completionKey) as { id: string } | undefined;
        if (again) return;
        const merged = new Map<
          string,
          { quantity: number; barcodeUsed: string | null }
        >();
        for (const line of value.lines) {
          const current = merged.get(line.productId);
          merged.set(line.productId, {
            quantity: (current?.quantity ?? 0) + line.quantity,
            barcodeUsed: current?.barcodeUsed ?? line.barcodeUsed,
          });
        }
        const snapshots = [...merged].map(([productId, line]) => ({
          product: this.getProduct(productId),
          ...line,
        }));
        for (const line of snapshots) {
          if (!line.product.active)
            throw new Error(
              `${line.product.name} is inactive and cannot be sold.`,
            );
          if (line.quantity > line.product.stockQuantity)
            throw new Error(
              `Insufficient stock for ${line.product.name}. Available: ${line.product.stockQuantity}.`,
            );
          if (
            line.barcodeUsed &&
            !line.product.barcodes.some(
              (barcode) =>
                barcode.value.toLowerCase() === line.barcodeUsed?.toLowerCase(),
            )
          )
            throw new Error('Barcode does not belong to the selected product.');
        }
        const totals = calculateCart(
          snapshots.map((line) => ({
            product: line.product,
            quantity: line.quantity,
          })),
          settings,
        );
        if (
          value.payment.method === 'cash' &&
          value.payment.cashReceivedCents < totals.totalCents
        )
          throw new Error('Cash received is less than the amount due.');
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
            `INSERT INTO sales (id,receipt_number,completion_key,status,subtotal_cents,tax_cents,total_cents,created_at) VALUES (?,?,?,'open',?,?,?,?)`,
          )
          .run(
            saleId,
            receipt,
            value.completionKey,
            totals.subtotalCents,
            totals.taxCents,
            totals.totalCents,
            timestamp,
          );
        this.connection
          .prepare("UPDATE sales SET status='awaiting_payment' WHERE id=?")
          .run(saleId);
        const insertItem = this.connection.prepare(
          `INSERT INTO sale_items (id,sale_id,product_id,product_name,secondary_name,barcode_used,quantity,unit_selling_price_cents,unit_purchase_cost_cents,taxable,tax_cents,line_subtotal_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          this.connection
            .prepare(
              `INSERT INTO inventory_movements (id,operation_id,product_id,quantity_change,reason,occurred_at,device_id,related_sale_id,notes,sequence) VALUES (?,?,?,?, 'sale', ?,NULL,?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM inventory_movements))`,
            )
            .run(
              randomUUID(),
              randomUUID(),
              line.product.id,
              -line.quantity,
              timestamp,
              saleId,
              `Sale #${receipt}`,
            );
        });
        if (value.payment.method === 'cash') {
          this.connection
            .prepare(
              `INSERT INTO payments (id,sale_id,method,amount_cents,cash_received_cents,change_due_cents,created_at) VALUES (?,?,'cash',?,?,?,?)`,
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
        } else {
          this.connection
            .prepare(
              `INSERT INTO payments (id,sale_id,method,amount_cents,terminal_reference,external_approved,created_at) VALUES (?,?,'external_terminal',?,?,1,?)`,
            )
            .run(
              randomUUID(),
              saleId,
              totals.totalCents,
              value.payment.terminalReference,
              timestamp,
            );
        }
        this.connection
          .prepare("UPDATE sales SET status='paid' WHERE id=?")
          .run(saleId);
        this.connection
          .prepare(
            "UPDATE sales SET status='completed', completed_at=? WHERE id=?",
          )
          .run(timestamp, saleId);
        this.addAudit('sale.completed', 'sale', saleId, {
          receiptNumber: receipt,
          totalCents: totals.totalCents,
          paymentMethod: value.payment.method,
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
    if (!payment) throw new Error('Sale payment not found');
    return {
      id: String(sale.id),
      receiptNumber: Number(sale.receipt_number),
      status: String(sale.status) as Sale['status'],
      subtotalCents: Number(sale.subtotal_cents),
      taxCents: Number(sale.tax_cents),
      totalCents: Number(sale.total_cents),
      createdAt: String(sale.created_at),
      completedAt: sale.completed_at ? String(sale.completed_at) : null,
      items: items.map((row) => ({
        id: String(row.id),
        productId: String(row.product_id),
        productName: String(row.product_name),
        secondaryName: row.secondary_name ? String(row.secondary_name) : null,
        barcodeUsed: row.barcode_used ? String(row.barcode_used) : null,
        quantity: Number(row.quantity),
        unitSellingPriceCents: Number(row.unit_selling_price_cents),
        unitPurchaseCostCents: Number(row.unit_purchase_cost_cents),
        taxable: Boolean(row.taxable),
        taxCents: Number(row.tax_cents),
        lineSubtotalCents: Number(row.line_subtotal_cents),
        lineTotalCents: Number(row.line_total_cents),
      })),
      payment: {
        method: String(payment.method) as Sale['payment']['method'],
        amountCents: Number(payment.amount_cents),
        cashReceivedCents:
          payment.cash_received_cents === null
            ? null
            : Number(payment.cash_received_cents),
        changeDueCents:
          payment.change_due_cents === null
            ? null
            : Number(payment.change_due_cents),
        terminalReference:
          payment.terminal_reference === null
            ? null
            : String(payment.terminal_reference),
        externalApproved:
          payment.external_approved === null
            ? null
            : Boolean(payment.external_approved),
      },
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
      purchaseCostCents: Number(row.purchase_cost_cents),
      sellingPriceCents: Number(row.selling_price_cents),
      taxable: Boolean(row.taxable),
      lowStockThreshold: Number(row.low_stock_threshold),
      active: Boolean(row.active),
      stockQuantity: Number(row.stock_quantity),
      barcodes: barcodes.map((barcode): Barcode => ({
        id: String(barcode.id),
        value: String(barcode.value),
        kind: String(barcode.kind) as Barcode['kind'],
      })),
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

function friendlyDatabaseError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('product_barcodes.value'))
    return new Error('That barcode is already assigned to a product.');
  if (message.includes('inventory_movements.operation_id'))
    return new Error('This inventory operation was already recorded.');
  return error instanceof Error ? error : new Error(message);
}
