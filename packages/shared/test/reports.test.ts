import { describe, expect, it } from 'vitest';
import { businessDayRange } from '../src/reports.js';

describe('businessDayRange', () => {
  it('returns local-midnight UTC boundaries for a normal day', () => {
    const range = businessDayRange('2025-01-15');
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it('rejects malformed and impossible calendar dates', () => {
    expect(() => businessDayRange('2025-1-15')).toThrow(/YYYY-MM-DD/);
    expect(() => businessDayRange('2025-02-30')).toThrow(/valid calendar/);
  });

  it('follows the DST-shortened day in America/New_York', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const range = businessDayRange('2025-03-09');
      expect(Date.parse(range.to) - Date.parse(range.from)).toBe(
        23 * 60 * 60 * 1000,
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
