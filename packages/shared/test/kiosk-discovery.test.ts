import { describe, expect, it } from 'vitest';
import {
  encodeKioskDiscoveryBeacon,
  KIOSK_DISCOVERY_PROTOCOL_VERSION,
  parseKioskDiscoveryBeacon,
} from '../src/index.js';

describe('kiosk discovery beacon', () => {
  it('round-trips only public LAN connection details', () => {
    const encoded = encodeKioskDiscoveryBeacon({
      protocolVersion: KIOSK_DISCOVERY_PROTOCOL_VERSION,
      storeName: 'Main Shul Store',
      host: '192.168.1.24',
      httpPort: 3939,
    });
    const text = new TextDecoder().decode(encoded);
    expect(text).not.toMatch(/token|secret|pair|store.?id|password/i);
    expect(parseKioskDiscoveryBeacon(encoded)).toEqual({
      protocolVersion: 1,
      storeName: 'Main Shul Store',
      host: '192.168.1.24',
      httpPort: 3939,
    });
  });

  it('rejects malformed or unsupported beacons', () => {
    expect(() =>
      parseKioskDiscoveryBeacon(
        JSON.stringify({
          protocolVersion: 2,
          storeName: 'Store',
          host: '192.168.1.24',
          httpPort: 3939,
        }),
      ),
    ).toThrow();
  });
});
