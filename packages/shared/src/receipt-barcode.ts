export type ReceiptBarcodeKind = 'sale' | 'refund' | 'account_payment';

const prefixes: Record<ReceiptBarcodeKind, string> = {
  sale: 'S',
  refund: 'R',
  account_payment: 'P',
};

const prefixKinds: Record<string, ReceiptBarcodeKind> = {
  S: 'sale',
  R: 'refund',
  P: 'account_payment',
};

function parseReceiptNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function receiptBarcodeValue(
  kind: ReceiptBarcodeKind,
  receiptNumber: number,
): string {
  if (!Number.isSafeInteger(receiptNumber) || receiptNumber < 0)
    throw new Error('Receipt number must be a non-negative safe integer.');
  return `SSM-${prefixes[kind]}-${receiptNumber.toString().padStart(6, '0')}`;
}

export function parseReceiptBarcode(
  scanned: string,
): { kind: ReceiptBarcodeKind; receiptNumber: number } | null {
  if (typeof scanned !== 'string') return null;
  const value = scanned.trim().toUpperCase();
  const prefixed = /^SSM-([SRP])-(\d+)$/.exec(value);
  if (prefixed) {
    const receiptNumber = parseReceiptNumber(prefixed[2]!);
    const kind = prefixKinds[prefixed[1]!];
    return receiptNumber === null || !kind ? null : { kind, receiptNumber };
  }
  const receiptNumber = parseReceiptNumber(value);
  return receiptNumber === null ? null : { kind: 'sale', receiptNumber };
}
