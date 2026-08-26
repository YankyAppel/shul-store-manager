# Returns and refunds

Refunds are recorded as separate, immutable records linked to the original
sale. A return can be partial, so one sale may have several refunds. Sales
remain gross in reports; refunds are not silently netted into the original
sale or its line items.

For each returned line, the manager enters the quantity and chooses whether
the goods go **back to stock** or are **not resalable**. Only resalable
returns create a positive inventory movement. The refund amount uses the
original frozen selling price and tax, with the final partial return receiving
any remaining tax-cent remainder.

The refund method is derived from the original sale:

- Cash refunds leave the cash drawer.
- External-terminal refunds are performed on the physical terminal and
  require the terminal reference to be recorded.
- Integrated-card refunds are attempted against the original processor charge
  before the refund record is written. If the processor declines, errors, or
  cannot recover its frozen configuration, nothing is recorded; the manager
  can refund on the physical terminal and record that separate fallback.
- Account refunds credit the original customer's account and create a
  negative customer-ledger entry. They do not move cash.

Every refund has a caller-supplied operation ID. Replaying that ID returns the
existing refund without duplicating rows, inventory movements, ledger entries,
or sync events. Refunds and refund items are append-only and receive their own
receipt references.

Refund rows and their account-ledger entries are included in cloud sync and
restore. Restore validates all sale, sale-item, product, and customer
references and rolls back if any required reference is dangling.
