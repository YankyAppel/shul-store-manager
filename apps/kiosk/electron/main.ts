import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import dgram from 'node:dgram';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  safeStorage,
} from 'electron';
import { z } from 'zod';
import { StoreDatabase } from '@shul-store/database';
import {
  AccountSupabaseTransport,
  SyncEngine,
  restoreFromCloud,
} from '@shul-store/sync';
import {
  encodeScryptPinHash,
  KIOSK_DISCOVERY_PORT,
  parseKioskDiscoveryBeacon,
  kioskAdminVerifyRequestSchema,
  kioskCatalogResponseSchema,
  kioskChargeOutcomeSchema,
  kioskPairRequestSchema,
  kioskPriceResponseSchema,
  parseKioskStateFile,
  refuseKioskCharge,
  resolveKioskBarcode,
  SCRYPT_DK_LEN,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  type KioskAdminResult,
  type KioskCartLine,
  type KioskCloudSignInInput,
  type KioskChargeResult,
  type KioskConnection,
  type KioskDiscoveredManager,
  type KioskInFlightCharge,
  type KioskMainHandlers,
  type KioskPairInput,
  type KioskPriceResult,
  type KioskPublicState,
  type KioskResolvedLine,
  type KioskStateFile,
  PlaintextSecretStore,
  type SecretStore,
  isTerminalKioskChargeStatus,
  verifyScryptPinHash,
} from '@shul-store/shared';
import {
  cardknoxBbposConfigSchema,
  checkCardknoxBbposReader,
} from '@shul-store/payments';

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
let sessionEnding = false;
let chargePollTimer: ReturnType<typeof setTimeout> | null = null;
let catalogTimer: ReturnType<typeof setInterval> | null = null;
let writeQueue = Promise.resolve();
let chargeRetryDelay = CHARGE_RETRY_MS;
let localDatabase: StoreDatabase | null = null;
let cloudTransport: AccountSupabaseTransport | null = null;
let cloudEngine: SyncEngine | null = null;
let cloudAccessToken: string | null = null;
let cloudRefreshToken: string | null = null;
const CLOUD_SITE_URL = 'https://skvershul.softhere.work';
let discoverySocket: dgram.Socket | null = null;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;
const discoveredManagers = new Map<string, KioskDiscoveredManager>();
const DISCOVERY_STALE_MS = 7000;

class KioskSecretStore implements SecretStore {
  readonly available = encryptionAvailable;

  encrypt(value: string): string {
    return this.available
      ? safeStorage.encryptString(value).toString('base64')
      : new PlaintextSecretStore().encrypt(value);
  }

  decrypt(value: string): string {
    if (this.available) {
      try {
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
      } catch {
        // Existing kiosk installations used the plaintext fallback.
      }
    }
    return new PlaintextSecretStore().decrypt(value);
  }
}

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
    cloudEmail: null,
    cloudStoreId: null,
    cloudAccessTokenSecret: null,
    cloudRefreshTokenSecret: null,
    cloudExpiresAt: null,
    cloudSupabaseUrl: null,
    cloudSupabaseAnonKey: null,
  };
}

function encryptCloudSecret(value: string | null): string | null {
  return value && encryptionAvailable
    ? safeStorage.encryptString(value).toString('base64')
    : value;
}

function decryptCloudSecret(value: string | null): string | null {
  if (!value) return null;
  if (!encryptionAvailable) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
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
      token === null && connection === 'online' && !cloudEngine
        ? 'unpaired'
        : connection,
    host: state.host,
    port: state.port,
    kioskId: state.kioskId,
    kioskName: state.kioskName,
    storeName: state.storeName,
    catalog: state.catalog,
    tokenPersistenceWarning: token !== null && !encryptionAvailable,
    inFlightCharge: state.inFlightCharge,
    adminLockedUntil: state.adminLockedUntil,
    discoveredManagers: [...discoveredManagers.values()].sort((a, b) =>
      a.storeName.localeCompare(b.storeName),
    ),
    readerStatus: readerStatus(),
  };
}

function readerStatus() {
  return (
    localDatabase?.getCardProcessorConfigStatus() ?? {
      configured: false,
      encrypted: false,
    }
  );
}

function saveReaderConfig(input: unknown) {
  if (!localDatabase) throw new Error('The kiosk database is not ready.');
  const config = cardknoxBbposConfigSchema.parse(input);
  return localDatabase.setCardProcessorConfigJson(
    JSON.stringify({ ...config, processorId: 'cardknox-bbpos' }),
  );
}

async function checkReader(): Promise<{ ok: boolean; message: string }> {
  if (!localDatabase)
    return { ok: false, message: 'The kiosk database is not ready.' };
  const raw = localDatabase.getCardProcessorConfigJson();
  if (!raw)
    return { ok: false, message: 'Save the BBPOS reader settings first.' };
  try {
    return checkCardknoxBbposReader(
      cardknoxBbposConfigSchema.parse(JSON.parse(raw)),
    );
  } catch {
    return { ok: false, message: 'Save valid BBPOS reader settings first.' };
  }
}

async function getExplanationDismissed(id: string): Promise<boolean> {
  const explanationId = z.string().trim().min(1).max(100).parse(id);
  return (
    localDatabase
      ?.getDeviceSettings()
      .explainDismissals.includes(explanationId) ?? false
  );
}

async function dismissExplanation(id: string): Promise<void> {
  const explanationId = z.string().trim().min(1).max(100).parse(id);
  localDatabase?.dismissDeviceExplanation(explanationId);
}

function stopDiscovery(): void {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = null;
  discoverySocket?.close();
  discoverySocket = null;
  discoveredManagers.clear();
  publish();
}

async function startDiscovery(): Promise<void> {
  stopDiscovery();
  discoverySocket = dgram.createSocket('udp4');
  discoverySocket.on('message', (message) => {
    try {
      const beacon = parseKioskDiscoveryBeacon(message);
      discoveredManagers.set(`${beacon.host}:${beacon.httpPort}`, {
        storeName: beacon.storeName,
        host: beacon.host,
        port: beacon.httpPort,
        lastSeenAt: Date.now(),
      });
      publish();
    } catch {
      // Discovery is best effort; malformed LAN traffic is ignored.
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      discoverySocket!.once('error', reject);
      discoverySocket!.bind(KIOSK_DISCOVERY_PORT, '0.0.0.0', () => {
        discoverySocket!.off('error', reject);
        resolve();
      });
    });
  } catch {
    discoverySocket?.close();
    discoverySocket = null;
    throw new Error('Manager discovery is unavailable. Use Advanced below.');
  }
  discoveryTimer = setInterval(() => {
    const cutoff = Date.now() - DISCOVERY_STALE_MS;
    for (const [key, manager] of discoveredManagers) {
      if (manager.lastSeenAt < cutoff) discoveredManagers.delete(key);
    }
    publish();
  }, 2000);
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
      cloudAccessTokenSecret: encryptCloudSecret(cloudAccessToken),
      cloudRefreshTokenSecret: encryptCloudSecret(cloudRefreshToken),
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
    cloudAccessToken = decryptCloudSecret(state.cloudAccessTokenSecret);
    cloudRefreshToken = decryptCloudSecret(state.cloudRefreshTokenSecret);
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

async function cloudConfig(): Promise<{
  supabaseUrl: string;
  anonKey: string;
}> {
  if (state.cloudSupabaseUrl && state.cloudSupabaseAnonKey)
    return {
      supabaseUrl: state.cloudSupabaseUrl,
      anonKey: state.cloudSupabaseAnonKey,
    };
  const response = await fetch(`${CLOUD_SITE_URL}/api/store/config`);
  if (!response.ok) throw new Error('Cloud setup is unavailable right now.');
  const value = (await response.json()) as {
    supabase_url?: unknown;
    supabase_anon_key?: unknown;
  };
  if (
    typeof value.supabase_url !== 'string' ||
    typeof value.supabase_anon_key !== 'string'
  )
    throw new Error('Cloud setup is unavailable right now.');
  state.cloudSupabaseUrl = value.supabase_url;
  state.cloudSupabaseAnonKey = value.supabase_anon_key;
  await persist();
  return { supabaseUrl: value.supabase_url, anonKey: value.supabase_anon_key };
}

async function cloudToken(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh &&
    cloudAccessToken &&
    (state.cloudExpiresAt ?? 0) - Date.now() > 60_000
  )
    return cloudAccessToken;
  if (!cloudRefreshToken) throw new Error('Please sign in again.');
  const config = await cloudConfig();
  state.cloudSupabaseUrl = config.supabaseUrl;
  state.cloudSupabaseAnonKey = config.anonKey;
  const response = await fetch(
    `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: cloudRefreshToken }),
    },
  );
  if (!response.ok) throw new Error('Your cloud session expired.');
  const value = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!value.access_token) throw new Error('Your cloud session expired.');
  cloudAccessToken = value.access_token;
  cloudRefreshToken = value.refresh_token ?? cloudRefreshToken;
  state.cloudExpiresAt = Date.now() + (value.expires_in ?? 3600) * 1000;
  await persist();
  return cloudAccessToken;
}

async function cloudAccountRequest(accessToken: string): Promise<Response> {
  return fetch(`${CLOUD_SITE_URL}/api/store/account`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
}

function localCatalog(): ReturnType<typeof kioskCatalogResponseSchema.parse> {
  if (!localDatabase) throw new Error('The kiosk database is not ready.');
  const settings = localDatabase.getSettings();
  return {
    storeName: settings.storeName,
    categories: localDatabase.listCategories().map((category) => ({
      id: category.id,
      name: category.name,
      secondaryName: category.secondaryName,
    })),
    products: localDatabase.listProducts().map((product) => ({
      id: product.id,
      categoryId: product.categoryId,
      name: product.name,
      secondaryName: product.secondaryName,
      priceCents: product.sellingPriceCents,
      barcodes: product.barcodes.map((barcode) => barcode.value),
    })),
  };
}

async function cloudSignIn(
  input: KioskCloudSignInInput,
): Promise<KioskPublicState> {
  const parsed = z
    .object({
      email: z.string().trim().email(),
      password: z.string().min(1),
      adminPin: z.string().regex(/^\d{4,12}$/),
    })
    .parse(input);
  const config = await cloudConfig();
  state.cloudSupabaseUrl = config.supabaseUrl;
  state.cloudSupabaseAnonKey = config.anonKey;
  const response = await fetch(
    `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: config.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email: parsed.email, password: parsed.password }),
    },
  );
  if (!response.ok)
    throw new Error('Sign-in failed. Check your email and password.');
  const value = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!value.access_token || !value.refresh_token)
    throw new Error('Please confirm your email, then sign in again.');
  cloudAccessToken = value.access_token;
  cloudRefreshToken = value.refresh_token;
  state.cloudExpiresAt = Date.now() + (value.expires_in ?? 3600) * 1000;
  const account = await cloudAccountRequest(cloudAccessToken);
  if (!account.ok) throw new Error('The cloud store could not be loaded.');
  const accountValue = (await account.json()) as {
    account?: { store_id?: unknown };
  };
  if (typeof accountValue.account?.store_id !== 'string')
    throw new Error('The cloud store identity is unavailable.');
  const storeId = accountValue.account.store_id;
  if (!localDatabase) throw new Error('The kiosk database is not ready.');
  localDatabase.setCloudStoreId(storeId);
  const deviceId = localDatabase.ensureDeviceId();
  state.kioskId = deviceId;
  cloudTransport = new AccountSupabaseTransport({
    supabaseUrl: config.supabaseUrl,
    anonKey: config.anonKey,
    deviceId,
    getAccessToken: cloudToken,
  });
  const restored = await restoreFromCloud(
    localDatabase,
    cloudTransport,
    storeId,
  );
  if (!restored.ok && !restored.message.includes('No cloud events'))
    throw new Error(restored.message);
  const prefix = await cloudTransport.claimDevicePrefix(storeId, deviceId);
  localDatabase.setDeviceReceiptPrefix(prefix);
  localDatabase.applySyncCredentials({
    enabled: true,
    supabaseUrl: config.supabaseUrl,
    apiKeySecret: config.anonKey,
    apiKeyEncrypted: false,
  });
  state.cloudEmail = parsed.email;
  state.cloudStoreId = storeId;
  state.localAdminPinHash = localPinHash(parsed.adminPin);
  state.storeName = localDatabase.getSettings().storeName;
  state.catalog = localCatalog();
  token = null;
  connection = 'online';
  cloudEngine?.stop();
  cloudEngine = new SyncEngine(localDatabase, cloudTransport);
  cloudEngine.start();
  await persist();
  publish();
  return publicState();
}

async function cloudSignUp(
  input: KioskCloudSignInInput,
): Promise<KioskPublicState> {
  const parsed = z
    .object({
      email: z.string().trim().email(),
      password: z.string().min(6),
      adminPin: z.string().regex(/^\d{4,12}$/),
    })
    .parse(input);
  const config = await cloudConfig();
  const response = await fetch(`${config.supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: parsed.email, password: parsed.password }),
  });
  if (!response.ok)
    throw new Error('Account creation failed. Please check your details.');
  const value = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!value.access_token || !value.refresh_token)
    throw new Error(
      'Account created — confirm the link in your email, then sign in.',
    );
  return cloudSignIn(input);
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
  if (cloudEngine && localDatabase) {
    try {
      state.catalog = localCatalog();
      state.storeName = state.catalog.storeName;
      await persist();
      publish();
    } catch {
      // Keep the last known local catalog available for offline checkout.
    }
    return publicState();
  }
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

async function finishCharge(
  outcome: ReturnType<typeof kioskChargeOutcomeSchema.parse>,
): Promise<void> {
  if (isTerminalKioskChargeStatus(outcome.status)) {
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
  if (!inFlight) return;
  const readerConfigured =
    cloudEngine &&
    localDatabase &&
    localDatabase.getSettings().cardProcessorId === 'cardknox-bbpos' &&
    localDatabase.getCardProcessorConfigStatus().configured;
  if (readerConfigured && localDatabase) {
    try {
      const result = await localDatabase.payments.reconcile(
        inFlight.chargeReference,
      );
      if (!result) return;
      const outcome = kioskChargeOutcomeSchema.parse({
        status: result.status,
        chargeReference: result.chargeReference,
        totalCents: result.totalCents,
        processorTransactionId: result.processorTransactionId,
        cardBrand: result.cardBrand,
        cardLast4: result.cardLast4,
        declineReason: result.declineReason,
        errorMessage: result.errorMessage,
        attentionReason: result.attentionReason,
        receiptNumber: result.receiptNumber,
      });
      await finishCharge(outcome);
    } catch {
      // Keep the local charge pending until an operator resolves it.
    }
    return;
  }
  if (!token) return;
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
    if (!isTerminalKioskChargeStatus(outcome.status)) {
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
  state.adminAttempts = [];
  state.adminLockedUntil = null;
  state.inFlightCharge = null;
  token = body.token;
  connection = 'online';
  stopDiscovery();
  await persist();
  await refreshCatalog();
  startTimers();
  return publicState();
}

async function priceCart(lines: KioskCartLine[]): Promise<KioskPriceResult> {
  const resolved = resolveLines(lines);
  if (!resolved.ok) return resolved.result;
  if (cloudEngine && localDatabase && state.catalog) {
    const settings = localDatabase.getSettings();
    const quoted = resolved.lines.map((line) => {
      const product = state.catalog!.products.find(
        (candidate) => candidate.id === line.productId,
      )!;
      const localProduct = localDatabase!.getProduct(line.productId);
      const subtotalCents = product.priceCents * line.quantity;
      const taxCents = localProduct.taxable
        ? settings.pricesIncludeTax
          ? Math.round(
              (subtotalCents * settings.taxRateBps) /
                (10000 + settings.taxRateBps),
            )
          : Math.round((subtotalCents * settings.taxRateBps) / 10000)
        : 0;
      const totalCents = settings.pricesIncludeTax
        ? subtotalCents
        : subtotalCents + taxCents;
      return {
        productId: line.productId,
        quantity: line.quantity,
        unitPriceCents: product.priceCents,
        subtotalCents,
        taxCents,
        totalCents,
        name: product.name,
        secondaryName: product.secondaryName,
      };
    });
    return {
      ok: true,
      quote: kioskPriceResponseSchema.parse({
        lines: quoted,
        subtotalCents: quoted.reduce(
          (sum, line) => sum + line.subtotalCents,
          0,
        ),
        taxCents: quoted.reduce((sum, line) => sum + line.taxCents, 0),
        totalCents: quoted.reduce((sum, line) => sum + line.totalCents, 0),
      }),
    };
  }
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
  const canStart = refuseKioskCharge(state.inFlightCharge);
  if (!canStart.ok) return canStart;
  const resolved = resolveLines(lines);
  if (!resolved.ok)
    return {
      ok: false,
      code: resolved.result.code,
      message: resolved.result.message,
    };
  if (cloudEngine && localDatabase) {
    try {
      const settings = localDatabase.getSettings();
      if (
        settings.cardProcessingEnabled &&
        settings.cardProcessorId === 'cardknox-bbpos'
      ) {
        const inFlight: KioskInFlightCharge = {
          chargeReference: randomUUID(),
          idempotencyKey: randomUUID(),
          lines: resolved.lines,
          startedAt: new Date().toISOString(),
        };
        state.inFlightCharge = inFlight;
        await persist();
        publish();
        const result = await localDatabase.payments.charge(
          {
            chargeReference: inFlight.chargeReference,
            idempotencyKey: inFlight.idempotencyKey,
            lines: inFlight.lines,
          },
          { channel: 'kiosk', kioskId: state.kioskId },
        );
        const outcome = kioskChargeOutcomeSchema.parse({
          status: result.status,
          chargeReference: result.chargeReference,
          totalCents: result.totalCents,
          processorTransactionId: result.processorTransactionId,
          cardBrand: result.cardBrand,
          cardLast4: result.cardLast4,
          declineReason: result.declineReason,
          errorMessage: result.errorMessage,
          attentionReason: result.attentionReason,
          receiptNumber: result.receiptNumber,
        });
        await finishCharge(outcome);
        if (!isTerminalKioskChargeStatus(outcome.status)) scheduleChargePoll();
        return { ok: true, outcome };
      }
      const sale = localDatabase.completeSale(
        {
          completionKey: randomUUID(),
          lines: resolved.lines,
          payment: {
            method: 'external_terminal',
            approved: true,
            terminalReference: 'cloud-kiosk-offline',
          },
        },
        undefined,
        state.kioskId,
      );
      const outcome = kioskChargeOutcomeSchema.parse({
        status: 'approved',
        chargeReference: randomUUID(),
        totalCents: sale.totalCents,
        receiptNumber: sale.receiptNumber,
      });
      return { ok: true, outcome };
    } catch (error) {
      return {
        ok: false,
        code: 'error',
        message: error instanceof Error ? error.message : 'Sale failed.',
      };
    }
  }
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
    if (!isTerminalKioskChargeStatus(outcome.status)) scheduleChargePoll();
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
  const handlers: KioskMainHandlers = {
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
    startDiscovery,
    stopDiscovery: async () => stopDiscovery(),
    cloudSignIn,
    cloudSignUp,
    getReaderStatus: async () => readerStatus(),
    saveReaderConfig: async (input) => saveReaderConfig(input),
    checkReader,
    getExplanationDismissed,
    dismissExplanation,
  };
  ipcMain.handle('kiosk:getState', () => handlers.getState());
  ipcMain.handle('kiosk:pair', (_event, input: KioskPairInput) =>
    handlers.pair(input),
  );
  ipcMain.handle('kiosk:cloudSignIn', (_event, input: KioskCloudSignInInput) =>
    handlers.cloudSignIn(input),
  );
  ipcMain.handle('kiosk:cloudSignUp', (_event, input: KioskCloudSignInInput) =>
    handlers.cloudSignUp(input),
  );
  ipcMain.handle('kiosk:getReaderStatus', () => handlers.getReaderStatus());
  ipcMain.handle('kiosk:saveReaderConfig', (_event, input) =>
    handlers.saveReaderConfig(input),
  );
  ipcMain.handle('kiosk:checkReader', () => handlers.checkReader());
  ipcMain.handle('kiosk:getExplanationDismissed', (_event, id) =>
    handlers.getExplanationDismissed(id),
  );
  ipcMain.handle('kiosk:dismissExplanation', (_event, id) =>
    handlers.dismissExplanation(id),
  );
  ipcMain.handle('kiosk:refreshCatalog', () => handlers.refreshCatalog());
  ipcMain.handle('kiosk:priceCart', (_event, lines: KioskCartLine[]) =>
    handlers.priceCart(lines),
  );
  ipcMain.handle('kiosk:charge', (_event, lines: KioskCartLine[]) =>
    handlers.charge(lines),
  );
  ipcMain.handle('kiosk:verifyAdminPin', (_event, pin: string) =>
    handlers.verifyAdminPin(pin),
  );
  ipcMain.handle('kiosk:exit', () => handlers.exitKiosk());
  ipcMain.handle('kiosk:restart', () => handlers.restart());
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
    if (!allowQuit && !sessionEnding) event.preventDefault();
  });
  if (process.platform === 'win32')
    window.on('session-end', () => {
      sessionEnding = true;
      allowQuit = true;
    });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const blockedKey =
      input.key === 'F5' ||
      input.key === 'F12' ||
      ((input.control || input.meta) &&
        (key === 'r' ||
          input.key === '+' ||
          input.key === '=' ||
          input.key === '-' ||
          key === '0')) ||
      ((input.control || input.meta) &&
        input.shift &&
        ['i', 'j', 'c'].includes(key));
    if (blockedKey) event.preventDefault();
  });
  if (process.env.VITE_DEV_SERVER_URL)
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else
    await window.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.exit(0);
} else {
  app.on('second-instance', () => window?.focus());
  powerMonitor.on('shutdown', () => {
    sessionEnding = true;
    allowQuit = true;
  });
}

app.whenReady().then(async () => {
  encryptionAvailable = safeStorage.isEncryptionAvailable();
  await loadState();
  localDatabase = new StoreDatabase(
    path.join(app.getPath('userData'), 'kiosk.sqlite'),
    new KioskSecretStore(),
  );
  if (
    cloudAccessToken &&
    state.cloudStoreId &&
    state.cloudSupabaseUrl &&
    state.cloudSupabaseAnonKey
  ) {
    const deviceId = localDatabase.ensureDeviceId();
    state.kioskId = deviceId;
    cloudTransport = new AccountSupabaseTransport({
      supabaseUrl: state.cloudSupabaseUrl,
      anonKey: state.cloudSupabaseAnonKey,
      deviceId,
      getAccessToken: cloudToken,
    });
    localDatabase.applySyncCredentials({
      enabled: true,
      supabaseUrl: state.cloudSupabaseUrl,
      apiKeySecret: state.cloudSupabaseAnonKey,
      apiKeyEncrypted: false,
    });
    cloudEngine = new SyncEngine(localDatabase, cloudTransport);
    cloudEngine.start();
    state.catalog = localCatalog();
    state.storeName = state.catalog.storeName;
    connection = 'online';
  }
  registerIpc();
  await createWindow();
  window?.webContents.send('kiosk:state', publicState());
  if (token || cloudAccessToken) {
    void refreshCatalog();
    void pollInFlight();
    startTimers();
  }
});

app.on('before-quit', (event) => {
  if (!allowQuit && !sessionEnding) event.preventDefault();
});
