# Payment Processor Integration

## Adapter Contract

Adapters must implement the `PaymentProcessor` interface.

- **Idempotency:** Implementations MUST use `idempotencyKey` to deduplicate charges safely.
- **No-PAN:** Raw card data (PAN/CVV/expiry) MUST NEVER touch the store-manager memory or logs.
- **Storage Injection:** Long-lived state (e.g. pending charge tokens) MUST be written to the injected `ProcessorStorage` so it survives application crashes and restarts.

## Lifecycle Diagram

```text
[Cart] --> (initiate charge) --> [payment_transactions: 'initiated']
         --> (call processor)
             |--> Success: update 'approved', complete sale, link sale_id
             |--> Declined: update 'declined'
             |--> Network/Crash: 'unknown'
```

Legal transitions:

- `initiated` -> `approved` | `declined` | `error` | `unknown`
- `unknown` -> `approved` | `declined` | `error`

## Reconciliation Behavior

On startup, the system queries pending payment transactions (`initiated` or `unknown`). It calls the adapter's `getChargeStatus`. If `approved`, it synthesizes a historical sale from the snapshotted cart data. If `declined`/`error`, it just marks the transaction.

## Simulated Conventions

For testing, the Simulated Processor acts on the `amountCents`:

- `$XX.01` -> `declined`
- `$XX.02` -> `error`
- `$XX.03` -> `unknown` (resolves to `approved` on subsequent status checks)
- Any other amount -> `approved`

## PCI Guidance for Future Adapters

Any future real integration (e.g. Stripe, Square) must use out-of-scope methods like Hosted Checkout pages, Terminal APIs, or iFrames. Direct API entry of PANs is forbidden by architecture.

## Manual Testing Checklist

1. Ring up a sale.
2. Click Pay Now.
3. Verify receipt prints and inventory deducts.
4. Ring up $0.03 sale.
5. Force kill the app while it processes.
6. Restart app. Verify the transaction reconciles to a completed sale on startup.
