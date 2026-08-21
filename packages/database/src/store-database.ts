import { randomUUID } from 'node:crypto';
import { SqliteDatabase } from './sqlite.js';
import {
  categoryInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
  type Barcode,
  type Category,
  type CategoryInput,
  type InventoryMovement,
  type InventoryMovementInput,
  type Product,
  type ProductInput,
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
            (id, operation_id, product_id, quantity_change, reason, occurred_at, device_id, related_sale_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          'SELECT * FROM inventory_movements WHERE product_id = ? ORDER BY occurred_at DESC, id DESC',
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
      .prepare('SELECT * FROM inventory_movements WHERE id = ?')
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
    productId: String(row.product_id),
    quantityChange: Number(row.quantity_change),
    reason: String(row.reason) as InventoryMovement['reason'],
    notes: String(row.notes),
    occurredAt: String(row.occurred_at),
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
