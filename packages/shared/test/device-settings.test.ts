import { describe, expect, it } from 'vitest';
import {
  deviceSettingsSchema,
  isHttpsUpdateFeedUrl,
  processorConfigInputSchema,
} from '@shul-store/shared';

describe('device settings', () => {
  it.each([
    ['http://updates.example.test/feed', false],
    ['file:///tmp/updates', false],
    ['junk', false],
    ['https://updates.example.test/feed', true],
  ])('accepts only HTTPS update feeds: %s', (url, valid) => {
    expect(isHttpsUpdateFeedUrl(url)).toBe(valid);
    expect(
      deviceSettingsSchema.safeParse({
        updateFeedUrl: url,
        automaticUpdatesEnabled: true,
      }).success,
    ).toBe(valid);
  });

  it('accepts a blank update feed and valid processor JSON', () => {
    expect(
      deviceSettingsSchema.parse({
        updateFeedUrl: '',
        automaticUpdatesEnabled: true,
      }),
    ).toEqual({
      updateFeedUrl: null,
      automaticUpdatesEnabled: true,
      idleLockMinutes: 5,
      staffModeEnabled: false,
      explainDismissals: [],
    });
    expect(
      processorConfigInputSchema.safeParse('{"token":"value"}').success,
    ).toBe(true);
    expect(processorConfigInputSchema.safeParse('not json').success).toBe(
      false,
    );
  });
});
