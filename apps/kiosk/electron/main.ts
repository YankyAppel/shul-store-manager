import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { z } from 'zod';
import {
  encodeScryptPinHash,
  kioskAdminVerifyRequestSchema,
  kioskCatalogResponseSchema,
  kioskChargeOutcomeSchema,
  kioskPairRequestSchema,
  kioskPriceResponseSchema,
  parseKioskStateFile,
  resolveKioskBarcode,
  SCRYPT_DK_LEN,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  type KioskAdminResult,
  type KioskApi,
  type KioskCartLine,
  type KioskChargeResult,
  type KioskConnection,
  type KioskInFlightCharge,
  type KioskPairInput,
  type KioskPriceResult,
  type KioskPublicState,
  type KioskResolvedLine,
  type KioskStateFile,
  verifyScryptPinHash,
} from '@shul-store/shared';

const DEFAULT_PORT = 3939;
const CATALOG_REFRESH_MS = 600000;
const CHARGE_RETRY_MS = 5000;
const LOCAL_PIN_LOCKOUT_MS = 30000;
const STATE_VERSION = 1;

class NetworkError extends Error {}
class RevokedError extends Error {}

let window: BrowserWindow | null = null;
let statePath = '';
let state: KioskStateFile = defaultState();
let token: string | null = null;
let encryptionAvailable = false;
let connection: KioskConnection = 'unpaired';
let unlocked = false;
let allowQuit = false;
let chargePollTimer: ReturnType<typeof setTimeout> | null = null;
let catalogTimer: ReturnType<typeof setInterval> | null = null;
let writeQueue = Promise.resolve();
let chargeRetryDelay = CHARGE_RETRY_MS;

function startTimers(): void {
  catalogTimer ??= setInterval(() => void refreshCatalog(), CATALOG_REFRESH_MS);
}

function defaultState(): KioskStateFile {
  return {
    version: STATE_VERSION,
    host: '',
    port: DEFAULT_PORT,
    kioskId: null,
    kioskName: '',
    storeName: '',
    catalog: null,
    localAdminPinHash: null,
    tokenSecret: null,
    tokenEncrypted: false,
    adminAttempts: [],
    adminLockedUntil: null,
    inFlightCharge: null,
  };
}

function derivePin(pin: string, salt: Uint8Array, length: number): Uint8Array {
  return new Uint8Array(
    scryptSync(pin, salt, length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    }),
  );
}

function localPinHash(pin: string): string {
  const salt = randomBytes(16);
  return encodeScryptPinHash(salt, derivePin(pin, salt, SCRYPT_DK_LEN));
}

function publicState(): KioskPublicState {
  return {
    connection:
      token === null && connection === 'online' ? 'unpaired' : connection,
    host: state.host,
    port: state.port,
    kioskId: state.kioskId,
    kioskName: state.kioskName,
    storeName: state.storeName,
    catalog: state.catalog,
    tokenPersistenceWarning: token !== null && !encryptionAvailable,
    inFlightCharge: state.inFlightCharge,
    adminLockedUntil: state.adminLockedUntil,
  };
}

function publish(): void {
  window?.webContents.send('kiosk:state', publicState());
}

function persist(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const persisted: KioskStateFile = {
      ...state,
      tokenSecret:
        token !== null && encryptionAvailable
          ? safeStorage.encryptString(token).toString('base64')
          : null,
      tokenEncrypted: token !== null && encryptionAvailable,
    };
    const temporaryPath = `${statePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(persisted), 'utf8');
    await rename(temporaryPath, statePath);
  });
  return writeQueue;
}

async function loadState(): Promise<void> {
  statePath = path.join(app.getPath('userData'), 'kiosk-state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  try {
    const raw: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    state = parseKioskStateFile(raw);
    if (state.tokenEncrypted && state.tokenSecret && encryptionAvailable) {
      try {
        token = safeStorage.decryptString(
          Buffer.from(state.tokenSecret, 'base64'),
        );
      } catch {
        token = null;
      }
    }
  } catch {
    state = defaultState();
  }
  if (token) connection = 'online';
  else if (state.kioskId) connection = 'unpaired';
  await persist();
}

function endpoint(pathname: string): string {
  return `http://${state.host}:${state.port}${pathname}`;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof body.error === 'string'
    )
      return body.error;
  } catch {
    // Use the status below when the manager did not return JSON.
  }
  return `Manager returned HTTP ${response.status}.`;
}

async function request(
  pathname: string,
  init: RequestInit,
  revokeOnUnauthorized = true,
): Promise<Response> {
  if (!token) throw new NetworkError('The kiosk is not paired.');
  let response: Response;
  try {
    response = await fetch(endpoint(pathname), {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new NetworkError('The manager could not be reached.');
  }
  if (response.status === 401 && revokeOnUnauthorized) {
    token = null;
    connection = 'revoked';
    await persist();
    publish();
    throw new RevokedError('This kiosk was turned off by the shames.');
  }
  return response;
}

function unresolved(
  code: 'manager-unreachable' | 'revoked' | 'error',
  message: string,
): Exclude<KioskPriceResult, { ok: true }> {
  return { ok: false, code, message };
}

function resolveLines(lines: KioskCartLine[]):
  | {
      ok: true;
      lines: KioskResolvedLine[];
    }
  | {
      ok: false;
      result: Exclude<KioskPriceResult, { ok: true }>;
    } {
  if (!state.catalog)
    return {
      ok: false,
      result: unresolved(
        'error',
        'The catalog is not available yet. Please try again.',
      ),
    };
  const resolved: KioskResolvedLine[] = [];
  for (const line of lines) {
    if (line.barcode) {
      const match = resolveKioskBarcode(
        state.catalog,
        line.barcode,
        line.quantity,
      );
      if (!match.ok)
        return {
          ok: false,
          result: {
            ok: false,
            code: 'unknown-barcode',
            message: 'Item not recognized — please ask the shames.',
          },
        };
      resolved.push(match.line);
      continue;
    }
    const product = state.catalog.products.find(
      (candidate) => candidate.id === line.productId,
    );
    if (!product)
      return {
        ok: false,
        result: {
          ok: false,
          code: 'unknown-barcode',
          message: 'Item not recognized — please ask the shames.',
        },
      };
    resolved.push({
      productId: product.id,
      quantity: line.quantity,
      barcodeUsed: null,
    });
  }
  return { ok: true, lines: resolved };
}

async function refreshCatalog(): Promise<KioskPublicState> {
  if (!token) return publicState();
  try {
    const response = await request('/api/catalog', { method: 'GET' });
    if (!response.ok) throw new Error(await responseError(response));
    const catalog = kioskCatalogResponseSchema.parse(await response.json());
    state.catalog = catalog;
    state.storeName = catalog.storeName;
    connection = 'online';
    await persist();
    publish();
  } catch (error) {
    if (error instanceof RevokedError) return publicState();
    connection = 'manager-unreachable';
    await persist();
    publish();
  }
  return publicState();
}

function terminalStatus(status: string): boolean {
  return ['approved', 'declined', 'error'].includes(status);
}

async function finishCharge(
  outcome: ReturnType<typeof kioskChargeOutcomeSchema.parse>,
): Promise<void> {
  if (terminalStatus(outcome.status)) {
    state.inFlightCharge = null;
    await persist();
    publish();
    if (outcome.status === 'approved') void refreshCatalog();
  }
}

function scheduleChargePoll(delay = CHARGE_RETRY_MS): void {
  if (chargePollTimer) clearTimeout(chargePollTimer);
  chargePollTimer = setTimeout(() => void pollInFlight(), delay);
}

async function pollInFlight(): Promise<void> {
  const inFlight = state.inFlightCharge;
  if (!inFlight || !token) return;
  try {
    const response = await request(`/api/charges/${inFlight.chargeReference}`, {
      method: 'GET',
    });
    if (!response.ok) throw new Error(await responseError(response));
    const body: unknown = await response.json();
    const outcome = kioskChargeOutcomeSchema.parse({
      chargeReference: inFlight.chargeReference,
      totalCents: 0,
      ...(body && typeof body === 'object' ? body : {}),
    });
    connection = 'online';
    chargeRetryDelay = CHARGE_RETRY_MS;
    await finishCharge(outcome);
    if (!terminalStatus(outcome.status)) {
      await persist();
      publish();
      scheduleChargePoll();
    }
  } catch (error) {
    if (error instanceof RevokedError) return;
    connection = 'manager-unreachable';
    await persist();
    publish();
    scheduleChargePoll(chargeRetryDelay);
    chargeRetryDelay = Math.min(chargeRetryDelay * 2, 60000);
  }
}

async function pair(input: KioskPairInput): Promise<KioskPublicState> {
  if (
    !input.host.trim() ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  )
    throw new Error('Enter a valid manager host and port.');
  const parsed = kioskPairRequestSchema.parse({
    code: input.code,
    name: input.name,
    adminPin: input.adminPin,
  });
  let response: Response;
  try {
    response = await fetch(`http://${input.host}:${input.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
  } catch {
    throw new Error('The manager could not be reached.');
  }
  if (!response.ok) throw new Error(await responseError(response));
  const body = z
    .object({ token: z.string().min(1), kioskId: z.string().uuid() })
    .parse(await response.json());
  state.host = input.host.trim();
  state.port = input.port;
  state.kioskId = body.kioskId;
  state.kioskName = input.name.trim();
  state.storeName = '';
  state.localAdminPinHash = localPinHash(input.adminPin);
  token = body.token;
  connection = 'online';
  await persist();
  await refreshCatalog();
  startTimers();
  return publicState();
}

async function priceCart(lines: KioskCartLine[]): Promise<KioskPriceResult> {
  const resolved = resolveLines(lines);
  if (!resolved.ok) return resolved.result;
  try {
    const response = await request('/api/cart/price', {
      method: 'POST',
      body: JSON.stringify({ lines: resolved.lines }),
    });
    if (!response.ok) {
      return unresolved('error', await responseError(response));
    }
    connection = 'online';
    return {
      ok: true,
      quote: kioskPriceResponseSchema.parse(await response.json()),
    };
  } catch (error) {
    if (error instanceof RevokedError)
      return unresolved('revoked', error.message);
    if (error instanceof NetworkError) {
      connection = 'manager-unreachable';
      await persist();
      publish();
      return unresolved('manager-unreachable', error.message);
    }
    return unresolved(
      'error',
      error instanceof Error ? error.message : 'Unable to price the cart.',
    );
  }
}

async function charge(lines: KioskCartLine[]): Promise<KioskChargeResult> {
  const resolved = resolveLines(lines);
  if (!resolved.ok)
    return {
      ok: false,
      code: resolved.result.code,
      message: resolved.result.message,
    };
  const inFlight: KioskInFlightCharge = {
    chargeReference: randomUUID(),
    idempotencyKey: randomUUID(),
    lines: resolved.lines,
    startedAt: new Date().toISOString(),
  };
  state.inFlightCharge = inFlight;
  await persist();
  publish();
  try {
    const response = await request('/api/charges', {
      method: 'POST',
      body: JSON.stringify({
        chargeReference: inFlight.chargeReference,
        idempotencyKey: inFlight.idempotencyKey,
        lines: inFlight.lines,
      }),
    });
    if (!response.ok) {
      connection = 'online';
      await persist();
      publish();
      scheduleChargePoll();
      return {
        ok: false,
        code: 'error',
        message: await responseError(response),
      };
    }
    const outcome = kioskChargeOutcomeSchema.parse(await response.json());
    connection = 'online';
    chargeRetryDelay = CHARGE_RETRY_MS;
    await finishCharge(outcome);
    if (!terminalStatus(outcome.status)) scheduleChargePoll();
    return { ok: true, outcome };
  } catch (error) {
    if (error instanceof RevokedError)
      return { ok: false, code: 'revoked', message: error.message };
    connection = 'manager-unreachable';
    await persist();
    publish();
    scheduleChargePoll(chargeRetryDelay);
    chargeRetryDelay = Math.min(chargeRetryDelay * 2, 60000);
    return {
      ok: false,
      code: 'manager-unreachable',
      message:
        'The manager cannot be reached. The charge is being recovered safely.',
    };
  }
}

function localPinAllowed(): boolean {
  const now = Date.now();
  if (state.adminLockedUntil !== null && state.adminLockedUntil > now)
    return false;
  if (state.adminLockedUntil !== null) state.adminLockedUntil = null;
  state.adminAttempts = state.adminAttempts.filter(
    (attempt) => now - attempt < LOCAL_PIN_LOCKOUT_MS,
  );
  return true;
}

function recordLocalPinFailure(): Promise<void> {
  state.adminAttempts.push(Date.now());
  if (state.adminAttempts.length >= 5) {
    state.adminAttempts = [];
    state.adminLockedUntil = Date.now() + LOCAL_PIN_LOCKOUT_MS;
  }
  return persist();
}

async function verifyAdminPin(pin: string): Promise<KioskAdminResult> {
  const parsed = kioskAdminVerifyRequestSchema.safeParse({ pin });
  if (!parsed.success) return { ok: false, message: 'Enter a valid PIN.' };
  if (!localPinAllowed())
    return { ok: false, message: 'Too many attempts. Try again shortly.' };
  try {
    const response = await request(
      '/api/admin/verify',
      { method: 'POST', body: JSON.stringify(parsed.data) },
      false,
    );
    if (response.status === 200) {
      state.adminAttempts = [];
      state.adminLockedUntil = null;
      unlocked = true;
      await persist();
      return { ok: true };
    }
    if (response.status === 401) {
      await recordLocalPinFailure();
      return { ok: false, message: 'Invalid PIN.' };
    }
    return { ok: false, message: await responseError(response) };
  } catch (error) {
    if (!(error instanceof NetworkError))
      return {
        ok: false,
        message:
          error instanceof Error ? error.message : 'PIN verification failed.',
      };
    connection = 'manager-unreachable';
    await persist();
    publish();
    if (
      !state.localAdminPinHash ||
      !verifyLocalPin(state.localAdminPinHash, parsed.data.pin)
    ) {
      await recordLocalPinFailure();
      return { ok: false, message: 'Invalid PIN.' };
    }
    state.adminAttempts = [];
    state.adminLockedUntil = null;
    unlocked = true;
    await persist();
    return { ok: true };
  }
}

function verifyLocalPin(stored: string, pin: string): boolean {
  return verifyScryptPinHash(stored, pin, derivePin);
}

function registerIpc(): void {
  const api: KioskApi = {
    getState: async () => publicState(),
    pair,
    refreshCatalog,
    priceCart,
    charge,
    verifyAdminPin,
    exitKiosk: async () => {
      if (!unlocked) throw new Error('Unlock required');
      allowQuit = true;
      app.quit();
    },
    restart: async () => {
      if (!unlocked) throw new Error('Unlock required');
      allowQuit = true;
      app.relaunch();
      app.exit(0);
    },
    subscribe: () => () => undefined,
  };
  ipcMain.handle('kiosk:getState', () => api.getState());
  ipcMain.handle('kiosk:pair', (_event, input: KioskPairInput) =>
    api.pair(input),
  );
  ipcMain.handle('kiosk:refreshCatalog', () => api.refreshCatalog());
  ipcMain.handle('kiosk:priceCart', (_event, lines: KioskCartLine[]) =>
    api.priceCart(lines),
  );
  ipcMain.handle('kiosk:charge', (_event, lines: KioskCartLine[]) =>
    api.charge(lines),
  );
  ipcMain.handle('kiosk:verifyAdminPin', (_event, pin: string) =>
    api.verifyAdminPin(pin),
  );
  ipcMain.handle('kiosk:exit', () => api.exitKiosk());
  ipcMain.handle('kiosk:restart', () => api.restart());
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      devTools: false,
    },
  });
  window.setMenu(null);
  window.on('close', (event) => {
    if (!allowQuit) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.VITE_DEV_SERVER_URL)
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else
    await window.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
}

app.whenReady().then(async () => {
  encryptionAvailable = safeStorage.isEncryptionAvailable();
  await loadState();
  registerIpc();
  await createWindow();
  window?.webContents.send('kiosk:state', publicState());
  if (token) {
    void refreshCatalog();
    void pollInFlight();
    startTimers();
  }
});

app.on('before-quit', (event) => {
  if (!allowQuit) event.preventDefault();
});
