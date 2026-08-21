import type { SqliteDatabase } from './sqlite.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_inventory_schema',
    sql: `
      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        secondary_name TEXT,
        image_id TEXT REFERENCES images(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX categories_active_name_idx ON categories(active, name COLLATE NOCASE);

      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        secondary_name TEXT,
        image_id TEXT REFERENCES images(id) ON DELETE RESTRICT,
        purchase_cost_cents INTEGER NOT NULL CHECK (purchase_cost_cents >= 0),
        selling_price_cents INTEGER NOT NULL CHECK (selling_price_cents >= 0),
        taxable INTEGER NOT NULL CHECK (taxable IN (0, 1)),
        low_stock_threshold INTEGER NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX products_category_active_idx ON products(category_id, active);
      CREATE INDEX products_name_idx ON products(name COLLATE NOCASE);

      CREATE TABLE product_barcodes (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        value TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(value)) > 0),
        kind TEXT NOT NULL CHECK (kind IN ('EXTERNAL', 'CODE128_INTERNAL')),
        position INTEGER NOT NULL CHECK (position >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(value)
      );
      CREATE INDEX product_barcodes_product_idx ON product_barcodes(product_id);

      CREATE TABLE inventory_movements (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        quantity_change INTEGER NOT NULL CHECK (quantity_change <> 0),
        reason TEXT NOT NULL CHECK (reason IN ('stock_received', 'damaged', 'customer_return', 'manual_increase', 'manual_decrease', 'stock_count_correction', 'sale')),
        occurred_at TEXT NOT NULL,
        device_id TEXT,
        related_sale_id TEXT,
        notes TEXT NOT NULL CHECK (length(trim(notes)) > 0)
      );
      CREATE INDEX inventory_movements_product_time_idx ON inventory_movements(product_id, occurred_at);

      CREATE TRIGGER inventory_movements_no_update
      BEFORE UPDATE ON inventory_movements BEGIN
        SELECT RAISE(ABORT, 'Inventory movements are append-only');
      END;
      CREATE TRIGGER inventory_movements_no_delete
      BEFORE DELETE ON inventory_movements BEGIN
        SELECT RAISE(ABORT, 'Inventory movements are append-only');
      END;

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, occurred_at);
    `,
  },
];

export function runMigrations(db: SqliteDatabase): void {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
