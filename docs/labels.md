# Barcode labels and printer settings

This milestone adds offline product-label printing and printer preferences. Rendering is Code 128 only. Internal `SSM-…` barcodes and externally scanned values (including valid EAN-13 / UPC-A digit strings) are drawn as Code 128; common scanners read both.

## Templates

| Template id         | Physical size         | Layout                                                 |
| ------------------- | --------------------- | ------------------------------------------------------ |
| `thermal_40x30`     | 40 × 30 mm            | One label per page on a continuous thermal roll        |
| `thermal_57x32`     | 57 × 32 mm            | One label per page on a continuous thermal roll        |
| `letter_avery_5160` | US Letter, Avery 5160 | 30 labels per sheet (3 columns × 10 rows), 2.625″ × 1″ |

Each label shows the store name, product name, optional secondary-language name, selling price, Code 128 bars, and the human-readable barcode value under the bars.

Page CSS uses `@page { size: … }` and physical units (`mm` / `in`) so the print pipeline can honor true label stock size. Mixed batches (several products, each with its own quantity) expand into individual copies. Sheet jobs fill **row by row** and start a new Letter page after every 30 labels.

Avery 5160 geometry used by the generator:

- page 8.5″ × 11″
- label 2.625″ × 1″
- top margin 0.5″, left margin 0.1875″
- horizontal pitch 2.75″, vertical pitch 1″

## Printer configuration

Store settings (migration 5) persist:

- `receiptPrinterName` — nullable; `null` means “system default / show dialog”
- `receiptPaperWidthMm` — `58` or `80`; applied to receipt and account-payment receipt CSS width
- `labelPrinterName` — nullable
- `defaultLabelTemplate` — one of the three template ids

The Settings screen lists printers from Electron `webContents.getPrintersAsync()` (main process, exposed as `settings:listPrinters`).

## Silent printing and fallbacks

When a named receipt or label printer is configured, the hidden print `BrowserWindow` calls `webContents.print({ silent: true, deviceName })`.

If the named device is missing, offline, or silent printing fails, the UI is told why and the **system print dialog** is opened (`silent: false`). The app never crashes on a printer error. Sale, payment, and inventory records are unchanged by print failure (print attempts remain a separate log for receipts).

Preview HTML and printed HTML come from the same `labelsHtml()` / `labels:render` generator.

## Manager workflow

1. **Single product** — Products list or product editor → Print labels → quantity, template, barcode choice, preview, print.
2. **Batch / after receiving stock** — Products → Print labels → select products or “all in category”, set quantity per product (default 1), choose template, preview, print.
3. Multiple barcodes default to the internal `CODE128_INTERNAL` value when one exists, otherwise the first barcode. The operator can pick any of the product’s barcodes.
4. A product with no barcode can generate an internal Code 128 value in the print dialog (same generator as the product editor) and then print.

## Manual desktop test checklist

Run these on a machine with a real printer and a barcode scanner. The sandbox cannot complete them.

1. Create a product with an internal `SSM-…` barcode. Print one **40 × 30 mm** thermal label. Confirm the printed size is approximately 40 × 30 mm, the price matches the catalog, and a scanner returns the exact barcode string.
2. Repeat with a **57 × 32 mm** template.
3. Assign an external EAN-13 or UPC-A (or any scanned vendor barcode). Print it as Code 128 and confirm the scanner still returns that digit string.
4. Print **31** copies on the Avery 5160 template. Confirm two Letter pages, 30 labels on the first sheet, one on the second, and that labels line up with 5160 stock.
5. Batch-print two products with quantities 3 and 1 in one job. Confirm four physical labels.
6. In Settings, leave printers on system default. Print a receipt and a label — the OS dialog should appear.
7. Select a real receipt printer and a real label printer. Print again — jobs should go silently to those devices.
8. Configure a removed or powered-off printer. Print — the UI should explain the failure and open the system dialog. The sale or product must remain unchanged.
9. Switch receipt paper width between 58 mm and 80 mm and reprint a receipt; the printed receipt width should change, content should not.
10. Enter a product name containing `<script>`, quotes, and `&`. Preview and printed HTML must show escaped text, never execute markup.
