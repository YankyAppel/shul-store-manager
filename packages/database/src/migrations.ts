import type { SqliteDatabase } from './sqlite.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  before?: (db: SqliteDatabase) => void;
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
                (OLD.status='awaiting_payment' AND NEW.status='completed') OR
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
  {
    version: 4,
    name: 'customer_accounts_and_receivables',
    sql: `
      ALTER TABLE store_settings ADD COLUMN customer_accounts_enabled INTEGER NOT NULL DEFAULT 1 CHECK (customer_accounts_enabled IN (0, 1));
      ALTER TABLE store_settings ADD COLUMN default_credit_limit_cents INTEGER NOT NULL DEFAULT 50000 CHECK (default_credit_limit_cents >= 0);
      ALTER TABLE store_settings ADD COLUMN allow_customer_credit INTEGER NOT NULL DEFAULT 0 CHECK (allow_customer_credit IN (0, 1));
      ALTER TABLE store_settings ADD COLUMN statement_footer TEXT NOT NULL DEFAULT '';
      ALTER TABLE store_settings ADD COLUMN overdue_days INTEGER NOT NULL DEFAULT 30 CHECK (overdue_days >= 0);

      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        account_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(account_number)) > 0),
        account_barcode TEXT COLLATE NOCASE UNIQUE CHECK (account_barcode IS NULL OR length(trim(account_barcode)) > 0),
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        secondary_name TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
        credit_limit_cents INTEGER CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX customers_active_name_idx ON customers(active, name COLLATE NOCASE);
      CREATE INDEX customers_phone_idx ON customers(phone);
      CREATE INDEX customers_email_idx ON customers(email COLLATE NOCASE);
      CREATE INDEX customers_account_number_idx ON customers(account_number COLLATE NOCASE);
      CREATE INDEX customers_account_barcode_idx ON customers(account_barcode COLLATE NOCASE);

      ALTER TABLE sales ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT;
      ALTER TABLE sales ADD COLUMN customer_name TEXT;
      ALTER TABLE sales ADD COLUMN customer_account_number TEXT;
      ALTER TABLE sales ADD COLUMN customer_balance_before_cents INTEGER;
      ALTER TABLE sales ADD COLUMN customer_balance_after_cents INTEGER;
      ALTER TABLE sales ADD COLUMN tender_type TEXT NOT NULL DEFAULT 'immediate_payment' CHECK (tender_type IN ('cash', 'external_terminal', 'account', 'immediate_payment'));
      CREATE INDEX sales_customer_idx ON sales(customer_id);

      DROP TRIGGER IF EXISTS sales_status_transition;
      CREATE TRIGGER sales_status_transition BEFORE UPDATE OF status ON sales
      WHEN NOT ((OLD.status='open' AND NEW.status='awaiting_payment') OR
                (OLD.status='awaiting_payment' AND NEW.status='paid') OR
                (OLD.status='awaiting_payment' AND NEW.status='completed') OR
                (OLD.status='paid' AND NEW.status='completed') OR
                (OLD.status IN ('open','awaiting_payment') AND NEW.status='voided') OR
                (OLD.status='completed' AND NEW.status='refunded'))
      BEGIN SELECT RAISE(ABORT, 'Invalid sale status transition'); END;

      CREATE TABLE account_payments (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        receipt_number INTEGER NOT NULL UNIQUE,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        customer_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        method TEXT NOT NULL CHECK (method IN ('cash', 'external_terminal')),
        cash_received_cents INTEGER,
        change_due_cents INTEGER,
        terminal_reference TEXT,
        external_approved INTEGER CHECK (external_approved IN (0, 1)),
        previous_balance_cents INTEGER NOT NULL,
        new_balance_cents INTEGER NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        CHECK (
          (method = 'cash' AND cash_received_cents >= amount_cents AND change_due_cents = cash_received_cents - amount_cents AND terminal_reference IS NULL AND external_approved IS NULL)
          OR (method = 'external_terminal' AND cash_received_cents IS NULL AND change_due_cents IS NULL AND external_approved = 1)
        )
      );
      CREATE INDEX account_payments_customer_idx ON account_payments(customer_id, created_at DESC);

      CREATE TRIGGER account_payments_no_update
      BEFORE UPDATE ON account_payments BEGIN
        SELECT RAISE(ABORT, 'Account payments are immutable');
      END;

      CREATE TRIGGER account_payments_no_delete
      BEFORE DELETE ON account_payments BEGIN
        SELECT RAISE(ABORT, 'Account payments are immutable');
      END;

      CREATE TABLE customer_ledger (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
        entry_type TEXT NOT NULL CHECK (entry_type IN ('sale_charge', 'payment', 'manual_debit_adjustment', 'manual_credit_adjustment')),
        occurred_at TEXT NOT NULL,
        related_sale_id TEXT REFERENCES sales(id) ON DELETE RESTRICT,
        related_account_payment_id TEXT REFERENCES account_payments(id) ON DELETE RESTRICT,
        device_id TEXT,
        notes TEXT NOT NULL CHECK (length(trim(notes)) > 0),
        sequence INTEGER NOT NULL UNIQUE,
        CHECK (
          (entry_type = 'sale_charge' AND amount_cents > 0 AND related_sale_id IS NOT NULL AND related_account_payment_id IS NULL)
          OR (entry_type = 'payment' AND amount_cents < 0 AND related_account_payment_id IS NOT NULL AND related_sale_id IS NULL)
          OR (entry_type = 'manual_debit_adjustment' AND amount_cents > 0 AND related_sale_id IS NULL AND related_account_payment_id IS NULL)
          OR (entry_type = 'manual_credit_adjustment' AND amount_cents < 0 AND related_sale_id IS NULL AND related_account_payment_id IS NULL)
        )
      );
      CREATE UNIQUE INDEX customer_ledger_sequence_idx ON customer_ledger(sequence);
      CREATE INDEX customer_ledger_customer_seq_idx ON customer_ledger(customer_id, sequence ASC);
      CREATE INDEX customer_ledger_customer_time_idx ON customer_ledger(customer_id, occurred_at, sequence);
      CREATE UNIQUE INDEX customer_ledger_sale_idx ON customer_ledger(related_sale_id) WHERE related_sale_id IS NOT NULL;
      CREATE UNIQUE INDEX customer_ledger_payment_idx ON customer_ledger(related_account_payment_id) WHERE related_account_payment_id IS NOT NULL;

      CREATE TRIGGER customer_ledger_no_update
      BEFORE UPDATE ON customer_ledger BEGIN
        SELECT RAISE(ABORT, 'Customer ledger entries are append-only');
      END;

      CREATE TRIGGER customer_ledger_no_delete
      BEFORE DELETE ON customer_ledger BEGIN
        SELECT RAISE(ABORT, 'Customer ledger entries are append-only');
      END;

      CREATE TRIGGER validate_customer_ledger_sale_charge
      BEFORE INSERT ON customer_ledger
      WHEN NEW.entry_type = 'sale_charge'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM sales
            WHERE sales.id = NEW.related_sale_id
              AND sales.customer_id = NEW.customer_id
              AND sales.total_cents = NEW.amount_cents
              AND sales.tender_type = 'account'
          ) THEN RAISE(ABORT, 'sale_charge ledger entry must match an existing account sale for the same customer and amount')
          WHEN EXISTS (
            SELECT 1 FROM customer_ledger
            WHERE customer_ledger.related_sale_id = NEW.related_sale_id
          ) THEN RAISE(ABORT, 'A ledger entry for this sale already exists')
        END;
      END;

      CREATE TRIGGER validate_customer_ledger_payment
      BEFORE INSERT ON customer_ledger
      WHEN NEW.entry_type = 'payment'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM account_payments
            WHERE account_payments.id = NEW.related_account_payment_id
              AND account_payments.customer_id = NEW.customer_id
              AND account_payments.amount_cents = -NEW.amount_cents
          ) THEN RAISE(ABORT, 'payment ledger entry must match an existing account payment for the same customer and amount')
          WHEN EXISTS (
            SELECT 1 FROM customer_ledger
            WHERE customer_ledger.related_account_payment_id = NEW.related_account_payment_id
          ) THEN RAISE(ABORT, 'A ledger entry for this account payment already exists')
        END;
      END;

      CREATE TRIGGER prevent_sale_delete_if_ledger_linked
      BEFORE DELETE ON sales
      BEGIN
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM customer_ledger WHERE customer_ledger.related_sale_id = OLD.id)
          THEN RAISE(ABORT, 'Cannot delete sale that is linked to customer ledger')
        END;
      END;

      CREATE TRIGGER prevent_sale_update_if_ledger_linked
      BEFORE UPDATE OF customer_id, total_cents, tender_type ON sales
      WHEN EXISTS (SELECT 1 FROM customer_ledger WHERE customer_ledger.related_sale_id = OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'Cannot modify financial fields of a sale that is linked to customer ledger');
      END;

      CREATE TRIGGER prevent_account_payment_delete_if_ledger_linked
      BEFORE DELETE ON account_payments
      BEGIN
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM customer_ledger WHERE customer_ledger.related_account_payment_id = OLD.id)
          THEN RAISE(ABORT, 'Cannot delete account payment that is linked to customer ledger')
        END;
      END;

      CREATE TABLE account_payment_print_attempts (
        id TEXT PRIMARY KEY,
        account_payment_id TEXT NOT NULL REFERENCES account_payments(id) ON DELETE RESTRICT,
        attempted_at TEXT NOT NULL,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        error_message TEXT
      );
      CREATE INDEX account_payment_print_attempts_payment_idx ON account_payment_print_attempts(account_payment_id, attempted_at);
    `,
  },
  {
    version: 5,
    name: 'printer_settings',
    sql: `
      ALTER TABLE store_settings ADD COLUMN receipt_printer_name TEXT;
      ALTER TABLE store_settings ADD COLUMN receipt_paper_width_mm INTEGER NOT NULL DEFAULT 80 CHECK (receipt_paper_width_mm IN (58, 80));
      ALTER TABLE store_settings ADD COLUMN label_printer_name TEXT;
      ALTER TABLE store_settings ADD COLUMN default_label_template TEXT NOT NULL DEFAULT 'thermal_40x30' CHECK (default_label_template IN ('thermal_40x30', 'thermal_57x32', 'letter_avery_5160'));
    `,
  },
  {
    version: 6,
    name: 'optional_cloud_sync_outbox',
    sql: `
      CREATE TABLE sync_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
        entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'append')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        pushed_at TEXT
      );
      CREATE INDEX sync_outbox_pushed_idx ON sync_outbox(pushed_at, sequence);
      CREATE INDEX sync_outbox_entity_idx ON sync_outbox(entity_type, entity_id);

      CREATE TRIGGER sync_outbox_no_delete
      BEFORE DELETE ON sync_outbox BEGIN
        SELECT RAISE(ABORT, 'sync_outbox rows are append-only');
      END;

      CREATE TRIGGER sync_outbox_no_update_except_pushed_at
      BEFORE UPDATE ON sync_outbox
      WHEN NEW.sequence IS NOT OLD.sequence
        OR NEW.event_id IS NOT OLD.event_id
        OR NEW.entity_type IS NOT OLD.entity_type
        OR NEW.entity_id IS NOT OLD.entity_id
        OR NEW.operation IS NOT OLD.operation
        OR NEW.payload_json IS NOT OLD.payload_json
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'sync_outbox rows are append-only except for pushed_at');
      END;

      CREATE TABLE sync_settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        store_id TEXT,
        supabase_url TEXT,
        api_key_secret TEXT,
        api_key_encrypted INTEGER NOT NULL DEFAULT 0 CHECK (api_key_encrypted IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        last_sync_at TEXT,
        last_error TEXT,
        backfill_completed INTEGER NOT NULL DEFAULT 0 CHECK (backfill_completed IN (0, 1))
      );
      INSERT INTO sync_settings (singleton_id) VALUES (1);
    `,
  },

  {
    version: 7,
    name: 'integrated_card_payments',
    sql: `
      ALTER TABLE store_settings ADD COLUMN card_processing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (card_processing_enabled IN (0, 1));
      ALTER TABLE store_settings ADD COLUMN card_processor_id TEXT;
      ALTER TABLE store_settings ADD COLUMN card_processor_config_json TEXT;

      CREATE TABLE payment_transactions (
        id TEXT PRIMARY KEY,
        charge_reference TEXT NOT NULL UNIQUE,
        processor_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        status TEXT NOT NULL CHECK (status IN ('initiated','approved','declined','error','unknown','reconciled','needs-attention')),
        processor_transaction_id TEXT,
        card_brand TEXT,
        card_last4 TEXT,
        sale_id TEXT REFERENCES sales(id) ON DELETE RESTRICT,
        cart_snapshot_json TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX payment_transactions_status_idx ON payment_transactions(status);
      CREATE INDEX payment_transactions_sale_idx ON payment_transactions(sale_id);

      CREATE TRIGGER payment_transactions_no_delete
      BEFORE DELETE ON payment_transactions
      BEGIN
        SELECT RAISE(ABORT, 'Payment transactions cannot be deleted');
      END;

      CREATE TRIGGER payment_transactions_no_update_financials
      BEFORE UPDATE ON payment_transactions
      WHEN NEW.charge_reference IS NOT OLD.charge_reference
        OR NEW.processor_id IS NOT OLD.processor_id
        OR NEW.amount_cents IS NOT OLD.amount_cents
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.cart_snapshot_json IS NOT OLD.cart_snapshot_json
        OR NEW.idempotency_key IS NOT OLD.idempotency_key
      BEGIN
        SELECT RAISE(ABORT, 'Payment transaction financial fields are immutable');
      END;

      CREATE TRIGGER payment_transactions_status_transitions
      BEFORE UPDATE OF status ON payment_transactions
      WHEN OLD.status != NEW.status AND NOT (
        (OLD.status = 'initiated' AND NEW.status IN ('approved','declined','error','unknown')) OR
        (OLD.status = 'unknown' AND NEW.status IN ('approved','declined','error')) OR
        (OLD.status = 'approved' AND NEW.status = 'needs-attention')
      )
      BEGIN
        SELECT RAISE(ABORT, 'Invalid payment transaction status transition');
      END;

      CREATE TRIGGER payment_transactions_sale_link
      BEFORE UPDATE OF sale_id ON payment_transactions
      WHEN NEW.sale_id IS NOT NULL AND (
        NOT EXISTS (SELECT 1 FROM sales WHERE id = NEW.sale_id)
        OR NEW.status != 'approved'
      )
      BEGIN
        SELECT RAISE(ABORT, 'Payment transaction sale link must point to a sale with matching total amount and transaction must be approved');
      END;

      CREATE TABLE simulated_processor_store (
        key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: 'kiosk_pairing_and_sale_attribution',
    sql: `
      CREATE TABLE kiosks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        admin_pin_hash TEXT NOT NULL, last_seen_at TEXT, created_at TEXT NOT NULL
      );
      ALTER TABLE sales ADD COLUMN channel TEXT NOT NULL DEFAULT 'manager' CHECK (channel IN ('manager','kiosk'));
      ALTER TABLE sales ADD COLUMN kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL;
      CREATE INDEX sales_kiosk_idx ON sales(kiosk_id, completed_at DESC);
      CREATE TABLE kiosk_server_settings (singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), enabled INTEGER NOT NULL DEFAULT 0, port INTEGER NOT NULL DEFAULT 3939);
      INSERT INTO kiosk_server_settings (singleton_id) VALUES (1);
    `,
  },
  {
    version: 9,
    name: 'payment_transaction_kiosk_attribution',
    sql: `
      ALTER TABLE payment_transactions ADD COLUMN kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL;
      CREATE INDEX payment_transactions_kiosk_idx ON payment_transactions(kiosk_id);
      CREATE TRIGGER payment_transactions_no_update_kiosk
      BEFORE UPDATE OF kiosk_id ON payment_transactions
      WHEN NEW.kiosk_id IS NOT OLD.kiosk_id
      BEGIN SELECT RAISE(ABORT, 'Payment transaction kiosk attribution is immutable'); END;
    `,
  },
  {
    version: 10,
    name: 'logical_kiosk_revocation',
    sql: `
      ALTER TABLE kiosks ADD COLUMN revoked_at TEXT;
      CREATE INDEX kiosks_active_token_idx ON kiosks(token_hash) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 11,
    name: 'payment_inventory_reservations',
    sql: `
      CREATE TABLE payment_inventory_reservations (
        id TEXT PRIMARY KEY, charge_reference TEXT NOT NULL REFERENCES payment_transactions(charge_reference) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK(quantity > 0), status TEXT NOT NULL CHECK(status IN ('held','consumed','released')),
        created_at TEXT NOT NULL, resolved_at TEXT,
        UNIQUE(charge_reference, product_id)
      );
      CREATE INDEX payment_inventory_reservations_available_idx ON payment_inventory_reservations(product_id, status);
      CREATE TRIGGER payment_inventory_reservations_integer_quantity
      BEFORE INSERT ON payment_inventory_reservations
      WHEN typeof(NEW.quantity) != 'integer' OR NEW.quantity < 1
      BEGIN SELECT RAISE(ABORT, 'Reservation quantity must be a positive integer'); END;
    `,
  },
  {
    version: 12,
    name: 'reservation_immutability',
    sql: `
      CREATE TRIGGER IF NOT EXISTS payment_inventory_reservations_integer_quantity_update
      BEFORE UPDATE OF quantity ON payment_inventory_reservations
      WHEN typeof(NEW.quantity) != 'integer' OR NEW.quantity < 1
      BEGIN SELECT RAISE(ABORT, 'Reservation quantity must be a positive integer'); END;
      CREATE TRIGGER IF NOT EXISTS payment_inventory_reservations_immutable_identity
      BEFORE UPDATE OF charge_reference, product_id, quantity ON payment_inventory_reservations
      WHEN NEW.charge_reference IS NOT OLD.charge_reference OR NEW.product_id IS NOT OLD.product_id OR NEW.quantity IS NOT OLD.quantity
      BEGIN SELECT RAISE(ABORT, 'Reservation identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS payment_inventory_reservations_state_transition
      BEFORE UPDATE OF status ON payment_inventory_reservations
      WHEN OLD.status != NEW.status AND NOT (OLD.status='held' AND NEW.status IN ('consumed','released'))
      BEGIN SELECT RAISE(ABORT, 'Invalid reservation status transition'); END;
    `,
  },
  {
    version: 13,
    name: 'held_reservation_catalog_protection',
    sql: `
      CREATE TRIGGER IF NOT EXISTS payment_inventory_reservations_integer_quantity
      BEFORE INSERT ON payment_inventory_reservations
      WHEN typeof(NEW.quantity) != 'integer' OR NEW.quantity < 1
      BEGIN SELECT RAISE(ABORT, 'Reservation quantity must be a positive integer'); END;
      CREATE TRIGGER IF NOT EXISTS product_barcodes_no_change_while_reserved_insert
      BEFORE INSERT ON product_barcodes
      WHEN EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=NEW.product_id AND status='held')
      BEGIN SELECT RAISE(ABORT, 'Product barcode cannot change while card payment is pending'); END;
      CREATE TRIGGER IF NOT EXISTS product_barcodes_no_change_while_reserved_delete
      BEFORE DELETE ON product_barcodes
      WHEN EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=OLD.product_id AND status='held')
      BEGIN SELECT RAISE(ABORT, 'Product barcode cannot change while card payment is pending'); END;
    `,
  },
  {
    version: 14,
    name: 'held_reservation_barcode_update_protection',
    sql: `
      CREATE TRIGGER IF NOT EXISTS product_barcodes_no_change_while_reserved_update
      BEFORE UPDATE OF product_id, value, kind, position ON product_barcodes
      WHEN EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=OLD.product_id AND status='held')
        OR EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=NEW.product_id AND status='held')
      BEGIN SELECT RAISE(ABORT, 'Product barcode cannot change while card payment is pending'); END;
    `,
  },
  {
    version: 15,
    name: 'payment_transaction_frozen_identity',
    before: (db) => {
      db.exec(
        'DROP TRIGGER IF EXISTS payment_transactions_no_update_financials',
      );
      const rows = db
        .prepare(
          `SELECT id, idempotency_key, status, created_at
           FROM payment_transactions
           WHERE idempotency_key IS NOT NULL
           ORDER BY idempotency_key, created_at, id`,
        )
        .all() as Array<{
        id: string;
        idempotency_key: string;
        status: string;
        created_at: string;
      }>;
      const groups = new Map<string, typeof rows>();
      for (const row of rows) {
        const group = groups.get(row.idempotency_key) ?? [];
        group.push(row);
        groups.set(row.idempotency_key, group);
      }
      for (const [key, group] of groups) {
        if (group.length < 2) continue;
        const unsafe = group.filter(
          (row) => !['declined', 'error'].includes(row.status),
        );
        if (unsafe.length > 0) {
          throw new Error(
            `Cannot repair duplicate payment idempotency key "${key}": active or approved rows ${group
              .map((row) => `${row.id} (${row.status})`)
              .join(
                ', ',
              )}. Resolve these rows before migrating past version 14.`,
          );
        }
        for (const duplicate of group.slice(1)) {
          db.prepare(
            'UPDATE payment_transactions SET idempotency_key = NULL WHERE id = ?',
          ).run(duplicate.id);
        }
      }
      db.exec(`
        CREATE TRIGGER payment_transactions_no_update_financials
        BEFORE UPDATE ON payment_transactions
        WHEN NEW.charge_reference IS NOT OLD.charge_reference
          OR NEW.processor_id IS NOT OLD.processor_id
          OR NEW.amount_cents IS NOT OLD.amount_cents
          OR NEW.created_at IS NOT OLD.created_at
          OR NEW.cart_snapshot_json IS NOT OLD.cart_snapshot_json
          OR NEW.idempotency_key IS NOT OLD.idempotency_key
        BEGIN SELECT RAISE(ABORT, 'Payment transaction financial fields are immutable'); END;
      `);
    },
    sql: `
      ALTER TABLE payment_transactions ADD COLUMN snapshot_hash TEXT;
      ALTER TABLE payment_transactions ADD COLUMN processor_config_hash TEXT;
      ALTER TABLE payment_transactions ADD COLUMN origin_channel TEXT NOT NULL DEFAULT 'manager' CHECK (origin_channel IN ('manager','kiosk'));
      ALTER TABLE payment_transactions ADD COLUMN attention_reason TEXT;
      ALTER TABLE payment_transactions ADD COLUMN finalized_at TEXT;

      -- Hard guarantee for exact-once: one idempotency key can only ever own one charge.
      CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_idempotency_unique
        ON payment_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS payment_transactions_attention_idx ON payment_transactions(status, updated_at);

      -- Frozen identity: the canonical snapshot digest, the processor configuration the
      -- authorization was issued under, and the originating channel may never be rewritten.
      CREATE TRIGGER IF NOT EXISTS payment_transactions_no_update_frozen_identity
      BEFORE UPDATE ON payment_transactions
      WHEN NEW.snapshot_hash IS NOT OLD.snapshot_hash
        OR NEW.processor_config_hash IS NOT OLD.processor_config_hash
        OR NEW.origin_channel IS NOT OLD.origin_channel
      BEGIN SELECT RAISE(ABORT, 'Payment transaction frozen identity is immutable'); END;

      -- Replaces the migration-7 transition trigger: an approved charge that cannot be
      -- finalized moves to needs-attention, and an operator retry may promote it back to
      -- approved so the sale link trigger still refuses to attach a sale to anything else.
      DROP TRIGGER IF EXISTS payment_transactions_status_transitions;
      CREATE TRIGGER payment_transactions_status_transitions
      BEFORE UPDATE OF status ON payment_transactions
      WHEN OLD.status != NEW.status AND NOT (
        (OLD.status = 'initiated' AND NEW.status IN ('approved','declined','error','unknown','needs-attention')) OR
        (OLD.status = 'unknown' AND NEW.status IN ('approved','declined','error','needs-attention')) OR
        (OLD.status = 'approved' AND NEW.status = 'needs-attention') OR
        (OLD.status = 'needs-attention' AND NEW.status = 'approved')
      )
      BEGIN
        SELECT RAISE(ABORT, 'Invalid payment transaction status transition');
      END;
    `,
  },
  {
    version: 16,
    name: 'payment_transaction_frozen_processor_config',
    sql: `
      ALTER TABLE payment_transactions ADD COLUMN processor_config_secret TEXT;

      -- Frozen processor configuration is encrypted at rest and may never be rewritten.
      CREATE TRIGGER IF NOT EXISTS payment_transactions_no_update_frozen_processor_config
      BEFORE UPDATE OF processor_config_secret ON payment_transactions
      WHEN NEW.processor_config_secret IS NOT OLD.processor_config_secret
      BEGIN SELECT RAISE(ABORT, 'Payment transaction frozen processor config is immutable'); END;
    `,
  },
  {
    version: 17,
    name: 'local_backup_attempts',
    sql: `
      CREATE TABLE backup_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempted_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual', 'premigration', 'prerestore')),
        filename TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        message TEXT NOT NULL,
        images_copied INTEGER NOT NULL DEFAULT 0 CHECK (images_copied >= 0),
        images_missing INTEGER NOT NULL DEFAULT 0 CHECK (images_missing >= 0)
      );
      CREATE INDEX backup_attempts_time_idx
        ON backup_attempts(attempted_at DESC);

      CREATE TABLE restore_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        completed_at TEXT NOT NULL,
        filename TEXT NOT NULL,
        images_restored INTEGER NOT NULL CHECK (images_restored >= 0),
        images_missing INTEGER NOT NULL CHECK (images_missing >= 0),
        message TEXT NOT NULL
      );
      CREATE INDEX restore_results_time_idx
        ON restore_results(completed_at DESC);
    `,
  },
  {
    version: 18,
    name: 'daily_closes',
    sql: `
      CREATE TABLE daily_closes (
        id TEXT PRIMARY KEY,
        business_date TEXT NOT NULL UNIQUE,
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        opening_float_cents INTEGER NOT NULL CHECK (opening_float_cents >= 0),
        counted_cash_cents INTEGER NOT NULL CHECK (counted_cash_cents >= 0),
        expected_cash_cents INTEGER NOT NULL,
        over_short_cents INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        closed_at TEXT NOT NULL
      );
      CREATE INDEX daily_closes_date_idx ON daily_closes(business_date DESC);
      CREATE TRIGGER daily_closes_no_update
      BEFORE UPDATE ON daily_closes BEGIN
        SELECT RAISE(ABORT, 'Daily closes are immutable');
      END;
      CREATE TRIGGER daily_closes_no_delete
      BEFORE DELETE ON daily_closes BEGIN
        SELECT RAISE(ABORT, 'Daily closes cannot be deleted');
      END;
    `,
  },
  {
    version: 19,
    name: 'returns_and_refunds',
    sql: `
      CREATE TABLE refunds (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        receipt_number INTEGER NOT NULL UNIQUE,
        sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        method TEXT NOT NULL CHECK (method IN ('cash','external_terminal','integrated_card','account')),
        subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
        tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        terminal_reference TEXT,
        charge_reference TEXT,
        processor_refund_id TEXT,
        customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
        created_at TEXT NOT NULL,
        CHECK (subtotal_cents + tax_cents = amount_cents),
        CHECK ((method = 'account' AND customer_id IS NOT NULL)
            OR (method <> 'account' AND customer_id IS NULL)),
        CHECK ((method = 'integrated_card' AND charge_reference IS NOT NULL)
            OR (method <> 'integrated_card' AND processor_refund_id IS NULL))
      );
      CREATE INDEX refunds_sale_idx ON refunds(sale_id);
      CREATE INDEX refunds_time_idx ON refunds(created_at DESC);
      CREATE TRIGGER refunds_no_update BEFORE UPDATE ON refunds BEGIN
        SELECT RAISE(ABORT, 'Refunds are append-only');
      END;
      CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds BEGIN
        SELECT RAISE(ABORT, 'Refunds are append-only');
      END;

      CREATE TABLE refund_items (
        id TEXT PRIMARY KEY,
        refund_id TEXT NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
        sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        restocked INTEGER NOT NULL CHECK (restocked IN (0,1)),
        subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
        tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        CHECK (subtotal_cents + tax_cents = amount_cents)
      );
      CREATE INDEX refund_items_refund_idx ON refund_items(refund_id);
      CREATE INDEX refund_items_sale_item_idx ON refund_items(sale_item_id);
      CREATE TRIGGER refund_items_no_update BEFORE UPDATE ON refund_items BEGIN
        SELECT RAISE(ABORT, 'Refund items are append-only');
      END;
      CREATE TRIGGER refund_items_no_delete BEFORE DELETE ON refund_items BEGIN
        SELECT RAISE(ABORT, 'Refund items are append-only');
      END;

      DROP TRIGGER IF EXISTS prevent_sale_delete_if_ledger_linked;
      DROP TRIGGER IF EXISTS prevent_sale_update_if_ledger_linked;
      DROP TRIGGER IF EXISTS prevent_account_payment_delete_if_ledger_linked;

      CREATE TABLE customer_ledger_new (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
        entry_type TEXT NOT NULL CHECK (entry_type IN ('sale_charge', 'payment', 'manual_debit_adjustment', 'manual_credit_adjustment', 'sale_refund')),
        occurred_at TEXT NOT NULL,
        related_sale_id TEXT REFERENCES sales(id) ON DELETE RESTRICT,
        related_account_payment_id TEXT REFERENCES account_payments(id) ON DELETE RESTRICT,
        related_refund_id TEXT REFERENCES refunds(id) ON DELETE RESTRICT,
        device_id TEXT,
        notes TEXT NOT NULL CHECK (length(trim(notes)) > 0),
        sequence INTEGER NOT NULL UNIQUE,
        CHECK (
          (entry_type = 'sale_charge' AND amount_cents > 0 AND related_sale_id IS NOT NULL AND related_account_payment_id IS NULL AND related_refund_id IS NULL)
          OR (entry_type = 'payment' AND amount_cents < 0 AND related_account_payment_id IS NOT NULL AND related_sale_id IS NULL AND related_refund_id IS NULL)
          OR (entry_type = 'manual_debit_adjustment' AND amount_cents > 0 AND related_sale_id IS NULL AND related_account_payment_id IS NULL AND related_refund_id IS NULL)
          OR (entry_type = 'manual_credit_adjustment' AND amount_cents < 0 AND related_sale_id IS NULL AND related_account_payment_id IS NULL AND related_refund_id IS NULL)
          OR (entry_type = 'sale_refund' AND amount_cents < 0 AND related_sale_id IS NOT NULL AND related_account_payment_id IS NULL AND related_refund_id IS NOT NULL)
        )
      );
      INSERT INTO customer_ledger_new
        (id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
         related_sale_id, related_account_payment_id, related_refund_id, device_id,
         notes, sequence)
      SELECT id, operation_id, customer_id, amount_cents, entry_type, occurred_at,
             related_sale_id, related_account_payment_id, NULL, device_id,
             notes, sequence
      FROM customer_ledger;
      DROP TABLE customer_ledger;
      ALTER TABLE customer_ledger_new RENAME TO customer_ledger;

      CREATE UNIQUE INDEX customer_ledger_sequence_idx ON customer_ledger(sequence);
      CREATE INDEX customer_ledger_customer_seq_idx ON customer_ledger(customer_id, sequence ASC);
      CREATE INDEX customer_ledger_customer_time_idx ON customer_ledger(customer_id, occurred_at, sequence);
      CREATE UNIQUE INDEX customer_ledger_sale_charge_idx
        ON customer_ledger(related_sale_id)
        WHERE related_sale_id IS NOT NULL AND entry_type = 'sale_charge';
      CREATE UNIQUE INDEX customer_ledger_payment_idx ON customer_ledger(related_account_payment_id)
        WHERE related_account_payment_id IS NOT NULL;
      CREATE UNIQUE INDEX customer_ledger_refund_idx
        ON customer_ledger(related_refund_id)
        WHERE related_refund_id IS NOT NULL;

      CREATE TRIGGER customer_ledger_no_update
      BEFORE UPDATE ON customer_ledger BEGIN
        SELECT RAISE(ABORT, 'Customer ledger entries are append-only');
      END;
      CREATE TRIGGER customer_ledger_no_delete
      BEFORE DELETE ON customer_ledger BEGIN
        SELECT RAISE(ABORT, 'Customer ledger entries are append-only');
      END;

      CREATE TRIGGER validate_customer_ledger_sale_charge
      BEFORE INSERT ON customer_ledger
      WHEN NEW.entry_type = 'sale_charge'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM sales
            WHERE sales.id = NEW.related_sale_id
              AND sales.customer_id = NEW.customer_id
              AND sales.total_cents = NEW.amount_cents
              AND sales.tender_type = 'account'
          ) THEN RAISE(ABORT, 'sale_charge ledger entry must match an existing account sale for the same customer and amount')
          WHEN EXISTS (
            SELECT 1 FROM customer_ledger
            WHERE customer_ledger.related_sale_id = NEW.related_sale_id
              AND customer_ledger.entry_type = 'sale_charge'
          ) THEN RAISE(ABORT, 'A ledger entry for this sale already exists')
        END;
      END;

      CREATE TRIGGER validate_customer_ledger_payment
      BEFORE INSERT ON customer_ledger
      WHEN NEW.entry_type = 'payment'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM account_payments
            WHERE account_payments.id = NEW.related_account_payment_id
              AND account_payments.customer_id = NEW.customer_id
              AND account_payments.amount_cents = -NEW.amount_cents
          ) THEN RAISE(ABORT, 'payment ledger entry must match an existing account payment for the same customer and amount')
          WHEN EXISTS (
            SELECT 1 FROM customer_ledger
            WHERE customer_ledger.related_account_payment_id = NEW.related_account_payment_id
          ) THEN RAISE(ABORT, 'A ledger entry for this account payment already exists')
        END;
      END;

      CREATE TRIGGER validate_customer_ledger_sale_refund
      BEFORE INSERT ON customer_ledger
      WHEN NEW.entry_type = 'sale_refund'
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM refunds
            WHERE refunds.id = NEW.related_refund_id
              AND refunds.sale_id = NEW.related_sale_id
              AND refunds.customer_id = NEW.customer_id
              AND refunds.method = 'account'
              AND refunds.amount_cents = -NEW.amount_cents
          ) THEN RAISE(ABORT, 'sale_refund ledger entry must match an existing account refund for the same sale and customer')
          WHEN EXISTS (
            SELECT 1 FROM customer_ledger
            WHERE customer_ledger.related_refund_id = NEW.related_refund_id
          ) THEN RAISE(ABORT, 'A ledger entry for this refund already exists')
        END;
      END;

      CREATE TRIGGER prevent_sale_delete_if_ledger_linked
      BEFORE DELETE ON sales
      BEGIN
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM customer_ledger WHERE customer_ledger.related_sale_id = OLD.id)
          THEN RAISE(ABORT, 'Cannot delete sale that is linked to customer ledger')
        END;
      END;

      CREATE TRIGGER prevent_sale_update_if_ledger_linked
      BEFORE UPDATE OF customer_id, total_cents, tender_type ON sales
      WHEN EXISTS (SELECT 1 FROM customer_ledger WHERE customer_ledger.related_sale_id = OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'Cannot modify financial fields of a sale that is linked to customer ledger');
      END;

      CREATE TRIGGER prevent_account_payment_delete_if_ledger_linked
      BEFORE DELETE ON account_payments
      BEGIN
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM customer_ledger WHERE customer_ledger.related_account_payment_id = OLD.id)
          THEN RAISE(ABORT, 'Cannot delete account payment that is linked to customer ledger')
        END;
      END;
    `,
  },
  {
    version: 20,
    name: 'update_feed_url',
    sql: `
      ALTER TABLE store_settings ADD COLUMN update_feed_url TEXT;
    `,
  },
  {
    version: 21,
    name: 'automatic_updates_enabled',
    sql: `
      ALTER TABLE store_settings ADD COLUMN automatic_updates_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automatic_updates_enabled IN (0, 1));
    `,
  },
  {
    version: 22,
    name: 'terminal_void_payment_state',
    sql: `
      DROP TRIGGER IF EXISTS payment_transactions_no_delete;
      DROP TRIGGER IF EXISTS payment_transactions_no_update_financials;
      DROP TRIGGER IF EXISTS payment_transactions_status_transitions;
      DROP TRIGGER IF EXISTS payment_transactions_sale_link;
      DROP TRIGGER IF EXISTS payment_transactions_no_update_kiosk;
      DROP TRIGGER IF EXISTS payment_transactions_no_update_frozen_identity;
      DROP TRIGGER IF EXISTS payment_transactions_no_update_frozen_processor_config;
      DROP TRIGGER IF EXISTS payment_transactions_no_sale_link_voided;
      DROP TRIGGER IF EXISTS payment_inventory_reservations_integer_quantity;
      DROP TRIGGER IF EXISTS payment_inventory_reservations_integer_quantity_update;
      DROP TRIGGER IF EXISTS payment_inventory_reservations_immutable_identity;
      DROP TRIGGER IF EXISTS payment_inventory_reservations_state_transition;
      DROP TRIGGER IF EXISTS product_barcodes_no_change_while_reserved_insert;
      DROP TRIGGER IF EXISTS product_barcodes_no_change_while_reserved_delete;
      DROP TRIGGER IF EXISTS product_barcodes_no_change_while_reserved_update;

      ALTER TABLE payment_inventory_reservations RENAME TO payment_inventory_reservations_v22_old;
      ALTER TABLE payment_transactions RENAME TO payment_transactions_v22_old;

      CREATE TABLE payment_transactions (
        id TEXT PRIMARY KEY,
        charge_reference TEXT NOT NULL UNIQUE,
        processor_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        status TEXT NOT NULL CHECK (status IN ('initiated','approved','declined','error','unknown','reconciled','needs-attention','voided')),
        processor_transaction_id TEXT,
        card_brand TEXT,
        card_last4 TEXT,
        sale_id TEXT REFERENCES sales(id) ON DELETE RESTRICT,
        cart_snapshot_json TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL,
        snapshot_hash TEXT,
        processor_config_hash TEXT,
        origin_channel TEXT NOT NULL DEFAULT 'manager' CHECK (origin_channel IN ('manager','kiosk')),
        attention_reason TEXT,
        finalized_at TEXT,
        processor_config_secret TEXT,
        resolved_at TEXT,
        resolved_by_note TEXT
      );
      INSERT INTO payment_transactions (
        id, charge_reference, processor_id, amount_cents, status,
        processor_transaction_id, card_brand, card_last4, sale_id,
        cart_snapshot_json, idempotency_key, created_at, updated_at, kiosk_id,
        snapshot_hash, processor_config_hash, origin_channel, attention_reason,
        finalized_at, processor_config_secret
      )
      SELECT id, charge_reference, processor_id, amount_cents, status,
             processor_transaction_id, card_brand, card_last4, sale_id,
             cart_snapshot_json, idempotency_key, created_at, updated_at, kiosk_id,
             snapshot_hash, processor_config_hash, origin_channel, attention_reason,
             finalized_at, processor_config_secret
      FROM payment_transactions_v22_old;

      CREATE TABLE payment_inventory_reservations (
        id TEXT PRIMARY KEY,
        charge_reference TEXT NOT NULL REFERENCES payment_transactions(charge_reference) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        status TEXT NOT NULL CHECK(status IN ('held','consumed','released')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(charge_reference, product_id)
      );
      INSERT INTO payment_inventory_reservations
        (id, charge_reference, product_id, quantity, status, created_at, resolved_at)
      SELECT id, charge_reference, product_id, quantity, status, created_at, resolved_at
      FROM payment_inventory_reservations_v22_old;

      DROP TABLE payment_inventory_reservations_v22_old;
      DROP TABLE payment_transactions_v22_old;

      CREATE INDEX payment_transactions_status_idx ON payment_transactions(status);
      CREATE INDEX payment_transactions_sale_idx ON payment_transactions(sale_id);
      CREATE INDEX payment_transactions_kiosk_idx ON payment_transactions(kiosk_id);
      CREATE INDEX payment_transactions_attention_idx ON payment_transactions(status, updated_at);
      CREATE UNIQUE INDEX payment_transactions_idempotency_unique
        ON payment_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE INDEX payment_inventory_reservations_available_idx ON payment_inventory_reservations(product_id, status);
      CREATE TRIGGER payment_transactions_no_delete
      BEFORE DELETE ON payment_transactions
      BEGIN SELECT RAISE(ABORT, 'Payment transactions cannot be deleted'); END;
      CREATE TRIGGER payment_transactions_no_update_financials
      BEFORE UPDATE ON payment_transactions
      WHEN NEW.charge_reference IS NOT OLD.charge_reference
        OR NEW.processor_id IS NOT OLD.processor_id
        OR NEW.amount_cents IS NOT OLD.amount_cents
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.cart_snapshot_json IS NOT OLD.cart_snapshot_json
        OR NEW.idempotency_key IS NOT OLD.idempotency_key
      BEGIN SELECT RAISE(ABORT, 'Payment transaction financial fields are immutable'); END;
      CREATE TRIGGER payment_transactions_status_transitions
      BEFORE UPDATE OF status ON payment_transactions
      WHEN OLD.status != NEW.status AND NOT (
        (OLD.status = 'initiated' AND NEW.status IN ('approved','declined','error','unknown','needs-attention')) OR
        (OLD.status = 'unknown' AND NEW.status IN ('approved','declined','error','needs-attention','voided')) OR
        (OLD.status = 'approved' AND NEW.status = 'needs-attention') OR
        (OLD.status = 'needs-attention' AND NEW.status IN ('approved','voided'))
      )
      BEGIN SELECT RAISE(ABORT, 'Invalid payment transaction status transition'); END;
      CREATE TRIGGER payment_transactions_sale_link
      BEFORE UPDATE OF sale_id ON payment_transactions
      WHEN NEW.sale_id IS NOT NULL AND (
        NOT EXISTS (SELECT 1 FROM sales WHERE id = NEW.sale_id)
        OR NEW.status != 'approved'
      )
      BEGIN SELECT RAISE(ABORT, 'Payment transaction sale link must point to a sale with matching total amount and transaction must be approved'); END;
      CREATE TRIGGER payment_transactions_no_sale_link_voided
      BEFORE UPDATE OF sale_id ON payment_transactions
      WHEN NEW.sale_id IS NOT NULL AND NEW.status = 'voided'
      BEGIN SELECT RAISE(ABORT, 'Voided payment transactions cannot be linked to a sale'); END;
      CREATE TRIGGER payment_transactions_no_update_kiosk
      BEFORE UPDATE OF kiosk_id ON payment_transactions
      WHEN NEW.kiosk_id IS NOT OLD.kiosk_id
      BEGIN SELECT RAISE(ABORT, 'Payment transaction kiosk attribution is immutable'); END;
      CREATE TRIGGER payment_transactions_no_update_frozen_identity
      BEFORE UPDATE ON payment_transactions
      WHEN NEW.snapshot_hash IS NOT OLD.snapshot_hash
        OR NEW.processor_config_hash IS NOT OLD.processor_config_hash
        OR NEW.origin_channel IS NOT OLD.origin_channel
      BEGIN SELECT RAISE(ABORT, 'Payment transaction frozen identity is immutable'); END;
      CREATE TRIGGER payment_transactions_no_update_frozen_processor_config
      BEFORE UPDATE OF processor_config_secret ON payment_transactions
      WHEN NEW.processor_config_secret IS NOT OLD.processor_config_secret
      BEGIN SELECT RAISE(ABORT, 'Payment transaction frozen processor config is immutable'); END;
      CREATE TRIGGER payment_inventory_reservations_integer_quantity
      BEFORE INSERT ON payment_inventory_reservations
      WHEN typeof(NEW.quantity) != 'integer' OR NEW.quantity < 1
      BEGIN SELECT RAISE(ABORT, 'Reservation quantity must be a positive integer'); END;
      CREATE TRIGGER payment_inventory_reservations_integer_quantity_update
      BEFORE UPDATE OF quantity ON payment_inventory_reservations
      WHEN typeof(NEW.quantity) != 'integer' OR NEW.quantity < 1
      BEGIN SELECT RAISE(ABORT, 'Reservation quantity must be a positive integer'); END;
      CREATE TRIGGER payment_inventory_reservations_immutable_identity
      BEFORE UPDATE OF charge_reference, product_id, quantity ON payment_inventory_reservations
      WHEN NEW.charge_reference IS NOT OLD.charge_reference OR NEW.product_id IS NOT OLD.product_id OR NEW.quantity IS NOT OLD.quantity
      BEGIN SELECT RAISE(ABORT, 'Reservation identity is immutable'); END;
      CREATE TRIGGER payment_inventory_reservations_state_transition
      BEFORE UPDATE OF status ON payment_inventory_reservations
      WHEN OLD.status != NEW.status AND NOT (OLD.status='held' AND NEW.status IN ('consumed','released'))
      BEGIN SELECT RAISE(ABORT, 'Invalid reservation status transition'); END;
      CREATE TRIGGER product_barcodes_no_change_while_reserved_insert
      BEFORE INSERT ON product_barcodes
      WHEN EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=NEW.product_id AND status='held')
      BEGIN SELECT RAISE(ABORT, 'Product barcode cannot change while card payment is pending'); END;
      CREATE TRIGGER product_barcodes_no_change_while_reserved_delete
      BEFORE DELETE ON product_barcodes
      WHEN EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=OLD.product_id AND status='held')
      BEGIN SELECT RAISE(ABORT, 'Product barcode cannot change while card payment is pending'); END;
      CREATE TRIGGER product_barcodes_no_change_while_reserved_update
      BEFORE UPDATE OF product_id, value, kind, position ON product_barcodes
      WHEN EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=OLD.product_id AND status='held')
        OR EXISTS (SELECT 1 FROM payment_inventory_reservations WHERE product_id=NEW.product_id AND status='held')
      BEGIN SELECT RAISE(ABORT, 'Product barcode cannot change while card payment is pending'); END;
    `,
  },
  {
    version: 23,
    name: 'refund_intents',
    sql: `
      CREATE TABLE refund_intents (
        operation_id TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        method TEXT NOT NULL CHECK (method IN ('cash','external_terminal','integrated_card','account')),
        charge_reference TEXT,
        allocation_json TEXT NOT NULL,
        allocation_hash TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        state TEXT NOT NULL CHECK (state IN ('recorded','sent','completed','failed','attention')),
        processor_refund_id TEXT,
        attention_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX refund_intents_state_idx ON refund_intents(state, updated_at);
      CREATE TRIGGER refund_intents_no_update_allocation
      BEFORE UPDATE OF operation_id, sale_id, method, charge_reference,
        allocation_json, allocation_hash, amount_cents, created_at
      ON refund_intents
      WHEN NEW.operation_id IS NOT OLD.operation_id
        OR NEW.sale_id IS NOT OLD.sale_id
        OR NEW.method IS NOT OLD.method
        OR NEW.charge_reference IS NOT OLD.charge_reference
        OR NEW.allocation_json IS NOT OLD.allocation_json
        OR NEW.allocation_hash IS NOT OLD.allocation_hash
        OR NEW.amount_cents IS NOT OLD.amount_cents
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Refund intent immutable fields cannot change'); END;
      CREATE TRIGGER refund_intents_state_transitions
      BEFORE UPDATE OF state ON refund_intents
      WHEN OLD.state != NEW.state AND NOT (
        (OLD.state = 'recorded' AND NEW.state IN ('sent','failed','completed')) OR
        (OLD.state = 'sent' AND NEW.state IN ('completed','attention','failed')) OR
        (OLD.state = 'attention' AND NEW.state IN ('completed','failed'))
      )
      BEGIN SELECT RAISE(ABORT, 'Invalid refund intent state transition'); END;
      CREATE TRIGGER refund_intents_terminal_immutable
      BEFORE UPDATE ON refund_intents
      WHEN OLD.state IN ('completed','failed')
      BEGIN SELECT RAISE(ABORT, 'Completed and failed refund intents are immutable'); END;
    `,
  },
  {
    version: 24,
    name: 'device_settings',
    sql: `
      CREATE TABLE device_settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        card_processor_config_secret TEXT,
        card_processor_config_encrypted INTEGER NOT NULL DEFAULT 0 CHECK (card_processor_config_encrypted IN (0, 1)),
        update_feed_url TEXT,
        automatic_updates_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automatic_updates_enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      INSERT INTO device_settings (
        singleton_id, card_processor_config_secret, card_processor_config_encrypted,
        update_feed_url, automatic_updates_enabled, updated_at
      )
      SELECT
        1, card_processor_config_json, 0, update_feed_url,
        COALESCE(automatic_updates_enabled, 1), CURRENT_TIMESTAMP
      FROM store_settings WHERE singleton_id = 1;
      UPDATE store_settings
      SET card_processor_config_json = NULL,
          update_feed_url = NULL,
          automatic_updates_enabled = 1
      WHERE singleton_id = 1;
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
      migration.before?.(db);
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
