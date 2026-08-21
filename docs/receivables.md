# Customer Accounts, Receivables, and Ledger

## Overview

Shul Store Manager provides an offline-first customer receivables system integrated directly with the transactional sales and inventory foundation. It enables shamosim to manage customer accounts, assign account numbers and Code 128 barcodes, set credit limits, charge purchases to customer accounts at checkout, accept partial or full balance payments, reprint receipts, and generate historical customer statements.

## Balance Convention

Customer balances follow a strict sign convention across the database, shared domain, and UI:

- **Positive balance (`> 0`)**: The customer owes money to the store (receivable). Displayed in the UI as **"Amount owed: $X.XX"**.
- **Negative balance (`< 0`)**: The customer has store credit (overpayment or credit balance). Displayed in the UI as **"Customer credit: $X.XX"**.
- **Zero balance (`= 0`)**: The account is fully settled. Displayed as **"Settled ($0.00)"**.

The current balance is **never stored as a mutable column** on the customer record. It is calculated deterministically by summing the customer's append-only ledger entries:

```sql
COALESCE((SELECT SUM(amount_cents) FROM customer_ledger WHERE customer_id = ?), 0)
```

## Customer Data Model

Customer records are stored in the `customers` table:

- `id`: UUID primary key
- `account_number`: Human-readable unique account number (case-insensitive unique index)
- `account_barcode`: Optional unique barcode suitable for Code 128 or external scanners
- `name`: Full name
- `secondary_name`: Optional secondary-language name (e.g. Yiddish/Hebrew)
- `phone`, `email`, `address`, `notes`: Optional contact and administrative details
- `active`: Soft-deactivation flag (1 = active, 0 = inactive). Deactivation is used instead of deletion to protect historical financial integrity.
- `blocked`: Charge restriction flag (1 = blocked, 0 = unblocked). A blocked customer cannot place new charges on account, but may view history and make payments.
- `credit_limit_cents`: Optional customer-specific credit limit in integer cents. When `NULL`, the store-wide default credit limit applies.
- `created_at`, `updated_at`: UTC ISO-8601 timestamps.

### Account Number and Barcode Generation

- **Account numbers**: Can be manually entered or auto-generated offline sequentially (e.g. `1001`, `1002`).
- **Account barcodes**: Can be manually scanned or generated offline using the format `SSM-CUST-<TIMESTAMP>-<RANDOM>`, suitable for Code 128 rendering without online allocators.

## Append-Only Customer Account Ledger

All balance-affecting transactions are recorded in the immutable `customer_ledger` table:

- `id`: UUID primary key
- `operation_id`: Globally unique idempotency key
- `customer_id`: Foreign key referencing `customers(id)`
- `amount_cents`: Signed integer cents (`amount_cents <> 0`)
- `entry_type`: Constrained to `'sale_charge'`, `'payment'`, `'manual_debit_adjustment'`, `'manual_credit_adjustment'`
- `occurred_at`: UTC timestamp
- `related_sale_id`: Optional foreign key to `sales(id)`
- `related_account_payment_id`: Optional foreign key to `account_payments(id)`
- `notes`: Required human-readable description
- `sequence`: Monotonically increasing deterministic sequence number

### Direction and Immutability Rules

1. **Direction Constraints**:
   - `sale_charge` and `manual_debit_adjustment` must have `amount_cents > 0`.
   - `payment` and `manual_credit_adjustment` must have `amount_cents < 0`.
   - Zero-value entries are strictly forbidden by database check constraints.
2. **Append-Only Triggers**:
   - SQLite triggers `customer_ledger_no_update` and `customer_ledger_no_delete` reject any `UPDATE` or `DELETE` statements at the database level.
   - Corrections must always be made using compensating entries.
3. **Public API Isolation**:
   - Public IPC methods cannot create ledger entries independently from completed sales or payments.

## Store Settings & Credit Limits

Store settings (`store_settings`) configure:

- `customer_accounts_enabled`: Master switch enabling/disabling account charging at checkout.
- `default_credit_limit_cents`: Default credit limit applied when a customer does not have an individual override.
- `allow_customer_credit`: Whether payments that exceed the amount owed (resulting in a negative balance / credit) are allowed.
- `statement_footer`: Custom text printed at the bottom of customer statements.
- `overdue_days`: Standard payment term window.

### Credit Limit Enforcement

For a customer:

```text
effectiveCreditLimit = customer.creditLimitCents ?? storeSettings.defaultCreditLimitCents
availableCredit = effectiveCreditLimit − currentBalance
projectedBalance = currentBalance + saleTotal
```

Before completing an account sale, the database verifies inside the write transaction that:

```text
projectedBalance <= effectiveCreditLimit
```

If `projectedBalance > effectiveCreditLimit`, the sale is blocked and rolled back.

## Transactional Flows

### 1. "Put on Account" Sale Transaction

When a sale is charged to account, the entire operation runs within a single `BEGIN IMMEDIATE` SQLite transaction:

1. **Idempotency check**: If the `completionKey` already exists, return the existing sale without duplicate writes.
2. **Settings check**: Verify customer accounts are enabled.
3. **Customer validation**: Verify customer exists, is active, and is not blocked.
4. **Product & stock validation**: Verify all items are active and in stock.
5. **Credit limit check**: Recalculate customer balance directly from the ledger and ensure `projectedBalance <= effectiveCreditLimit`.
6. **Atomic writes**:
   - Insert `sales` row with customer snapshot (`customer_id`, `customer_name`, `customer_account_number`, `customer_balance_before_cents`, `customer_balance_after_cents`, `tender_type = 'account'`).
   - Insert immutable `sale_items` snapshots.
   - Insert negative `inventory_movements` referencing the sale.
   - Insert positive `sale_charge` in `customer_ledger`.
   - Advance sale status `open → awaiting_payment → completed`.
   - Insert `audit_events` record.
7. If any step fails, the entire transaction rolls back completely.

### 2. Account Payment Transaction

When a customer makes an account payment (via Cash or External Card Terminal):

1. **Idempotency check**: If the `operationId` already exists, return the existing payment.
2. **Customer validation**: Verify customer exists. (Inactive and blocked customers are permitted to make payments to settle existing debts).
3. **Overpayment check**: If `allowCustomerCredit` is disabled and `paymentAmount > currentBalance`, reject the payment.
4. **Cash / Terminal validation**: For cash, verify `cashReceived >= paymentAmount` and calculate change; for external terminal, verify staff approval confirmation.
5. **Atomic writes**:
   - Allocate sequential payment `receipt_number`.
   - Insert `account_payments` record with customer snapshots and previous/new balance snapshots.
   - Insert negative `payment` entry in `customer_ledger`.
   - Insert `audit_events` record.

## Receipts & Statements

- **Account Sale Receipts**: Show customer name, account number, line items, subtotal, tax, total, previous balance, this purchase, and new balance.
- **Account Payment Receipts**: Show payment receipt number, date, customer info, previous balance, payment applied, payment method details, and new balance.
- **Customer Statements**:
  - Filterable by Last 30 Days, Last 90 Days, All Activity, or Custom Date Range.
  - **Opening balance**: Calculated by summing all ledger entries before the period start date.
  - **Ledger entries**: Chronological list showing date, description, receipt reference, charge/payment amounts, and running balances.
  - **Closing balance**: Computed from the ledger running balance at the end of the period.
- **Security & Print Isolation**:
  - All user- and settings-controlled strings are strictly escaped against HTML injection.
  - Receipt and statement printing is handled via isolated Electron windows. Print cancellations or hardware errors are recorded independently in `print_attempts` or `account_payment_print_attempts` without altering or rolling back completed sales or payments.

## Features Intentionally Deferred

The following features remain deferred to future milestones:

- Integrated/tokenized card payment processor APIs
- Raw card data entry
- Payment refunds, voids, and reversals
- Mixed tender (split between cash/card/account on a single sale)
- Manager PIN overrides and multi-user roles
- Cloud synchronization and Supabase integration
- Barcode label printing for customer cards
