# Checkout foundation

## Sale lifecycle and idempotency

Allowed status transitions are enforced by a SQLite trigger:

- `open → awaiting_payment → paid → completed` (for immediate cash and external-terminal payments)
- `open → awaiting_payment → completed` (for account charges)
- `open` or `awaiting_payment → voided` (reserved for safely abandoning an unfinished sale)
- `completed → refunded` (schema support only; refund behavior is not implemented)

Completion runs as one `BEGIN IMMEDIATE` transaction. It validates active products and available stock, calculates totals, inserts immutable item snapshots, inserts either an immediate payment or customer ledger charge, creates negative append-only inventory movements referencing the sale, advances status, and writes an audit event. A renderer-generated UUID completion key has a unique constraint. A retry returns the existing sale, so it cannot duplicate payment, ledger, or inventory writes.

The current insufficient-stock policy is **block completion**. The UI shows available quantities; the database is authoritative and validates again inside the write transaction.

## Tax and rounding

The tax rate is stored as integer basis points (`875` means 8.75%). Calculations use `bigint` integer multiplication and rational division, then convert final cent values to numbers only after verifying they are within JavaScript's safe-integer range. Unsafe line, cart, cash, and change values are rejected rather than rounded imprecisely. Each sale line's tax is rounded to the nearest cent; an exact half-cent rounds upward.

For tax-exclusive prices:

```text
tax = round(line displayed amount × rate / 10,000)
total = displayed amount + tax
```

For tax-inclusive prices:

```text
included tax = round(line displayed amount × rate / (10,000 + rate))
subtotal = displayed amount − included tax
total = displayed amount
```

Snapshots retain each line's subtotal, tax, and total, so settings or product changes cannot rewrite history.

## Payments & Account Charging

1. **Cash**: Records amount due, cash received, and change. Underpayment is rejected.
2. **External Card Terminal**: Requires the staff member to affirm approval and optionally stores a terminal reference. It never accepts or stores card number, expiration, security code, PIN, or track data.
3. **Put on Account**: Validates active customer status, account blocking, store account settings, and credit limits, and records a positive `sale_charge` in the append-only `customer_ledger`. See [Customer accounts & Receivables](receivables.md).

## Printing

Sale completion and printing are separate. Electron creates a constrained hidden receipt document and invokes the operating-system print UI. Every attempt is recorded independently. A cancellation or printer failure returns an error while the successful sale, payment, and inventory movements remain unchanged. Reprint uses the immutable stored snapshots and cannot create another sale.

## Deferred

Integrated/tokenized payment providers, refunds and returns, cash drawers, specialized thermal commands, label printing, kiosks, cloud synchronization, cash recyclers, and subscription enforcement are not implemented.
