import { z } from 'zod';

/** EAN-13 "variable measure" barcodes used by label-printing scales and our
 * own weigh-label printing: `02 PPPPP VVVVV C` where PPPPP is a 5-digit item
 * code (the product's PLU) and VVVVV is either the total price in cents
 * ('price' mode) or the measured quantity in thousandths of the product's
 * weight unit ('weight' mode). Scales from CAS/Tor-Rey/Dibal emit the same
 * digits, so decoding here works for labels printed on the scale itself. */

export const weighBarcodeModeSchema = z.enum(['price', 'weight']);
export type WeighBarcodeMode = z.infer<typeof weighBarcodeModeSchema>;

const PREFIX = '02';
const ITEM_DIGITS = 5;
const VALUE_DIGITS = 5;

export function ean13CheckDigit(twelveDigits: string): number {
  let sum = 0;
  for (let i = 0; i < twelveDigits.length; i += 1) {
    const digit = twelveDigits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

const pad = (value: number, width: number) =>
  String(value).padStart(width, '0');

export function encodeWeighBarcode(
  plu: number,
  payload: { priceCents: number } | { milliQty: number },
): string {
  if (!Number.isInteger(plu) || plu < 1 || plu > 99_999)
    throw new Error('PLU must be a 1–5 digit number');
  const value = 'priceCents' in payload ? payload.priceCents : payload.milliQty;
  if (!Number.isInteger(value) || value < 0 || value > 99_999)
    throw new Error('Weigh barcode value out of range');
  const body = PREFIX + pad(plu, ITEM_DIGITS) + pad(value, VALUE_DIGITS);
  return body + ean13CheckDigit(body);
}

export type WeighBarcodeDecoded =
  | { mode: 'price'; plu: number; priceCents: number }
  | { mode: 'weight'; plu: number; milliQty: number };

/** Returns null for anything that is not a well-formed embedded-weigh EAN. */
export function decodeWeighBarcode(
  raw: string,
  mode: WeighBarcodeMode,
): WeighBarcodeDecoded | null {
  const digits = raw.trim();
  if (!/^\d{13}$/.test(digits) || !digits.startsWith(PREFIX)) return null;
  if (ean13CheckDigit(digits.slice(0, 12)) !== Number(digits[12])) return null;
  const plu = Number(digits.slice(2, 7));
  const value = Number(digits.slice(7, 12));
  if (plu < 1) return null;
  return mode === 'price'
    ? { mode, plu, priceCents: value }
    : { mode, plu, milliQty: value };
}

/* EAN-13 rendering — left guard 101, six left digits whose parity pattern is
 * chosen by the leading digit, centre 01010, six right digits in R code, right
 * guard 101. L/G/R patterns are the spec's 7-module encodings. */

const L_PATTERNS = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
const G_PATTERNS = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];
const R_PATTERNS = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];
const FIRST_DIGIT_PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

function ean13Bits(digits: string): string {
  if (!/^\d{13}$/.test(digits)) throw new Error('EAN-13 requires 13 digits');
  if (ean13CheckDigit(digits.slice(0, 12)) !== Number(digits[12]))
    throw new Error('Bad EAN-13 check digit');
  const parity = FIRST_DIGIT_PARITY[Number(digits[0])]!;
  let bits = '101';
  for (let i = 0; i < 6; i += 1) {
    const d = Number(digits[i + 1]);
    bits += parity[i] === 'L' ? L_PATTERNS[d] : G_PATTERNS[d];
  }
  bits += '01010';
  for (let i = 7; i < 13; i += 1) bits += R_PATTERNS[Number(digits[i])];
  return bits + '101';
}

export function isEan13(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  return ean13CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

export function renderEan13Svg(digits: string, height = 42): string {
  const bits = ean13Bits(digits);
  const moduleWidth = 1.6;
  const width = bits.length * moduleWidth + 8;
  const rects: string[] = [];
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === '1') {
      const x = 4 + i * moduleWidth;
      // Guards (first/last 3 and middle 5 bits) extend slightly below.
      const isGuard = i < 3 || (i >= 45 && i < 50) || i >= 92;
      rects.push(
        `<rect x="${x.toFixed(1)}" y="0" width="${moduleWidth}" height="${isGuard ? height : height - 6}"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height}" viewBox="0 0 ${width.toFixed(0)} ${height}">${rects.join('')}</svg>`;
}
