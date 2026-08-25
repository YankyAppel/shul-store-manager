import { describe, expect, it } from 'vitest';
import {
  encodeScryptPinHash,
  isTerminalKioskChargeStatus,
  parseKioskStateFile,
  refuseKioskCharge,
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
    expect(
      transitionChargeState(submitting, {
        type: 'poll',
        status: 'needs-attention',
      }),
    ).toEqual({
      phase: 'error',
      reference: submitting.reference,
      message: 'Please see the shames about this payment.',
    });
    expect(
      transitionChargeState(submitting, {
        type: 'poll',
        status: 'voided',
      }).phase,
    ).toBe('error');
  });

  it('refuses a new charge while a charge is in flight', () => {
    const inFlight = {
      chargeReference: '33333333-3333-4333-8333-333333333333',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      lines: [
        {
          productId: catalog.products[0]!.id,
          quantity: 1,
          barcodeUsed: 'water-1',
        },
      ],
      startedAt: '2025-01-01T00:00:00.000Z',
    };
    expect(refuseKioskCharge(null)).toEqual({ ok: true });
    expect(refuseKioskCharge(inFlight)).toEqual({
      ok: false,
      code: 'in-flight-charge',
      message:
        'The previous payment is still being confirmed — please see the shames.',
    });
    expect(isTerminalKioskChargeStatus('approved')).toBe(true);
    expect(isTerminalKioskChargeStatus('declined')).toBe(true);
    expect(isTerminalKioskChargeStatus('error')).toBe(true);
    expect(isTerminalKioskChargeStatus('needs-attention')).toBe(true);
    expect(isTerminalKioskChargeStatus('voided')).toBe(true);
    expect(isTerminalKioskChargeStatus('unknown')).toBe(false);
  });
});
