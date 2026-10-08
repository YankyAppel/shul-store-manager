import { describe, expect, it } from 'vitest';
import {
  convertWeight,
  createScaleReader,
  parseWeightLine,
} from '../src/index.js';

describe('parseWeightLine', () => {
  it('parses a stable weight line', () => {
    expect(parseWeightLine('ST,GS,+ 2.350 lb', 'lb')).toEqual({
      weight: 2.35,
      stable: true,
    });
  });

  it('parses a plain numeric line', () => {
    expect(parseWeightLine('  1.245', 'lb')).toEqual({
      weight: 1.245,
      stable: true,
    });
  });

  it('marks unstable readings', () => {
    const reading = parseWeightLine('US 1.500 lb', 'lb');
    expect(reading).not.toBeNull();
    expect(reading!.weight).toBe(1.5);
    expect(reading!.stable).toBe(false);
  });

  it('returns null for out-of-range errors', () => {
    expect(parseWeightLine('OL', 'lb')).toBeNull();
    expect(parseWeightLine('ERR', 'lb')).toBeNull();
    expect(parseWeightLine('', 'lb')).toBeNull();
  });

  it('converts the unit written on the line', () => {
    const reading = parseWeightLine('ST 32.0 oz', 'lb');
    expect(reading).not.toBeNull();
    expect(reading!.weight).toBeCloseTo(2.0, 3);
    const kg = parseWeightLine('ST 1.000 kg', 'lb');
    expect(kg!.weight).toBeCloseTo(2.205, 3);
  });

  it('handles negative and comma-decimal readings', () => {
    expect(parseWeightLine('-0.500', 'lb')!.weight).toBe(0.5);
    expect(parseWeightLine('1,250', 'lb')!.weight).toBe(1.25);
  });
});

describe('convertWeight', () => {
  it('converts between units', () => {
    expect(convertWeight(1, 'lb', 'oz')).toBe(16);
    expect(convertWeight(1, 'kg', 'lb')).toBeCloseTo(2.205, 3);
    expect(convertWeight(500, 'oz', 'lb')).toBeCloseTo(31.25, 3);
    expect(convertWeight(2.5, 'lb', 'lb')).toBe(2.5);
  });
});

describe('createScaleReader', () => {
  it('returns a null reader for mode none', async () => {
    const reader = createScaleReader({
      mode: 'none',
      port: null,
      unit: 'lb',
      onWeight: () => {},
      onStatus: () => {},
    });
    expect(reader.status().connected).toBe(false);
    await reader.start();
    expect(reader.status().connected).toBe(false);
    await reader.stop();
  });
});
