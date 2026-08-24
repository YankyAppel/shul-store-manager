# Payment Processor Integration

This document outlines the architecture, adapter framework, and strict constraints for the `"Pay now"` integrated card processing tender in Shul Store Manager.

## Adapter Contract

All integrated payment processors must implement the `PaymentProcessor` interface (defined in `@shul-store/payments`).

- **Idempotency Key:** Every `createCharge` call receives a strict UUID `idempotencyKey`. The adapter MUST pass this to the downstream provider to ensure network retries never double-charge.
- **No-PAN Rule:** Raw card data (Primary Account Number (PAN), CVV, expiration date) MUST NEVER pass through `shul-store-manager` code. The system does not have the compliance posture to handle or store this data. Processors must rely on terminal-based tokenization, hosted iframes, or dedicated hardware.
- **Storage Injection:** Long-lived state (e.g., token polling, terminal connection status) MUST be persisted using the injected `ProcessorStorage` interface. Because desktop apps can be killed or crash at any moment, relying on memory for active charge state will result in lost records and hanging charges.
- **Exception Mapping:** Any exception originating from `createCharge` must be caught by the IPC layer and mapped to an `unknown` state. Do not invent an `error` or `declined` state if the outcome is truly ambiguous.

## Status Lifecycle & Legal Transitions

The `payment_transactions` database table strictly enforces state transitions to ensure safe lifecycle management:

```text
[Cart Snapshot] --> Store: createPaymentTransaction
                    Status = 'initiated'

 IPC Main       --> Adapter: createCharge()
```

Legal SQLite Trigger Transitions:

- `initiated` ➔ `approved` | `declined` | `error` | `unknown`
- `unknown` ➔ `approved` | `declined` | `error` | `needs-attention`
- `approved` ➔ `reconciled` | `needs-attention`

_Note: Any deviation from these transitions throws a SQLite `ABORT`._

## Reconciliation Behavior

At startup (and when the user clicks 'Retry' on a pending charge alert), `runStartupReconciliation()` queries for any transaction stuck in `initiated` or `unknown`.

- The system calls the adapter's `getChargeStatus` using the durable storage.
- If the status resolves to `approved`, the system parses the JSON `cart_snapshot_json`.
- A missing or corrupt snapshot forces the status to `needs-attention` (to avoid inventing financial line items).
- A valid snapshot is passed to `completeSale`, creating historical line items locked exactly to the prices at the time of the attempt, bypassing any subsequent catalog price changes.

## Simulated Amount Conventions

The deterministic `simulated` processor allows testing state transitions by passing specific trailing cent amounts:

- `XX.01` ➔ `declined` (Insufficient funds, blocked card)
- `XX.02` ➔ `error` (Network failure, invalid configuration)
- `XX.03` ➔ `unknown` (Simulates a crash-mid-charge: throws during create, but resolves to `approved` on subsequent status checks)
- Any other amount ➔ `approved`

## PCI Guidance for Future Adapters

Any future real integration (e.g., Stripe, Square, PayPal) MUST use out-of-scope methods:

1. **Terminal APIs:** Communicating with a physical card reader over a local network or cloud API.
2. **Hosted Checkout:** Redirecting to a browser window or secure web view controlled by the processor.

Direct API entry of PANs via our React application is absolutely forbidden.

## Manual Desktop Checklist

When making structural changes to the payments flow, physically test the build:

1. **Standard Approval:** Ring up a sale. Click "Pay Now". Verify receipt prints and inventory deducts.
2. **Double-Submit Prevention:** Rapidly double-click "Pay Now" or spam Enter. The UI `isChargingRef` and DB idempotency checks must prevent a second modal or charge attempt.
3. **The Kill-Mid-Charge Drill:**
   - Ring up a cart totaling exactly `$0.03`.
   - Click "Pay Now". The simulated processor will sleep for 2 seconds.
   - Force quit or kill the application during this sleep window.
   - Restart the app.
   - The UI should surface a "Pending Transactions" alert.
   - Within 10 seconds, background reconciliation should fire, clear the alert, and generate the approved receipt in Sales History.
4. **Decline Handling:** Ring up `$0.01`. Verify the UI reflects a decline and the cart remains intact for another payment method.
