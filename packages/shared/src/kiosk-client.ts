import { z } from 'zod';
import { kioskCatalogResponseSchema } from './kiosk.js';
import type { UpdateCheckResult } from './index.js';

export type KioskConnection =
  'unpaired' | 'online' | 'manager-unreachable' | 'revoked';

export interface KioskDiscoveredManager {
  storeName: string;
  host: string;
  port: number;
  lastSeenAt: number;
}

export const kioskCartLineSchema = z
  .object({
    productId: z.string().uuid().optional(),
    barcode: z.string().trim().min(1).max(100).optional(),
    quantity: z.number().int().positive().max(10000),
  })
  .strict()
  .refine((line) => Boolean(line.productId || line.barcode));
export type KioskCartLine = z.infer<typeof kioskCartLineSchema>;

export const kioskResolvedLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
  barcodeUsed: z.string().nullable(),
});
export type KioskResolvedLine = z.infer<typeof kioskResolvedLineSchema>;

export const kioskPriceResponseSchema = z.object({
  lines: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().positive(),
      unitPriceCents: z.number().int().nonnegative(),
      subtotalCents: z.number().int().nonnegative(),
      taxCents: z.number().int().nonnegative(),
      totalCents: z.number().int().nonnegative(),
      name: z.string(),
      secondaryName: z.string().nullable(),
    }),
  ),
  subtotalCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
});
export type KioskPriceQuote = z.infer<typeof kioskPriceResponseSchema>;

export type KioskPriceResult =
  | { ok: true; quote: KioskPriceQuote }
  | {
      ok: false;
      code: 'unknown-barcode' | 'manager-unreachable' | 'revoked' | 'error';
      message: string;
    };

export interface KioskPairInput {
  host: string;
  port: number;
  code: string;
  name: string;
  adminPin: string;
}

export interface KioskCloudSignInInput {
  email: string;
  password: string;
  adminPin: string;
}

export interface KioskReaderConfig {
  processorId?: 'cardknox-bbpos' | 'usaepay-payment-engine';
  apiKey: string;
  apiPin?: string;
  deviceKey?: string;
  deviceName: string;
  connection:
    | { kind: 'usb'; comPort: string }
    | { kind: 'ip'; address: string; port: number };
  silentMode: boolean;
  readerOnly: boolean;
  amountConfirmationPrompt: boolean;
  deviceTimeoutSeconds: number;
  paymentTimeoutSeconds?: number;
  promptTip?: boolean;
  manualKey?: boolean;
  mode: 'test' | 'live';
}

export interface KioskReaderStatus {
  configured: boolean;
  encrypted: boolean;
  keyHint?: string | null;
}

export const kioskChargeOutcomeSchema = z.object({
  status: z.string(),
  chargeReference: z.string().uuid(),
  totalCents: z.number().int().nonnegative(),
  processorTransactionId: z.string().optional(),
  cardBrand: z.string().optional(),
  cardLast4: z.string().optional(),
  declineReason: z.string().optional(),
  errorMessage: z.string().optional(),
  attentionReason: z.string().optional(),
  receiptNumber: z.number().int().optional(),
});
export type KioskChargeOutcome = z.infer<typeof kioskChargeOutcomeSchema>;

export type KioskChargeResult =
  | { ok: true; outcome: KioskChargeOutcome }
  | {
      ok: false;
      code:
        | 'unknown-barcode'
        | 'manager-unreachable'
        | 'revoked'
        | 'in-flight-charge'
        | 'error';
      message: string;
    };

export type BarcodeResolution =
  | { ok: true; line: KioskResolvedLine }
  | { ok: false; code: 'unknown-barcode' };

export function resolveKioskBarcode(
  catalog: z.infer<typeof kioskCatalogResponseSchema>,
  barcode: string,
  quantity = 1,
): BarcodeResolution {
  const clean = barcode.trim();
  const product = catalog.products.find((candidate) =>
    candidate.barcodes.some(
      (candidateBarcode) =>
        candidateBarcode.toLowerCase() === clean.toLowerCase(),
    ),
  );
  if (!product) return { ok: false, code: 'unknown-barcode' };
  return {
    ok: true,
    line: { productId: product.id, quantity, barcodeUsed: clean },
  };
}

export const kioskInFlightChargeSchema = z.object({
  chargeReference: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  lines: z.array(kioskResolvedLineSchema).min(1).max(500),
  startedAt: z.string().datetime(),
});
export type KioskInFlightCharge = z.infer<typeof kioskInFlightChargeSchema>;

export function refuseKioskCharge(
  inFlightCharge: KioskInFlightCharge | null,
): { ok: true } | { ok: false; code: 'in-flight-charge'; message: string } {
  if (!inFlightCharge) return { ok: true };
  return {
    ok: false,
    code: 'in-flight-charge',
    message:
      'The previous payment is still being confirmed — please see the shames.',
  };
}

export function isTerminalKioskChargeStatus(status: string): boolean {
  return [
    'approved',
    'declined',
    'error',
    'needs-attention',
    'voided',
  ].includes(status);
}

export const kioskStateFileSchema = z.object({
  version: z.literal(1),
  host: z.string().max(2048),
  port: z.number().int().min(1).max(65535),
  kioskId: z.string().uuid().nullable(),
  kioskName: z.string().max(100),
  storeName: z.string(),
  catalog: kioskCatalogResponseSchema.nullable(),
  localAdminPinHash: z.string().nullable(),
  tokenSecret: z.string().nullable(),
  tokenEncrypted: z.boolean(),
  adminAttempts: z.array(z.number().int().nonnegative()),
  adminLockedUntil: z.number().nullable(),
  inFlightCharge: kioskInFlightChargeSchema.nullable(),
  cloudEmail: z.string().nullable().optional().default(null),
  cloudStoreId: z.string().uuid().nullable().optional().default(null),
  cloudAccessTokenSecret: z.string().nullable().optional().default(null),
  cloudRefreshTokenSecret: z.string().nullable().optional().default(null),
  cloudExpiresAt: z.number().nullable().optional().default(null),
  cloudSupabaseUrl: z.string().nullable().optional().default(null),
  cloudSupabaseAnonKey: z.string().nullable().optional().default(null),
});
export type KioskStateFile = z.infer<typeof kioskStateFileSchema>;

export function parseKioskStateFile(value: unknown): KioskStateFile {
  return kioskStateFileSchema.parse(value);
}

export interface KioskPublicState {
  connection: KioskConnection;
  host: string;
  port: number;
  kioskId: string | null;
  kioskName: string;
  storeName: string;
  catalog: KioskStateFile['catalog'];
  tokenPersistenceWarning: boolean;
  inFlightCharge: KioskInFlightCharge | null;
  adminLockedUntil: number | null;
  discoveredManagers: KioskDiscoveredManager[];
  readerStatus: KioskReaderStatus;
}

export type KioskAdminResult = { ok: true } | { ok: false; message: string };

export interface KioskMainHandlers {
  getState(): Promise<KioskPublicState>;
  pair(input: KioskPairInput): Promise<KioskPublicState>;
  refreshCatalog(): Promise<KioskPublicState>;
  priceCart(lines: KioskCartLine[]): Promise<KioskPriceResult>;
  charge(lines: KioskCartLine[]): Promise<KioskChargeResult>;
  verifyAdminPin(pin: string): Promise<KioskAdminResult>;
  exitKiosk(): Promise<void>;
  restart(): Promise<void>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  cloudSignIn(input: KioskCloudSignInInput): Promise<KioskPublicState>;
  cloudSignUp(input: KioskCloudSignInInput): Promise<KioskPublicState>;
  getReaderStatus(): Promise<KioskReaderStatus>;
  saveReaderConfig(input: KioskReaderConfig): Promise<KioskReaderStatus>;
  checkReader(): Promise<{ ok: boolean; message: string }>;
  getExplanationDismissed(id: string): Promise<boolean>;
  dismissExplanation(id: string): Promise<void>;
}

export interface KioskApi extends KioskMainHandlers {
  updates: {
    check(): Promise<UpdateCheckResult>;
    getState(): Promise<UpdateCheckResult>;
    subscribe(listener: (state: UpdateCheckResult) => void): () => void;
  };
  subscribe(listener: (state: KioskPublicState) => void): () => void;
}

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_DK_LEN = 32;

export type PinDeriver = (
  pin: string,
  salt: Uint8Array,
  length: number,
) => Uint8Array;

export function encodeScryptPinHash(
  salt: Uint8Array,
  derivedKey: Uint8Array,
): string {
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    toBase64Url(salt),
    toBase64Url(derivedKey),
  ].join('$');
}

export function parseScryptPinHash(
  value: string,
): { salt: Uint8Array; derivedKey: Uint8Array } | null {
  const parts = value.split('$');
  if (parts.length !== 6) return null;
  const [algorithm, n, r, p, saltText, derivedText] = parts;
  if (
    algorithm !== 'scrypt' ||
    n !== String(SCRYPT_N) ||
    r !== String(SCRYPT_R) ||
    p !== String(SCRYPT_P) ||
    !saltText ||
    !derivedText
  )
    return null;
  const salt = fromBase64Url(saltText);
  const derivedKey = fromBase64Url(derivedText);
  if (!salt || salt.length !== 16 || !derivedKey || derivedKey.length !== 32)
    return null;
  return { salt, derivedKey };
}

export function verifyScryptPinHash(
  value: string,
  pin: string,
  derive: PinDeriver,
): boolean {
  const parsed = parseScryptPinHash(value);
  if (!parsed) return false;
  const actual = derive(pin, parsed.salt, SCRYPT_DK_LEN);
  return equalBytes(actual, parsed.derivedKey);
}

export type ChargePhase =
  | 'idle'
  | 'submitting'
  | 'recovering'
  | 'approved'
  | 'declined'
  | 'error'
  | 'unresolved';

export interface ChargeState {
  phase: ChargePhase;
  reference: string | null;
  message: string | null;
}

export type ChargeEvent =
  | { type: 'begin'; reference: string }
  | {
      type: 'submitted';
      status:
        | 'approved'
        | 'declined'
        | 'error'
        | 'unknown'
        | 'needs-attention'
        | 'voided';
    }
  | {
      type: 'poll';
      status:
        | 'approved'
        | 'declined'
        | 'error'
        | 'unknown'
        | 'needs-attention'
        | 'voided';
    }
  | { type: 'unreachable' }
  | { type: 'reset' };

export function transitionChargeState(
  state: ChargeState,
  event: ChargeEvent,
): ChargeState {
  switch (event.type) {
    case 'begin':
      return { phase: 'submitting', reference: event.reference, message: null };
    case 'submitted':
    case 'poll':
      if (event.status === 'approved')
        return { phase: 'approved', reference: state.reference, message: null };
      if (event.status === 'declined')
        return {
          phase: 'declined',
          reference: state.reference,
          message: null,
        };
      if (event.status === 'error')
        return {
          phase: 'error',
          reference: state.reference,
          message: 'The charge could not be completed.',
        };
      if (event.status === 'needs-attention' || event.status === 'voided')
        return {
          phase: 'error',
          reference: state.reference,
          message: 'Please see the shames about this payment.',
        };
      return { phase: 'recovering', reference: state.reference, message: null };
    case 'unreachable':
      return {
        phase: 'unresolved',
        reference: state.reference,
        message:
          'The manager cannot be reached. Please see the shames before trying again.',
      };
    case 'reset':
      return { phase: 'idle', reference: null, message: null };
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
