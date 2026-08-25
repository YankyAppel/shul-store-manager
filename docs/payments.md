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

- `initiated` ➔ `approved` | `declined` | `error` | `unknown` | `needs-attention`
- `unknown` ➔ `approved` | `declined` | `error` | `needs-attention`
- `approved` ➔ `needs-attention`
- `needs-attention` ➔ `approved` (operator retry only)

_Note: Any deviation from these transitions throws a SQLite `ABORT`. The `reconciled` status remains in the column's `CHECK` vocabulary for historical rows, but no code path writes it._

## Shared Financial Core

There is exactly one payment code path. `PaymentService` (in `@shul-store/database`) is used by both the desktop manager (IPC handlers in `apps/manager/electron/main.ts`) and the LAN kiosk (`KioskServer`). Neither surface implements validation, pricing, reservation, authorization, finalization or reconciliation of its own; `KioskServer` is only a network edge that authenticates, parses requests and maps `PaymentError` codes to HTTP statuses.

The lifecycle for one charge reference is:

1. **`validate`** — deterministic and side-effect free. Checks, in this fixed order: request shape, kiosk identity, card processing enabled, processor exists, processor config parses, product exists, product active, barcode ownership, cart total > 0, stock against held reservations, then charge-reference/idempotency-key conflicts. Nothing is journaled, reserved or sent to the processor until every check passes, so a rejected cart leaves no trace.
2. **`charge`** — persists the journal row, the frozen snapshot digest, the processor/config identity, the origin channel and the aggregated reservation set in a single transaction, then authorizes.
3. **`finalize`** — snapshot-only, exact-once sale creation (see below).
4. **`reconcile`** — per-transaction truth from the processor, then finalization when approved. `reconcileAll` (formerly `runStartupReconciliation`) sweeps every unresolved charge except the ones awaiting an operator.

### Frozen identity

Every charge stores, immutably (enforced by SQLite triggers):

- `cart_snapshot_json` and `snapshot_hash` — the canonical (recursively key-sorted, duplicate-merged) snapshot and its SHA-256 digest.
- `processor_id`, `processor_config_hash` and an encrypted `processor_config_secret` — which processor authorized the charge, the digest of the parsed configuration it was issued under, and the resolved processor configuration needed to reconcile it later. The secret is encrypted at rest through the injected secret-store cipher; when the host OS keychain is unavailable, the documented plaintext fallback is used.
- `origin_channel` — `manager` or `kiosk`.
- `idempotency_key` — with a partial unique index, so one key can only ever own one charge even under a race.

The frozen processor configuration is immutable once written. It is machine-bound when encrypted by Electron `safeStorage`, so it is deliberately never included in cloud sync, restore payloads, renderer responses, LAN responses, or application error/log output. Transactions created before this field was introduced have a null secret and retain the legacy hash comparison policy during reconciliation.

Reservation sets are aggregated per product and ordered by product id, so the same cart always produces the same snapshot digest and the same reservation rows.

### Snapshot-only, exact-once finalization

`finalize(chargeReference)` builds the sale exclusively from `cart_snapshot_json`; live catalog prices are never consulted, so a later price change cannot rewrite an approved charge. It is idempotent: an already linked sale is returned as-is, `completeSale` short-circuits when the same charge reference and completion key are replayed, and repeated calls create exactly one sale.

Before finalizing, the service re-verifies the frozen digest and that the authorized amount equals the snapshot total.

### Needs-attention lifecycle

A charge the processor approved but the system cannot finalize moves to `needs-attention` with a machine-readable `attention_reason`:

| Reason                      | Meaning                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `invalid-snapshot`          | Snapshot missing or no longer passes `cartSnapshotSchema`                        |
| `snapshot-hash-mismatch`    | Snapshot does not match its frozen digest                                        |
| `amount-mismatch`           | Authorized amount differs from the snapshot total                                |
| `processor-changed`         | Store is now configured for a different (or no) processor                        |
| `processor-config-changed`  | Processor configuration changed after authorization                              |
| `frozen-config-unavailable` | The encrypted frozen processor configuration could not be decrypted or validated |
| `finalization-failed`       | Sale could not be created (for example stock was destroyed after approval)       |
| `reconciliation-failed`     | The processor call itself failed                                                 |
| `voided:`                   | An operator closed the charge out                                                |

Held reservations are **not** released automatically, so the stock stays spoken for while the charge is unresolved. The automatic sweep skips these rows; an operator resolves them with `payments.resolveNeedsAttention(reference, 'retry' | 'void')`. `retry` re-runs reconciliation and finalization; `void` releases the held stock and records the charge as abandoned (refunding the authorization at the terminal is a human action).

## Reconciliation Behavior

At startup (and when the user clicks 'Retry' on a pending charge alert), `runStartupReconciliation()` sweeps every transaction stuck in `initiated` or `unknown` through the shared service.

- The system calls the adapter's `getChargeStatus` using the durable storage.
- When a transaction has an encrypted frozen processor configuration, that configuration is decrypted and validated with the transaction's processor schema and is used regardless of current store settings. If the secret cannot be recovered, reconciliation records `frozen-config-unavailable` and retains the held reservation.
- Legacy transactions with no frozen configuration secret compare `processor_config_hash` with the current parsed settings; a mismatch records `processor-config-changed` and does not query the processor.
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
