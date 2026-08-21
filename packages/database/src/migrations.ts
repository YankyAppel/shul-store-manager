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
  {
    version: 2,
    name: 'deterministic_inventory_sequence',
    sql: `
      ALTER TABLE inventory_movements ADD COLUMN sequence INTEGER;
      UPDATE inventory_movements SET sequence = rowid;
      CREATE UNIQUE INDEX inventory_movements_sequence_idx ON inventory_movements(sequence);
    `,
  },
  {
    version: 3,
    name: 'checkout_foundation',
    sql: `
      CREATE TABLE store_settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        store_name TEXT NOT NULL, contact_lines_json TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'USD'),
        tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
        prices_include_tax INTEGER NOT NULL CHECK (prices_include_tax IN (0,1)),
        receipt_footer TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO store_settings VALUES (1, 'Shul Store', '[]', 'USD', 0, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

      CREATE TABLE sales (
        id TEXT PRIMARY KEY, receipt_number INTEGER NOT NULL UNIQUE,
        completion_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('open','awaiting_payment','paid','completed','voided','refunded')),
        subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
        tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
        total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX sales_completed_idx ON sales(completed_at DESC);
      CREATE TRIGGER sales_status_transition BEFORE UPDATE OF status ON sales
      WHEN NOT ((OLD.status='open' AND NEW.status='awaiting_payment') OR
                (OLD.status='awaiting_payment' AND NEW.status='paid') OR
                (OLD.status='paid' AND NEW.status='completed') OR
                (OLD.status IN ('open','awaiting_payment') AND NEW.status='voided') OR
                (OLD.status='completed' AND NEW.status='refunded'))
      BEGIN SELECT RAISE(ABORT, 'Invalid sale status transition'); END;

      CREATE TABLE sale_items (
        id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        product_name TEXT NOT NULL, secondary_name TEXT, barcode_used TEXT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_selling_price_cents INTEGER NOT NULL CHECK (unit_selling_price_cents >= 0),
        unit_purchase_cost_cents INTEGER NOT NULL CHECK (unit_purchase_cost_cents >= 0),
        taxable INTEGER NOT NULL CHECK (taxable IN (0,1)), tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
        line_subtotal_cents INTEGER NOT NULL CHECK (line_subtotal_cents >= 0),
        line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
      );
      CREATE INDEX sale_items_sale_idx ON sale_items(sale_id);
      CREATE TRIGGER sale_items_no_update BEFORE UPDATE ON sale_items BEGIN SELECT RAISE(ABORT, 'Sale items are immutable'); END;
      CREATE TRIGGER sale_items_no_delete BEFORE DELETE ON sale_items BEGIN SELECT RAISE(ABORT, 'Sale items are immutable'); END;

      CREATE TABLE payments (
        id TEXT PRIMARY KEY, sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
        method TEXT NOT NULL CHECK (method IN ('cash','external_terminal')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        cash_received_cents INTEGER, change_due_cents INTEGER,
        terminal_reference TEXT, external_approved INTEGER CHECK (external_approved IN (0,1)), created_at TEXT NOT NULL,
        CHECK ((method='cash' AND cash_received_cents >= amount_cents AND change_due_cents = cash_received_cents - amount_cents AND terminal_reference IS NULL AND external_approved IS NULL)
          OR (method='external_terminal' AND cash_received_cents IS NULL AND change_due_cents IS NULL AND external_approved=1))
      );
      CREATE TABLE print_attempts (
        id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        attempted_at TEXT NOT NULL, success INTEGER NOT NULL CHECK(success IN(0,1)), error_message TEXT
      );
      CREATE INDEX print_attempts_sale_idx ON print_attempts(sale_id, attempted_at);
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
