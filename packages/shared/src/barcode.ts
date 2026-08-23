export const CODE128_START_A = 103;
export const CODE128_START_B = 104;
export const CODE128_START_C = 105;
export const CODE128_STOP = 106;
export const CODE128_CODE_B = 100;
export const CODE128_CODE_C = 99;

/**
 * Code 128 element widths (bar, space, bar, space, bar, space) for values 0–106.
 * Stop (106) uses seven elements / 13 modules including the termination bar.
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112',
];

export interface Code128Encoding {
  /** Full symbol sequence: start, data and latch codes, checksum, stop. */
  codes: number[];
  checksum: number;
  startCode: number;
}

const MIN_CHAR = 32;
const MAX_CHAR = 126;

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function digitRunLength(text: string, from: number): number {
  let count = 0;
  while (from + count < text.length && isDigit(text[from + count]!)) {
    count += 1;
  }
  return count;
}

function unsupportedCharacterMessage(char: string): string {
  const code = char.charCodeAt(0);
  const shown =
    code >= 32 && code <= 126
      ? char
      : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return `Unsupported Code 128 character: ${shown}. Only ASCII characters 32–126 (Code 128 subset B) and digit pairs (subset C) are supported.`;
}

export function assertCode128Encodable(value: string): void {
  if (value.length === 0) {
    throw new Error('Barcode value cannot be empty.');
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < MIN_CHAR || code > MAX_CHAR) {
      throw new Error(unsupportedCharacterMessage(char));
    }
  }
}

export function isCode128Encodable(value: string): boolean {
  try {
    assertCode128Encodable(value);
    return true;
  } catch {
    return false;
  }
}

function shouldStartC(text: string): boolean {
  const run = digitRunLength(text, 0);
  if (run < 2) return false;
  if (run === text.length) return true;
  if (run % 2 === 1) return false;
  return run >= 4;
}

function shouldSwitchToC(text: string, index: number): boolean {
  const run = digitRunLength(text, index);
  return run >= 4 && run % 2 === 0;
}

/**
 * Encode `value` as Code 128 using subsets B and C.
 * Starts in C for digit-only strings (length ≥ 2) or even leading digit runs of 4+.
 * Switches to C only for even digit runs of 4 or more (short 2-digit runs stay in B).
 */
export function encodeCode128(value: string): Code128Encoding {
  assertCode128Encodable(value);

  const body: number[] = [];
  let index = 0;
  let subset: 'B' | 'C' = shouldStartC(value) ? 'C' : 'B';
  const startCode = subset === 'C' ? CODE128_START_C : CODE128_START_B;
  body.push(startCode);

  while (index < value.length) {
    if (subset === 'B') {
      if (shouldSwitchToC(value, index)) {
        body.push(CODE128_CODE_C);
        subset = 'C';
        continue;
      }
      body.push(value.charCodeAt(index) - 32);
      index += 1;
    } else if (
      index + 1 < value.length &&
      isDigit(value[index]!) &&
      isDigit(value[index + 1]!)
    ) {
      body.push(Number.parseInt(value.slice(index, index + 2), 10));
      index += 2;
    } else {
      body.push(CODE128_CODE_B);
      subset = 'B';
    }
  }

  const checksum =
    body.reduce(
      (sum, code, position) => sum + code * (position === 0 ? 1 : position),
      0,
    ) % 103;

  return {
    codes: [...body, checksum, CODE128_STOP],
    checksum,
    startCode,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const DEFAULT_MODULE = 1;
const DEFAULT_HEIGHT = 40;
const DEFAULT_QUIET = 10;

/**
 * Deterministic Code 128 SVG (bars only). Human-readable digits belong in the label HTML.
 */
export function renderCode128Svg(value: string): string {
  const { codes } = encodeCode128(value);
  let x = DEFAULT_QUIET;
  const rects: string[] = [];
  for (const code of codes) {
    const pattern = CODE128_PATTERNS[code];
    if (!pattern) {
      throw new Error(`Invalid Code 128 symbol value: ${code}`);
    }
    let isBar = true;
    for (const widthChar of pattern) {
      const width = Number(widthChar) * DEFAULT_MODULE;
      if (isBar) {
        rects.push(
          `<rect x="${x}" y="0" width="${width}" height="${DEFAULT_HEIGHT}"/>`,
        );
      }
      x += width;
      isBar = !isBar;
    }
  }
  const width = x + DEFAULT_QUIET;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(value)}" viewBox="0 0 ${width} ${DEFAULT_HEIGHT}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="#000">${rects.join('')}</svg>`;
}
