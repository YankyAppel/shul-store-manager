# Payments

## Adapter Interface Contract

The `PaymentProcessor` interface provides a processor-agnostic boundary.

- **Idempotency**: Future adapters must treat the `chargeReference` (a UUID) as an idempotency key.
- **No-PAN**: The application must never store, process, or transmit raw PANs or CVV. The `PaymentProcessor` interface does not include fields for raw card numbers. Adapters for real processors must use the processor's hosted fields, terminal SDK, or tokenization pages to keep this codebase fully out of PCI scope.

## Charge Lifecycle

1. **Initiate**: App saves `payment_transactions` row with status `initiated`.
2. **Charge**: App invokes processor's `createCharge`.
3. **Persist**: App updates `payment_transactions` with the outcome (`approved`, `declined`, `error`, `unknown`).
4. **Complete Sale**: On `approved`, app links the sale ID to the transaction and marks the sale complete in one transaction.

## Reconciliation Behavior

If the app crashes or network fails between the charge and sale completion, the transaction remains in `initiated` or `unknown`.
On next startup or manual resolution, the app lists pending transactions.
Invoking "Resolve" calls the processor's `getChargeStatus`.

- If `approved`, it completes the sale using the persisted `cartSnapshotJson` and `idempotencyKey`.
- If `declined`/`error`, it updates the state, allowing a fresh attempt.

## Simulated Processor Conventions

A built-in simulated processor is provided for testing:

- Amount ending in `.01` -> Declines
- Amount ending in `.02` -> Errors
- Amount ending in `.03` -> Stays `pending` until status check, then approves.
- All other amounts -> Approves after a short delay.

## PCI-Scope Guidance

Because no raw card data ever touches the local memory, network, or SQLite database, the main application remains out of PCI scope. Future adapters must strictly maintain this isolation.

## Manual Desktop Test Checklist

1. Approve flow: Enter an amount like $5.00, hit Pay now. Verify approval, receipt content, and database.
2. Decline flow: Enter $5.01, hit Pay now. Verify decline message and ability to try another tender.
3. Pending->Status check: Enter $5.03, hit Pay now. Verify it enters pending state. Click 'Check status' to resolve to approved.
4. Kill mid-charge: Kill the app right after approval but before completeSale. On restart, verify the transaction is reconciled and completes the EXACT original sale without double charging.
5. Double-click storm: Spam the "Pay now" button. Verify it locks the UI and creates at most one charge reference.
6. Receipt content: Verify processor transaction id and card brand/last4 show up on receipts.
