import { z } from 'zod';
import { isCode128Encodable, renderCode128Svg } from './barcode.js';
import { formatMoneyCents } from './checkout.js';
import { escapeHtml } from './html-templates.js';

export interface LabelBarcodeChoice {
  kind: 'EXTERNAL' | 'CODE128_INTERNAL';
  value: string;
}

export const labelTemplateIdSchema = z.enum([
  'thermal_40x30',
  'thermal_57x32',
  'letter_avery_5160',
]);
export type LabelTemplateId = z.infer<typeof labelTemplateIdSchema>;

export const LABEL_TEMPLATE_OPTIONS: ReadonlyArray<{
  id: LabelTemplateId;
  label: string;
  kind: 'thermal' | 'sheet';
}> = [
  {
    id: 'thermal_40x30',
    label: 'Thermal roll 40 × 30 mm',
    kind: 'thermal',
  },
  {
    id: 'thermal_57x32',
    label: 'Thermal roll 57 × 32 mm',
    kind: 'thermal',
  },
  {
    id: 'letter_avery_5160',
    label: 'Letter sheet — Avery 5160 (30 up)',
    kind: 'sheet',
  },
];

export const labelPrintItemSchema = z.object({
  productId: z.string().uuid(),
  barcode: z.string().trim().min(1).max(100).refine(isCode128Encodable, {
    message: 'Barcode contains characters that cannot be encoded as Code 128.',
  }),
  quantity: z.number().int().min(1).max(500),
});
export type LabelPrintItem = z.infer<typeof labelPrintItemSchema>;

export const labelPrintRequestSchema = z
  .object({
    items: z.array(labelPrintItemSchema).min(1).max(500),
    template: labelTemplateIdSchema,
  })
  .superRefine((value, context) => {
    const total = value.items.reduce((sum, item) => sum + item.quantity, 0);
    if (total > 2000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A print job cannot exceed 2000 labels.',
        path: ['items'],
      });
    }
  });
export type LabelPrintRequest = z.infer<typeof labelPrintRequestSchema>;

export interface LabelInstance {
  name: string;
  secondaryName: string | null;
  sellingPriceCents: number;
  barcode: string;
  storeName: string;
}

export interface LabelsHtmlInput {
  items: Array<{
    name: string;
    secondaryName?: string | null;
    sellingPriceCents: number;
    barcode: string;
    quantity: number;
  }>;
  storeName: string;
  template: LabelTemplateId;
}

export const SHEET_COLUMNS = 3;
export const SHEET_ROWS = 10;
export const SHEET_LABELS_PER_PAGE = SHEET_COLUMNS * SHEET_ROWS;

/** Avery 5160-compatible physical layout. */
export const AVERY_5160 = {
  pageWidthIn: 8.5,
  pageHeightIn: 11,
  labelWidthIn: 2.625,
  labelHeightIn: 1,
  leftMarginIn: 0.1875,
  topMarginIn: 0.5,
  horizontalPitchIn: 2.75,
  verticalPitchIn: 1,
} as const;

export function selectPreferredBarcode<T extends LabelBarcodeChoice>(
  barcodes: T[],
): T | null {
  if (barcodes.length === 0) return null;
  return (
    barcodes.find((barcode) => barcode.kind === 'CODE128_INTERNAL') ??
    barcodes[0] ??
    null
  );
}

export function expandLabelCopies(
  items: LabelsHtmlInput['items'],
): Array<Omit<(typeof items)[number], 'quantity'>> {
  const expanded: Array<Omit<(typeof items)[number], 'quantity'>> = [];
  for (const item of items) {
    const quantity = item.quantity;
    for (let copy = 0; copy < quantity; copy += 1) {
      expanded.push({
        name: item.name,
        secondaryName: item.secondaryName ?? null,
        sellingPriceCents: item.sellingPriceCents,
        barcode: item.barcode,
      });
    }
  }
  return expanded;
}

function labelInnerHtml(instance: LabelInstance): string {
  const priceText = formatMoneyCents(instance.sellingPriceCents);
  const secondary = instance.secondaryName
    ? `<div class="secondary">${escapeHtml(instance.secondaryName)}</div>`
    : '';
  return `<div class="label-inner">
    <div class="store">${escapeHtml(instance.storeName)}</div>
    <div class="name">${escapeHtml(instance.name)}</div>
    ${secondary}
    <div class="price">${escapeHtml(priceText)}</div>
    <div class="bars">${renderCode128Svg(instance.barcode)}</div>
    <div class="digits">${escapeHtml(instance.barcode)}</div>
  </div>`;
}

function thermalCss(widthMm: number, heightMm: number): string {
  return `
    @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
    html, body { margin: 0; padding: 0; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; color: #111; }
    .label {
      width: ${widthMm}mm;
      height: ${heightMm}mm;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
    }
    .label:last-child { page-break-after: auto; break-after: auto; }
    .label-inner {
      width: ${widthMm}mm;
      height: ${heightMm}mm;
      padding: 1.2mm 1.4mm 0.8mm;
      display: flex;
      flex-direction: column;
      align-items: stretch;
    }
    .store { font-size: ${widthMm <= 40 ? '5.5pt' : '6.5pt'}; color: #333; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name { font-size: ${widthMm <= 40 ? '8pt' : '9.5pt'}; font-weight: 700; line-height: 1.15; max-height: 2.4em; overflow: hidden; }
    .secondary { font-size: ${widthMm <= 40 ? '6pt' : '7pt'}; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .price { font-size: ${widthMm <= 40 ? '10pt' : '12pt'}; font-weight: 700; margin: 0.3mm 0; }
    .bars { flex: 1; min-height: 8mm; display: flex; align-items: stretch; }
    .bars svg { width: 100%; height: 100%; }
    .digits { font-size: ${widthMm <= 40 ? '6pt' : '7pt'}; letter-spacing: 0.06em; text-align: center; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  `;
}

function sheetCss(): string {
  const a = AVERY_5160;
  return `
    @page { size: ${a.pageWidthIn}in ${a.pageHeightIn}in; margin: 0; }
    html, body { margin: 0; padding: 0; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; color: #111; }
    .sheet {
      width: ${a.pageWidthIn}in;
      height: ${a.pageHeightIn}in;
      position: relative;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
    }
    .sheet:last-child { page-break-after: auto; break-after: auto; }
    .label {
      position: absolute;
      width: ${a.labelWidthIn}in;
      height: ${a.labelHeightIn}in;
      overflow: hidden;
    }
    .label-inner {
      width: 100%;
      height: 100%;
      padding: 0.06in 0.08in 0.04in;
      display: flex;
      flex-direction: column;
    }
    .store { font-size: 7pt; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name { font-size: 9pt; font-weight: 700; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .secondary { font-size: 7.5pt; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .price { font-size: 10pt; font-weight: 700; }
    .bars { flex: 1; min-height: 0.32in; display: flex; align-items: stretch; }
    .bars svg { width: 100%; height: 100%; }
    .digits { font-size: 7pt; letter-spacing: 0.05em; text-align: center; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  `;
}

function thermalDocument(
  copies: Array<Omit<LabelsHtmlInput['items'][number], 'quantity'>>,
  storeName: string,
  widthMm: number,
  heightMm: number,
  template: LabelTemplateId,
): string {
  const labels = copies
    .map((item, index) => {
      const inner = labelInnerHtml({
        name: item.name,
        secondaryName: item.secondaryName ?? null,
        sellingPriceCents: item.sellingPriceCents,
        barcode: item.barcode,
        storeName,
      });
      return `<div class="label" data-index="${index}" data-barcode="${escapeHtml(item.barcode)}">${inner}</div>`;
    })
    .join('');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Product labels</title>
  <style>${thermalCss(widthMm, heightMm)}</style>
</head>
<body data-template="${template}" data-label-count="${copies.length}">
  ${labels}
</body>
</html>`;
}

function sheetDocument(
  copies: Array<Omit<LabelsHtmlInput['items'][number], 'quantity'>>,
  storeName: string,
): string {
  const a = AVERY_5160;
  const pages: string[] = [];
  for (
    let offset = 0, page = 1;
    offset < copies.length;
    offset += SHEET_LABELS_PER_PAGE, page += 1
  ) {
    const slice = copies.slice(offset, offset + SHEET_LABELS_PER_PAGE);
    const cells = slice
      .map((item, index) => {
        const position = index;
        const row = Math.floor(position / SHEET_COLUMNS);
        const column = position % SHEET_COLUMNS;
        const left = a.leftMarginIn + column * a.horizontalPitchIn;
        const top = a.topMarginIn + row * a.verticalPitchIn;
        const inner = labelInnerHtml({
          name: item.name,
          secondaryName: item.secondaryName ?? null,
          sellingPriceCents: item.sellingPriceCents,
          barcode: item.barcode,
          storeName,
        });
        return `<div class="label" data-index="${offset + index}" data-barcode="${escapeHtml(item.barcode)}" style="left:${left}in;top:${top}in">${inner}</div>`;
      })
      .join('');
    pages.push(
      `<div class="sheet" data-page="${page}" data-cell-count="${slice.length}">${cells}</div>`,
    );
  }
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Product labels</title>
  <style>${sheetCss()}</style>
</head>
<body data-template="letter_avery_5160" data-label-count="${copies.length}" data-page-count="${pages.length}">
  ${pages.join('')}
</body>
</html>`;
}

export function labelsHtml(input: LabelsHtmlInput): string {
  if (input.items.length === 0) {
    throw new Error('At least one label item is required.');
  }
  const copies = expandLabelCopies(input.items);
  if (copies.length === 0) {
    throw new Error('At least one label copy is required.');
  }
  for (const copy of copies) {
    if (!isCode128Encodable(copy.barcode)) {
      throw new Error(`Barcode cannot be encoded as Code 128: ${copy.barcode}`);
    }
  }
  if (input.template === 'thermal_40x30') {
    return thermalDocument(copies, input.storeName, 40, 30, input.template);
  }
  if (input.template === 'thermal_57x32') {
    return thermalDocument(copies, input.storeName, 57, 32, input.template);
  }
  return sheetDocument(copies, input.storeName);
}
