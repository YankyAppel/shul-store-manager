import { describe, expect, it } from 'vitest';
import {
  CODE128_CODE_B,
  CODE128_CODE_C,
  CODE128_PATTERNS,
  CODE128_START_B,
  CODE128_START_C,
  CODE128_STOP,
  encodeCode128,
  renderCode128Svg,
} from '@shul-store/shared';

function modulo103(codesWithoutChecksumAndStop: number[]): number {
  return (
    codesWithoutChecksumAndStop.reduce(
      (sum, code, position) => sum + code * (position === 0 ? 1 : position),
      0,
    ) % 103
  );
}

function expectEncoding(
  value: string,
  startAndData: number[],
  expectedChecksum: number,
): void {
  const encoded = encodeCode128(value);
  expect(encoded.startCode).toBe(startAndData[0]);
  expect(encoded.checksum).toBe(expectedChecksum);
  expect(modulo103(startAndData)).toBe(expectedChecksum);
  expect(encoded.codes).toEqual([
    ...startAndData,
    expectedChecksum,
    CODE128_STOP,
  ]);
  expect(encoded.codes[0]).toBe(encoded.startCode);
  expect(encoded.codes.at(-1)).toBe(CODE128_STOP);
  expect(encoded.codes.at(-2)).toBe(expectedChecksum);
}

describe('Code 128 encoding', () => {
  it('encodes a subset B known-answer vector for "A"', () => {
    // Start B (104) + 'A' (33); checksum (104 + 33) % 103 = 34
    expectEncoding('A', [CODE128_START_B, 33], 34);
  });

  it('encodes a subset B known-answer vector for "Code 128"', () => {
    // C=35 o=79 d=68 e=69 space=0 1=17 2=18 8=24; checksum 64
    expectEncoding(
      'Code 128',
      [CODE128_START_B, 35, 79, 68, 69, 0, 17, 18, 24],
      64,
    );
  });

  it('encodes a subset C known-answer vector for "00"', () => {
    // Start C (105) + 00 (0); checksum (105 + 0) % 103 = 2
    expectEncoding('00', [CODE128_START_C, 0], 2);
  });

  it('encodes a subset C known-answer vector for "123456"', () => {
    // 12, 34, 56; checksum (105 + 12 + 68 + 168) % 103 = 44
    expectEncoding('123456', [CODE128_START_C, 12, 34, 56], 44);
  });

  it('switches B → C for a 4-digit run in "ABC1234"', () => {
    // A=33 B=34 C=35, Code C, 12, 34; checksum 43
    expectEncoding(
      'ABC1234',
      [CODE128_START_B, 33, 34, 35, CODE128_CODE_C, 12, 34],
      43,
    );
  });

  it('starts in C then latches to B for "1234AB"', () => {
    expectEncoding(
      '1234AB',
      [CODE128_START_C, 12, 34, CODE128_CODE_B, 33, 34],
      66,
    );
  });

  it('renders an odd-length digit string (EAN-13) as Code 128 with C pairs and a final B digit', () => {
    // 5901234123457: Start C, six pairs, Code B, '7'
    expectEncoding(
      '5901234123457',
      [CODE128_START_C, 59, 1, 23, 41, 23, 45, CODE128_CODE_B, 23],
      20,
    );
  });

  it('encodes an internal SSM barcode entirely in subset B', () => {
    expectEncoding(
      'SSM-ABC',
      [CODE128_START_B, 51, 51, 45, 13, 33, 34, 35],
      28,
    );
  });

  it('does not switch to C for a short two-digit run inside letters', () => {
    const encoded = encodeCode128('AB12CD');
    expect(encoded.startCode).toBe(CODE128_START_B);
    expect(encoded.codes).not.toContain(CODE128_CODE_C);
    expect(encoded.codes.slice(1, -2)).toEqual([33, 34, 17, 18, 35, 36]);
  });

  it('rejects empty input', () => {
    expect(() => encodeCode128('')).toThrow(/empty/i);
    expect(() => renderCode128Svg('')).toThrow(/empty/i);
  });

  it('rejects unsupported characters', () => {
    expect(() => encodeCode128('\t')).toThrow(/Unsupported Code 128 character/);
    expect(() => encodeCode128('café')).toThrow(
      /Unsupported Code 128 character/,
    );
    expect(() => encodeCode128('😀')).toThrow(/Unsupported Code 128 character/);
  });

  it('produces deterministic SVG without a DOM and includes a stop pattern', () => {
    const first = renderCode128Svg('SSM-TEST-01');
    const second = renderCode128Svg('SSM-TEST-01');
    expect(first).toBe(second);
    expect(first.startsWith('<svg ')).toBe(true);
    expect(first).toContain('<rect ');
    expect(first).toContain('aria-label="SSM-TEST-01"');
    expect(first).not.toContain('<script');
    const stop = CODE128_PATTERNS[CODE128_STOP];
    expect(stop).toBe('2331112');
  });

  it('escapes hostile barcode text in the SVG aria-label', () => {
    const svg = renderCode128Svg('<&>"\'');
    expect(svg).toContain('aria-label="&lt;&amp;&gt;&quot;&#39;"');
    expect(svg).not.toContain('aria-label="<|>');
  });
});
