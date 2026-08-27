import { describe, expect, it } from 'vitest';
import { assertExplicitIpcRequirements } from '../src/index.js';

describe('IPC requirements', () => {
  it('fails closed when a registered channel has no requirement', () => {
    expect(() =>
      assertExplicitIpcRequirements(['app:getVersion', 'forgotten:channel'], {
        'app:getVersion': 'public',
      }),
    ).toThrow('Missing IPC requirement: forgotten:channel');
  });
});
