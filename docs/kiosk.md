# Kiosk LAN API

The manager is the pricing and payment authority. Enable **Kiosk server** in Manager Settings, choose a port (default 3939), then choose Pair new kiosk. On the kiosk enter the manager LAN address, port, six-digit code, display name and local admin PIN. Codes are single use, expire in five minutes and pairing is rate limited.

`POST /api/pair` returns a random 32-byte bearer token. The manager stores only its SHA-256 hash. Authenticated endpoints are `GET /api/catalog`, `POST /api/cart/price`, `POST /api/charges`, and `GET /api/charges/:chargeReference`. Requests are strict schemas: cart and charge requests contain only product identifiers/barcodes and quantities—never client prices or totals.

This is intentionally HTTP, not TLS: deploy only on a trusted, isolated LAN. Revoking a kiosk deletes its token hash and immediately denies it. The kiosk persists an in-flight UUID before charging and should poll its charge endpoint after restart rather than retrying a charge. The manager reconciles outstanding processor work every ten minutes while enabled.

## Manual QA

1. Enable server, pair a kiosk, and verify catalog refresh.
2. Scan a product and verify manager-calculated total and completed kiosk sale.
3. Kill kiosk while a charge is pending; relaunch and poll the reference.
4. Kill manager during a charge; restart and wait for reconciliation.
5. Revoke kiosk and verify all subsequent API calls return 401.
