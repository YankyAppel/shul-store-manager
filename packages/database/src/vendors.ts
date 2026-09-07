import { randomUUID } from 'node:crypto';
import {
  buyingListLineUpdateSchema,
  catalogVendorProductSchema,
  catalogVendorSchema,
  resolveReorderQuantity,
  vendorInputSchema,
  type BuyingListLine,
  type BuyingListLineUpdate,
  type CatalogVendor,
  type CatalogVendorProduct,
  type ProductVendorLink,
  type ProductVendorLinkInput,
  type ProductVendorPayload,
  type ReorderStatus,
  type Vendor,
  type VendorInput,
  type VendorProduct,
  type VendorStatus,
  type VendorSummary,
} from '@shul-store/shared';
import type { SqliteDatabase } from './sqlite.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const int = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const VENDOR_COLUMNS =
  'id, name, email, phone, website, address, notes, status, has_account, shared, default_reorder_qty, account_number, hide_list_price, created_at, updated_at';

function mapVendor(row: Row): Vendor {
  return {
    id: String(row.id),
    name: String(row.name),
    email: text(row.email),
    phone: text(row.phone),
    website: text(row.website),
    address: text(row.address),
    notes: text(row.notes),
    status: String(row.status) as VendorStatus,
    hasAccount: Boolean(row.has_account),
    shared: Boolean(row.shared),
    defaultReorderQty: int(row.default_reorder_qty),
    accountNumber: text(row.account_number),
    hideListPrice: Boolean(row.hide_list_price),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapVendorProduct(row: Row): VendorProduct {
  return {
    id: String(row.id),
    vendorId: String(row.vendor_id),
    barcode: String(row.barcode),
    sku: text(row.sku),
    name: String(row.name),
    caseSize: int(row.case_size),
    minOrderQty: int(row.min_order_qty),
    priceCents: int(row.price_cents),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Local vendor cache, product↔vendor links and the automatic buying list.
 *
 * All methods run inside the caller's transaction when one is open; none of
 * them touch the sync outbox — the owning StoreDatabase enqueues the product
 * after changing its vendor links.
 */
export class VendorStore {
  constructor(private readonly connection: SqliteDatabase) {}

  // --- VENDORS ---

  listVendors(): Vendor[] {
    const rows = this.connection
      .prepare(
        `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE status <> 'suspended' ORDER BY name COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map(mapVendor);
  }

  getVendor(id: string): Vendor {
    const row = this.connection
      .prepare(`SELECT ${VENDOR_COLUMNS} FROM vendors WHERE id = ?`)
      .get(id) as Row | undefined;
    if (!row) throw new Error('Vendor not found');
    return mapVendor(row);
  }

  findVendor(id: string): Vendor | null {
    const row = this.connection
      .prepare(`SELECT ${VENDOR_COLUMNS} FROM vendors WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? mapVendor(row) : null;
  }

  /** Vendors whose name or email looks like a duplicate of the given input. */
  findSimilarVendors(name: string, email: string | null): Vendor[] {
    const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const rows = this.connection
      .prepare(`SELECT ${VENDOR_COLUMNS} FROM vendors WHERE status <> 'suspended'`)
      .all() as Row[];
    return rows.map(mapVendor).filter((vendor) => {
      const candidate = vendor.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (normalized.length >= 3 && (candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate)))
        return true;
      return Boolean(email && vendor.email && vendor.email.toLowerCase() === email.toLowerCase());
    });
  }

  /** Create a vendor locally. `id` may be supplied so the same id is later
   *  used when publishing the vendor to the shared catalog. */
  createVendor(input: VendorInput, id: string = randomUUID()): Vendor {
    const value = vendorInputSchema.parse(input);
    const timestamp = now();
    this.connection
      .prepare(
        `INSERT INTO vendors (id, name, email, phone, website, address, notes, status, has_account, shared, default_reorder_qty, account_number, hide_list_price, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', 0, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        value.name,
        value.email ?? null,
        value.phone ?? null,
        value.website ?? null,
        value.address ?? null,
        value.notes ?? null,
        value.defaultReorderQty ?? null,
        value.accountNumber ?? null,
        value.hideListPrice ? 1 : 0,
        timestamp,
        timestamp,
      );
    return this.getVendor(id);
  }

  /** Update store-private settings and, for vendors not yet in the shared
   *  catalog, the contact details too. Shared vendors' contact details are
   *  owned by the catalog (the vendor portal) and refreshed from it. */
  updateVendor(id: string, input: VendorInput): Vendor {
    const value = vendorInputSchema.parse(input);
    const current = this.getVendor(id);
    const editable = !current.shared || !current.hasAccount;
    this.connection
      .prepare(
        `UPDATE vendors SET name = ?, email = ?, phone = ?, website = ?, address = ?, notes = ?,
           default_reorder_qty = ?, account_number = ?, hide_list_price = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        editable ? value.name : current.name,
        editable ? (value.email ?? null) : current.email,
        editable ? (value.phone ?? null) : current.phone,
        editable ? (value.website ?? null) : current.website,
        editable ? (value.address ?? null) : current.address,
        value.notes ?? null,
        value.defaultReorderQty ?? null,
        value.accountNumber ?? null,
        value.hideListPrice ? 1 : 0,
        now(),
        id,
      );
    return this.getVendor(id);
  }

  /** Merge rows from the shared catalog into the local cache, keeping the
   *  store-private settings columns untouched. */
  upsertCatalogVendors(vendors: CatalogVendor[]): number {
    const statement = this.connection.prepare(
      `INSERT INTO vendors (id, name, email, phone, website, address, notes, status, has_account, shared, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, email = excluded.email, phone = excluded.phone, website = excluded.website,
         address = excluded.address, status = excluded.status, has_account = excluded.has_account,
         shared = 1, updated_at = excluded.updated_at`,
    );
    let count = 0;
    for (const raw of vendors) {
      const vendor = catalogVendorSchema.parse(raw);
      statement.run(
        vendor.id,
        vendor.name,
        vendor.email,
        vendor.phone,
        vendor.website,
        vendor.address,
        vendor.notes,
        vendor.status,
        vendor.has_account ? 1 : 0,
        vendor.created_at,
        vendor.updated_at,
      );
      count += 1;
    }
    return count;
  }

  /** Vendors created offline that still have to be published to the catalog. */
  listUnsharedVendors(): Vendor[] {
    const rows = this.connection
      .prepare(`SELECT ${VENDOR_COLUMNS} FROM vendors WHERE shared = 0 ORDER BY created_at`)
      .all() as Row[];
    return rows.map(mapVendor);
  }

  markVendorShared(id: string): void {
    this.connection.prepare('UPDATE vendors SET shared = 1 WHERE id = ?').run(id);
  }

  /** Newest catalog timestamp we hold, for incremental refreshes. */
  latestSharedVendorUpdate(): string | null {
    const row = this.connection
      .prepare('SELECT MAX(updated_at) AS latest FROM vendors WHERE shared = 1')
      .get() as Row | undefined;
    return text(row?.latest);
  }

  // --- VENDOR PRODUCTS (catalog cache) ---

  upsertCatalogVendorProducts(products: CatalogVendorProduct[]): number {
    const statement = this.connection.prepare(
      `INSERT INTO vendor_products (id, vendor_id, barcode, sku, name, case_size, min_order_qty, price_cents, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         vendor_id = excluded.vendor_id, barcode = excluded.barcode, sku = excluded.sku, name = excluded.name,
         case_size = excluded.case_size, min_order_qty = excluded.min_order_qty,
         price_cents = excluded.price_cents, updated_at = excluded.updated_at`,
    );
    let count = 0;
    for (const raw of products) {
      const product = catalogVendorProductSchema.parse(raw);
      if (!this.findVendor(product.vendor_id)) continue;
      statement.run(
        product.id,
        product.vendor_id,
        product.barcode,
        product.sku,
        product.name,
        product.case_size,
        product.min_order_qty,
        product.price_cents,
        product.updated_at,
      );
      count += 1;
    }
    return count;
  }

  /** Every vendor offer for any of the given barcodes. */
  listVendorProductsForBarcodes(barcodes: string[]): VendorProduct[] {
    if (barcodes.length === 0) return [];
    const placeholders = barcodes.map(() => '?').join(', ');
    const rows = this.connection
      .prepare(
        `SELECT vp.* FROM vendor_products vp
         JOIN vendors v ON v.id = vp.vendor_id
         WHERE vp.barcode IN (${placeholders}) AND v.status <> 'suspended'
         ORDER BY v.name COLLATE NOCASE`,
      )
      .all(...barcodes) as Row[];
    return rows.map(mapVendorProduct);
  }

  // --- PRODUCT ↔ VENDOR LINKS ---

  listProductVendors(productId: string): ProductVendorLink[] {
    const rows = this.connection
      .prepare(
        `SELECT pv.vendor_id, v.name AS vendor_name, pv.preferred, pv.cost_cents, pv.reorder_qty, pv.vendor_sku
         FROM product_vendors pv JOIN vendors v ON v.id = pv.vendor_id
         WHERE pv.product_id = ?
         ORDER BY pv.preferred DESC, v.name COLLATE NOCASE`,
      )
      .all(productId) as Row[];
    return rows.map((row) => ({
      vendorId: String(row.vendor_id),
      vendorName: String(row.vendor_name),
      preferred: Boolean(row.preferred),
      costCents: int(row.cost_cents),
      reorderQty: int(row.reorder_qty),
      vendorSku: text(row.vendor_sku),
    }));
  }

  /** Replace the product's vendor links wholesale. Returns true when the set
   *  of links actually changed. */
  replaceProductVendors(
    productId: string,
    links: ProductVendorLinkInput[],
  ): boolean {
    const before = JSON.stringify(this.listProductVendors(productId));
    this.connection
      .prepare('DELETE FROM product_vendors WHERE product_id = ?')
      .run(productId);
    const insert = this.connection.prepare(
      `INSERT INTO product_vendors (product_id, vendor_id, preferred, cost_cents, reorder_qty, vendor_sku)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const link of links) {
      if (!this.findVendor(link.vendorId)) throw new Error('Vendor not found');
      insert.run(
        productId,
        link.vendorId,
        link.preferred ? 1 : 0,
        link.costCents ?? null,
        link.reorderQty ?? null,
        link.vendorSku ?? null,
      );
    }
    const preferred = links.find((link) => link.preferred);
    // Open suggestions always follow the preferred vendor.
    if (preferred) {
      this.connection
        .prepare(
          `UPDATE reorder_list SET vendor_id = ?, updated_at = ? WHERE product_id = ? AND status = 'open' AND vendor_id <> ?`,
        )
        .run(preferred.vendorId, now(), productId, preferred.vendorId);
    } else {
      this.connection
        .prepare(`DELETE FROM reorder_list WHERE product_id = ? AND status IN ('open', 'dismissed')`)
        .run(productId);
    }
    return before !== JSON.stringify(this.listProductVendors(productId));
  }

  productVendorPayload(productId: string): ProductVendorPayload[] {
    const rows = this.connection
      .prepare(
        `SELECT pv.vendor_id, v.name AS vendor_name, v.email AS vendor_email, pv.preferred, pv.cost_cents, pv.reorder_qty, pv.vendor_sku
         FROM product_vendors pv JOIN vendors v ON v.id = pv.vendor_id
         WHERE pv.product_id = ? ORDER BY pv.preferred DESC, v.name COLLATE NOCASE`,
      )
      .all(productId) as Row[];
    return rows.map((row) => ({
      vendorId: String(row.vendor_id),
      vendorName: String(row.vendor_name),
      vendorEmail: text(row.vendor_email),
      preferred: Boolean(row.preferred),
      costCents: int(row.cost_cents),
      reorderQty: int(row.reorder_qty),
      vendorSku: text(row.vendor_sku),
    }));
  }

  // --- BUYING LIST ---

  /**
   * Bring the suggestion rows in line with current stock levels:
   *  - products at/below their threshold with a preferred vendor get an open
   *    row unless one is already open, dismissed or ordered;
   *  - products back above their threshold lose their open/dismissed row.
   * Ordered rows are left alone until the purchase order is received.
   */
  refreshBuyingList(): void {
    const timestamp = now();
    const candidates = this.connection
      .prepare(
        `SELECT p.id AS product_id, pv.vendor_id,
                COALESCE((SELECT SUM(m.quantity_change) FROM inventory_movements m WHERE m.product_id = p.id), 0) AS stock,
                p.low_stock_threshold AS threshold,
                (SELECT r.status FROM reorder_list r WHERE r.product_id = p.id AND r.status IN ('open','dismissed') LIMIT 1) AS suggestion_status,
                EXISTS (SELECT 1 FROM reorder_list r WHERE r.product_id = p.id AND r.status = 'ordered') AS ordered
         FROM products p
         JOIN product_vendors pv ON pv.product_id = p.id AND pv.preferred = 1
         WHERE p.active = 1 AND p.low_stock_threshold > 0`,
      )
      .all() as Row[];
    const insert = this.connection.prepare(
      `INSERT INTO reorder_list (id, product_id, vendor_id, quantity_override, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'open', ?, ?)`,
    );
    const clear = this.connection.prepare(
      `DELETE FROM reorder_list WHERE product_id = ? AND status IN ('open', 'dismissed')`,
    );
    const low = new Set<string>();
    for (const row of candidates) {
      const productId = String(row.product_id);
      const isLow = Number(row.stock) <= Number(row.threshold);
      if (isLow) {
        low.add(productId);
        if (row.suggestion_status === null && !Number(row.ordered))
          insert.run(randomUUID(), productId, String(row.vendor_id), timestamp, timestamp);
      } else if (row.suggestion_status !== null) {
        clear.run(productId);
      }
    }
    // Rows for products that lost their preferred vendor, went inactive or
    // had the threshold turned off.
    const stale = this.connection
      .prepare(
        `SELECT r.product_id FROM reorder_list r WHERE r.status IN ('open', 'dismissed')`,
      )
      .all() as Row[];
    for (const row of stale) {
      const productId = String(row.product_id);
      if (!low.has(productId)) clear.run(productId);
    }
  }

  listBuyingList(vendorId?: string, statuses: ReorderStatus[] = ['open']): BuyingListLine[] {
    this.refreshBuyingList();
    const statusPlaceholders = statuses.map(() => '?').join(', ');
    const rows = this.connection
      .prepare(
        `SELECT r.id, r.product_id, r.vendor_id, r.quantity_override, r.status, r.created_at, r.updated_at,
                p.name AS product_name, p.low_stock_threshold, p.purchase_cost_cents,
                COALESCE((SELECT SUM(m.quantity_change) FROM inventory_movements m WHERE m.product_id = p.id), 0) AS stock,
                pv.cost_cents AS negotiated_cents, pv.reorder_qty AS override_qty, pv.vendor_sku,
                v.default_reorder_qty, v.hide_list_price,
                (SELECT b.value FROM product_barcodes b WHERE b.product_id = p.id ORDER BY b.kind = 'EXTERNAL' DESC, b.position LIMIT 1) AS barcode,
                vp.case_size, vp.min_order_qty, vp.price_cents AS list_price_cents, vp.sku AS catalog_sku
         FROM reorder_list r
         JOIN products p ON p.id = r.product_id
         JOIN vendors v ON v.id = r.vendor_id
         LEFT JOIN product_vendors pv ON pv.product_id = r.product_id AND pv.vendor_id = r.vendor_id
         LEFT JOIN vendor_products vp ON vp.vendor_id = r.vendor_id
           AND vp.barcode IN (SELECT b.value FROM product_barcodes b WHERE b.product_id = p.id)
         WHERE r.status IN (${statusPlaceholders}) ${vendorId ? 'AND r.vendor_id = ?' : ''}
         GROUP BY r.id
         ORDER BY p.name COLLATE NOCASE`,
      )
      .all(...statuses, ...(vendorId ? [vendorId] : [])) as Row[];
    return rows.map((row): BuyingListLine => {
      const override = int(row.quantity_override);
      const quantity =
        override ??
        resolveReorderQuantity({
          overrideQty: int(row.override_qty),
          caseSize: int(row.case_size),
          minOrderQty: int(row.min_order_qty),
          vendorDefaultQty: int(row.default_reorder_qty),
        });
      const listPrice = int(row.list_price_cents);
      const negotiated = int(row.negotiated_cents);
      const hideList = Boolean(row.hide_list_price);
      const productCost = Number(row.purchase_cost_cents);
      const unitCost =
        negotiated ?? (hideList ? null : listPrice) ?? (productCost > 0 ? productCost : null);
      return {
        id: String(row.id),
        productId: String(row.product_id),
        productName: String(row.product_name),
        barcode: text(row.barcode),
        vendorId: String(row.vendor_id),
        vendorSku: text(row.vendor_sku) ?? text(row.catalog_sku),
        stockQuantity: Number(row.stock),
        lowStockThreshold: Number(row.low_stock_threshold),
        quantity,
        quantityOverride: override,
        unitCostCents: unitCost,
        listPriceCents: hideList ? null : listPrice,
        status: String(row.status) as ReorderStatus,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  updateBuyingListLine(id: string, input: BuyingListLineUpdate): BuyingListLine {
    const value = buyingListLineUpdateSchema.parse(input);
    const row = this.connection
      .prepare(`SELECT product_id, status FROM reorder_list WHERE id = ?`)
      .get(id) as Row | undefined;
    if (!row) throw new Error('Buying list line not found');
    if (row.status === 'ordered') throw new Error('Line already ordered');
    if (value.vendorId) {
      const linked = this.connection
        .prepare('SELECT 1 FROM product_vendors WHERE product_id = ? AND vendor_id = ?')
        .get(String(row.product_id), value.vendorId);
      if (!linked) throw new Error('Vendor is not linked to this product');
    }
    this.connection
      .prepare(
        `UPDATE reorder_list SET
           quantity_override = CASE WHEN ? THEN ? ELSE quantity_override END,
           vendor_id = COALESCE(?, vendor_id),
           status = COALESCE(?, status),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        value.quantityOverride === undefined ? 0 : 1,
        value.quantityOverride ?? null,
        value.vendorId ?? null,
        value.status ?? null,
        now(),
        id,
      );
    const [line] = this.listBuyingList(undefined, ['open', 'dismissed', 'ordered']).filter(
      (candidate) => candidate.id === id,
    );
    if (!line) throw new Error('Buying list line not found');
    return line;
  }

  /** Manually add a product to a vendor's buying list (must be linked). */
  addBuyingListLine(productId: string, vendorId: string, quantity: number | null): BuyingListLine {
    const linked = this.connection
      .prepare('SELECT 1 FROM product_vendors WHERE product_id = ? AND vendor_id = ?')
      .get(productId, vendorId);
    if (!linked) throw new Error('Vendor is not linked to this product');
    const existing = this.connection
      .prepare(`SELECT id FROM reorder_list WHERE product_id = ? AND status IN ('open', 'dismissed')`)
      .get(productId) as Row | undefined;
    const timestamp = now();
    let id: string;
    if (existing) {
      id = String(existing.id);
      this.connection
        .prepare(
          `UPDATE reorder_list SET vendor_id = ?, quantity_override = COALESCE(?, quantity_override), status = 'open', updated_at = ? WHERE id = ?`,
        )
        .run(vendorId, quantity, timestamp, id);
    } else {
      id = randomUUID();
      this.connection
        .prepare(
          `INSERT INTO reorder_list (id, product_id, vendor_id, quantity_override, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(id, productId, vendorId, quantity, timestamp, timestamp);
    }
    const line = this.listBuyingList(undefined, ['open']).find((candidate) => candidate.id === id);
    if (!line) throw new Error('Buying list line not found');
    return line;
  }

  listVendorSummaries(): VendorSummary[] {
    const lines = this.listBuyingList(undefined, ['open']);
    const linkCounts = this.connection
      .prepare('SELECT vendor_id, COUNT(*) AS n FROM product_vendors GROUP BY vendor_id')
      .all() as Row[];
    const links = new Map(linkCounts.map((row) => [String(row.vendor_id), Number(row.n)]));
    return this.listVendors().map((vendor) => {
      const mine = lines.filter((line) => line.vendorId === vendor.id);
      return {
        ...vendor,
        openLineCount: mine.length,
        openQuantity: mine.reduce((sum, line) => sum + line.quantity, 0),
        estimatedTotalCents: mine.reduce(
          (sum, line) => sum + (line.unitCostCents ?? 0) * line.quantity,
          0,
        ),
        unpricedLineCount: mine.filter((line) => line.unitCostCents === null).length,
        linkedProductCount: links.get(vendor.id) ?? 0,
      };
    });
  }
}

/** Replay a product's vendor links from a sync payload, creating cache rows
 *  for vendors this device has not seen. */
export function applyProductVendors(
  connection: SqliteDatabase,
  productId: string,
  vendors: ProductVendorPayload[],
): void {
  const timestamp = now();
  const ensureVendor = connection.prepare(
    `INSERT OR IGNORE INTO vendors (id, name, email, status, has_account, shared, created_at, updated_at)
     VALUES (?, ?, ?, 'unverified', 0, 0, ?, ?)`,
  );
  connection.prepare('DELETE FROM product_vendors WHERE product_id = ?').run(productId);
  const insert = connection.prepare(
    `INSERT INTO product_vendors (product_id, vendor_id, preferred, cost_cents, reorder_qty, vendor_sku)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let preferredSeen = false;
  for (const link of vendors) {
    ensureVendor.run(link.vendorId, link.vendorName, link.vendorEmail, timestamp, timestamp);
    const preferred = link.preferred && !preferredSeen;
    if (preferred) preferredSeen = true;
    insert.run(
      productId,
      link.vendorId,
      preferred ? 1 : 0,
      link.costCents,
      link.reorderQty,
      link.vendorSku,
    );
  }
}
