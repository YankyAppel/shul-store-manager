import { describe, expect, it } from 'vitest';
import {
  encodeScryptPinHash,
  parseKioskStateFile,
  resolveKioskBarcode,
  SCRYPT_DK_LEN,
  transitionChargeState,
  verifyScryptPinHash,
} from '../src/index.js';

const catalog = {
  storeName: 'Shul Store',
  categories: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Drinks',
      secondaryName: null,
    },
  ],
  products: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      categoryId: '11111111-1111-4111-8111-111111111111',
      name: 'Water',
      secondaryName: 'Still',
      priceCents: 150,
      barcodes: ['WATER-1'],
    },
  ],
};

describe('kiosk client helpers', () => {
  it('resolves cached barcodes and rejects unknown values', () => {
    expect(resolveKioskBarcode(catalog, 'water-1', 2)).toEqual({
      ok: true,
      line: {
        productId: catalog.products[0]!.id,
        quantity: 2,
        barcodeUsed: 'water-1',
      },
    });
    expect(resolveKioskBarcode(catalog, 'missing')).toEqual({
      ok: false,
      code: 'unknown-barcode',
    });
  });

  it('encodes and verifies the self-describing PIN format', () => {
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
    const derive = (pin: string, value: Uint8Array, length: number) =>
      Uint8Array.from(
        { length },
        (_, index) =>
          value[index % value.length]! ^ pin.charCodeAt(index % pin.length),
      );
    const derived = derive('1234', salt, SCRYPT_DK_LEN);
    const encoded = encodeScryptPinHash(salt, derived);

    expect(verifyScryptPinHash(encoded, '1234', derive)).toBe(true);
    expect(verifyScryptPinHash(encoded, '4321', derive)).toBe(false);
  });

  it('validates persisted state and models charge recovery transitions', () => {
    const state = parseKioskStateFile({
      version: 1,
      host: '127.0.0.1',
      port: 3939,
      kioskId: null,
      kioskName: 'Front kiosk',
      storeName: 'Shul Store',
      catalog: null,
      localAdminPinHash: null,
      tokenSecret: null,
      tokenEncrypted: false,
      adminAttempts: [],
      adminLockedUntil: null,
      inFlightCharge: null,
    });
    expect(state.port).toBe(3939);
    expect(() => parseKioskStateFile({ ...state, port: 0 })).toThrow();

    const submitting = transitionChargeState(
      { phase: 'idle', reference: null, message: null },
      { type: 'begin', reference: '33333333-3333-4333-8333-333333333333' },
    );
    expect(
      transitionChargeState(submitting, { type: 'unreachable' }).phase,
    ).toBe('unresolved');
    expect(
      transitionChargeState(submitting, {
        type: 'poll',
        status: 'approved',
      }).phase,
    ).toBe('approved');
  });
});
