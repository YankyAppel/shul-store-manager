import { describe, expect, it } from 'vitest';
import {
  describeAttentionReason,
  extractAttentionDetail,
  formatKioskAddress,
  formatRelativeTime,
  validatePort,
} from '../src/index.js';

describe('manager UI helpers', () => {
  it('describes machine attention reasons without exposing stored details', () => {
    expect(
      describeAttentionReason('finalization-failed: database detail'),
    ).toBe('The charge was approved but the sale could not be completed.');
    expect(describeAttentionReason('voided: operator note')).toBe(
      'The charge was voided by the manager.',
    );
    expect(describeAttentionReason('unknown-reason: detail')).toBe(
      'This charge needs manager attention.',
    );
    expect(extractAttentionDetail('finalization-failed: database detail')).toBe(
      'database detail',
    );
    expect(extractAttentionDetail('finalization-failed:')).toBeNull();
    expect(extractAttentionDetail('finalization-failed')).toBeNull();
  });

  it('formats relative times and kiosk addresses', () => {
    const now = Date.parse('2025-01-01T12:00:00.000Z');
    expect(formatRelativeTime('2025-01-01T11:57:00.000Z', now)).toBe(
      '3 minutes ago',
    );
    expect(formatRelativeTime('2025-01-01T11:00:00.000Z', now)).toBe(
      '1 hour ago',
    );
    expect(formatRelativeTime('not-a-time', now)).toBe('unknown time');
    expect(formatKioskAddress('192.168.1.20', 3939)).toBe('192.168.1.20:3939');
  });

  it('validates kiosk server ports', () => {
    expect(validatePort('3939')).toBeNull();
    expect(validatePort('0')).toBe('Port must be between 1 and 65535.');
    expect(validatePort('65536')).toBe('Port must be between 1 and 65535.');
    expect(validatePort('39.39')).toBe('Port must be an integer.');
  });
});
