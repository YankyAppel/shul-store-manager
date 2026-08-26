# Daily reports and cash reconciliation

The manager's **Reports** screen summarizes a local business day using a
half-open UTC interval made from that day's local midnight boundaries. Sales
and tender totals use `completed_at`; voided sales use `created_at`; account
payments use `created_at`; receivables use `occurred_at`; card transactions
use `created_at`; and inventory movements use `occurred_at`.

Sales totals include completed and refunded sales. Refunded sales are shown
separately and are not netted because a refund is its own immutable financial
record.

Refunds are reported separately by method using the refund's `created_at`
timestamp. Cash refunds reduce the expected cash figure.

Expected cash is derived as:

```text
opening float + cash sales + cash account payments - cash refunds
```

Cash received and change given are shown for reconciliation, but change given
does not increase expected cash. Over/short is counted cash minus expected
cash: a negative result is short and a positive result is over.

A daily close stores the complete report, counted cash, and reconciliation
figures. A close is immutable: the same business date cannot be closed twice.
Daily closes are local-only and are not yet synchronized to the cloud. They
are included in the local SQLite database and therefore covered by local
database backups.
