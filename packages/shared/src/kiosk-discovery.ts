import { z } from 'zod';

/** UDP port used only while the manager's kiosk-pairing window is open. */
export const KIOSK_DISCOVERY_PORT = 45454;
export const KIOSK_DISCOVERY_PROTOCOL_VERSION = 1;

export const kioskDiscoveryBeaconSchema = z
  .object({
    protocolVersion: z.literal(KIOSK_DISCOVERY_PROTOCOL_VERSION),
    storeName: z.string().trim().min(1).max(200),
    host: z.string().ip({ version: 'v4' }),
    httpPort: z.number().int().min(1).max(65535),
  })
  .strict();

export type KioskDiscoveryBeacon = z.infer<typeof kioskDiscoveryBeaconSchema>;

export function encodeKioskDiscoveryBeacon(
  beacon: KioskDiscoveryBeacon,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(kioskDiscoveryBeaconSchema.parse(beacon)),
  );
}

export function parseKioskDiscoveryBeacon(
  data: Uint8Array | string,
): KioskDiscoveryBeacon {
  const text =
    typeof data === 'string'
      ? data
      : new TextDecoder().decode(new Uint8Array(data));
  return kioskDiscoveryBeaconSchema.parse(JSON.parse(text));
}
