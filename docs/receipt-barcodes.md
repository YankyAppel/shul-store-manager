# Receipt barcodes

Every customer-facing receipt includes a Code 128 barcode and the same value
printed underneath it for manual entry.

## Receipt namespaces

Receipt numbers use distinct prefixes so records with the same number cannot be
confused:

- Sales: `SSM-S-000045`
- Refunds: `SSM-R-000045`
- Account payments: `SSM-P-000045`

Numbers are padded to six digits when they are shorter than six digits. Larger
receipt numbers are printed in full.

## Scanning in Manager

Open **Sales history** and scan the receipt into the **Scan receipt** field.
The scanner submits the value when it sends Enter.

- A sale selects the sale and opens its details.
- A refund selects the original sale, opens its details, and identifies the
  refund receipt.
- An account-payment receipt identifies the payment and offers a button to open
  the associated customer.
- An unknown or unparseable value shows a `No receipt found for …` message.

If a barcode is damaged, type the human-readable value printed below it. Bare
numbers are treated as sale receipt numbers; the prefixed forms can be typed
with or without leading zero padding and are case-insensitive.
