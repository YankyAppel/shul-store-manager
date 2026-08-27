import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain as electronIpcMain,
  net,
  protocol,
  safeStorage,
  shell,
} from 'electron';
import electronUpdater from 'electron-updater';
import { z } from 'zod';
import {
  KioskServer,
  parseBackupName,
  restoreImagesFromVault,
  StoreDatabase,
} from '@shul-store/database';
import {
  accountPaymentReceiptHtml,
  assertExplicitIpcRequirements,
  businessDayRange,
  categoryInputSchema,
  completeSaleInputSchema,
  customerInputSchema,
  customerStatementDataSchema,
  dailyCloseInputSchema,
  dailyReportHtml,
  dailyReportInputSchema,
  dailyReportPrintInputSchema,
  deviceSettingsSchema,
  inventoryMovementInputSchema,
  isHttpsUpdateFeedUrl,
  labelPrintRequestSchema,
  labelsHtml,
  productInputSchema,
  receiptHtml,
  refundReceiptHtml,
  recordAccountPaymentInputSchema,
  recordRefundInputSchema,
  statementHtml,
  statementOptionsSchema,
  processorConfigInputSchema,
  storeSettingsSchema,
  type AccountPaymentReceiptData,
  type CustomerStatementData,
  type LabelPrintRequest,
  type PrinterInfo,
  type PrintResult,
  type ReceiptData,
  type SecretStore,
  type UpdateCheckResult,
  type CompleteSaleInput,
  grantablePermissionSchema,
  staffCreateInputSchema,
  staffPinSchema,
  staffUpdateInputSchema,
} from '@shul-store/shared';
import {
  maskApiKey,
  AccountSupabaseTransport,
  PlaintextSyncSecretStore,
  restoreFromCloud,
  SupabaseTransport,
  SyncEngine,
  type SyncSecretStore,
} from '@shul-store/sync';
import { restoreInputSchema, syncConfigInputSchema } from '@shul-store/shared';
import { ManagerSession, type IpcRequirement } from './session.js';
import { CloudAccountManager } from './cloud-account.js';

/**
 * electron-updater is CommonJS, so its bindings are only reachable through the
 * default export from this ESM entrypoint.
 */
const { autoUpdater } = electronUpdater;

const require = createRequire(import.meta.url);
const { githubUpdateRepository } = require('../update-config.cjs') as {
  githubUpdateRepository: { owner: string; repo: string };
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'store-image',
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
]);

let database: StoreDatabase;
let engine: SyncEngine | null = null;
let secretStore: SecretStore = new PlaintextSyncSecretStore();
let kioskServer: KioskServer | null = null;
let kioskReconcileTimer: ReturnType<typeof setInterval> | null = null;
let databasePath = '';
let session: ManagerSession;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let backupDirectory = '';
let imageDirectory = '';
let backupTimer: ReturnType<typeof setInterval> | null = null;
let updateInitialTimer: ReturnType<typeof setTimeout> | null = null;
let updateTimer: ReturnType<typeof setInterval> | null = null;
let cloudAccount: CloudAccountManager;
let cloudWasSyncAllowed = false;
const SCHEDULED_BACKUP_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const SCHEDULED_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_INITIAL_DELAY_MS = 30 * 1000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const channelRequirements: Record<string, IpcRequirement> = {
  'app:getVersion': 'public',
  'updates:check': 'public',
  'updates:getState': 'public',
  'kiosk:getSettings': 'owner',
  'kiosk:pairCode': 'owner',
  'kiosk:revoke': 'owner',
  'kiosk:setServer': 'owner',
  'payments:initiateCharge': 'checkout',
  'payments:getChargeStatus': 'checkout',
  'payments:getPendingTransactions': 'owner',
  'payments:reconcileTransactions': 'owner',
  'payments:listNeedsAttention': 'owner',
  'payments:resolveNeedsAttention': 'owner',
  'categories:list': 'public',
  'categories:create': 'products.edit',
  'categories:update': 'products.edit',
  'categories:setActive': 'products.edit',
  'products:list': 'public',
  'products:create': 'products.edit',
  'products:update': 'products.edit',
  'products:setActive': 'products.edit',
  'products:generateBarcode': 'products.edit',
  'inventory:addMovement': 'inventory.adjust',
  'inventory:list': 'inventory.adjust',
  'settings:get': 'owner',
  'settings:update': 'owner',
  'settings:getDevice': 'owner',
  'settings:updateDevice': 'owner',
  'settings:setProcessorConfig': 'owner',
  'settings:getProcessorConfigStatus': 'owner',
  'settings:listPrinters': 'owner',
  'labels:render': 'products.edit',
  'labels:print': 'products.edit',
  'checkout:lookupBarcode': 'public',
  'checkout:complete': 'checkout',
  'sales:list': 'sales.history',
  'sales:get': 'sales.history',
  'sales:receipt': 'sales.history',
  'sales:print': 'sales.history',
  'sales:lookupReceiptBarcode': 'public',
  'refunds:refundable': 'refunds',
  'refunds:record': 'refunds',
  'refunds:list': 'refunds',
  'refunds:print': 'refunds',
  'refunds:listAttention': 'owner',
  'refunds:resolveAttention': 'owner',
  'customers:list': 'checkout',
  'customers:get': 'checkout',
  'customers:search': 'checkout',
  'customers:create': 'customers.manage',
  'customers:update': 'customers.manage',
  'customers:setActive': 'customers.manage',
  'customers:setBlocked': 'customers.manage',
  'customers:generateAccountNumber': 'customers.manage',
  'customers:generateBarcode': 'customers.manage',
  'customers:lookupBarcode': 'checkout',
  'customers:getLedger': 'customers.manage',
  'customers:getStatement': 'customers.manage',
  'customers:printStatement': 'customers.manage',
  'accountPayments:record': 'account_payments',
  'accountPayments:list': 'account_payments',
  'accountPayments:get': 'account_payments',
  'accountPayments:receipt': 'account_payments',
  'accountPayments:print': 'account_payments',
  'images:choose': 'products.edit',
  'images:discard': 'products.edit',
  'sync:getConfig': 'owner',
  'sync:getStatus': 'owner',
  'sync:isRestoreAvailable': 'owner',
  'sync:saveConfig': 'owner',
  'sync:setEnabled': 'owner',
  'sync:testConnection': 'owner',
  'sync:syncNow': 'owner',
  'sync:restore': 'owner',
  'backups:list': 'owner',
  'backups:create': 'owner',
  'backups:getLastRestoreResult': 'owner',
  'backups:revealFolder': 'owner',
  'backups:restore': 'owner',
  'reports:daily': 'reports.view',
  'reports:close': 'reports.close',
  'reports:listCloses': 'reports.view',
  'reports:print': 'reports.view',
  'auth:getState': 'public',
  'auth:listAccounts': 'public',
  'auth:signIn': 'public',
  'auth:signOut': 'public',
  'auth:touch': 'public',
  'auth:elevate': 'public',
  'auth:createFirstOwner': 'public',
  'cloudAccount:getState': 'public',
  'cloudAccount:shouldShowOnboarding': 'public',
  'cloudAccount:dismissOnboarding': 'public',
  'cloudAccount:signIn': 'public',
  'cloudAccount:signUp': 'public',
  'cloudAccount:signOut': 'public',
  'cloudAccount:refresh': 'public',
  'cloudAccount:link': 'public',
  'cloudAccount:linkHint': 'public',
  'cloudAccount:checkout': 'owner',
  'cloudAccount:portal': 'owner',
  'staff:list': 'owner',
  'staff:create': 'owner',
  'staff:update': 'owner',
  'staff:setPin': 'owner',
  'staff:setIdleLock': 'owner',
};

const ipcMain = {
  handle(
    channel: string,
    listener: (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown,
  ): void {
    const requirement = channelRequirements[channel] as IpcRequirement;
    assertExplicitIpcRequirements([channel], channelRequirements);
    electronIpcMain.handle(channel, async (event, ...args) => {
      if (channel.startsWith('auth:')) session?.touch();
      else {
        session.authorize(requirement);
        session.touch();
      }
      return listener(event, ...args);
    });
  },
};

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let updateState: UpdateCheckResult = {
  status: 'not_configured',
  currentVersion: '',
  availableVersion: null,
  message: 'Automatic updates have not been checked yet.',
  checkedAt: null,
};

function publishUpdateState(
  changes: Partial<UpdateCheckResult>,
): UpdateCheckResult {
  updateState = {
    ...updateState,
    ...changes,
    currentVersion: app.getVersion(),
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send('updates:state', updateState);
    } catch {
      // A window can close while an updater event is being delivered.
    }
  }
  return updateState;
}

function configureAutoUpdater(
  settings: ReturnType<StoreDatabase['getDeviceSettings']>,
): void {
  if (settings.updateFeedUrl && !isHttpsUpdateFeedUrl(settings.updateFeedUrl)) {
    console.error('Refusing to configure updater with a non-HTTPS feed URL');
    throw new Error('Update feed URL must use HTTPS');
  }
  autoUpdater.autoDownload = settings.automaticUpdatesEnabled;
  autoUpdater.autoInstallOnAppQuit = settings.automaticUpdatesEnabled;
  if (settings.updateFeedUrl) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: settings.updateFeedUrl,
    });
  } else {
    autoUpdater.setFeedURL({
      provider: 'github',
      ...githubUpdateRepository,
    });
  }
}

async function checkForUpdates(manual: boolean): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return publishUpdateState({
      status: 'not_configured',
      availableVersion: null,
      message: 'Update checks are available only in packaged builds.',
      checkedAt: new Date().toISOString(),
    });
  }

  try {
    const deviceSettings = database.getDeviceSettings();
    if (!manual && !deviceSettings.automaticUpdatesEnabled) {
      return publishUpdateState({
        status: 'not_configured',
        availableVersion: null,
        message: 'Automatic updates are disabled in Settings.',
        checkedAt: new Date().toISOString(),
      });
    }
    publishUpdateState({
      status: 'checking',
      message: 'Checking for updates…',
    });
    configureAutoUpdater(deviceSettings);
    const result = await autoUpdater.checkForUpdates();
    const currentVersion = app.getVersion();
    const availableVersion = result?.updateInfo.version ?? null;
    return publishUpdateState({
      status:
        availableVersion && availableVersion !== currentVersion
          ? 'available'
          : 'up_to_date',
      availableVersion,
      message:
        availableVersion && availableVersion !== currentVersion
          ? deviceSettings.automaticUpdatesEnabled
            ? `Version ${availableVersion} is downloading in the background and will install when the app is closed.`
            : `Version ${availableVersion} is available. Automatic downloads are disabled in Settings.`
          : `You are running the latest configured version (${currentVersion}).`,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return publishUpdateState({
      status: 'error',
      availableVersion: null,
      message: error instanceof Error ? error.message : 'Update check failed.',
      checkedAt: new Date().toISOString(),
    });
  }
}

function startAutomaticUpdates(): void {
  if (!app.isPackaged) return;
  try {
    configureAutoUpdater(database.getDeviceSettings());
  } catch (error) {
    publishUpdateState({
      status: 'error',
      message: error instanceof Error ? error.message : 'Update setup failed.',
      checkedAt: new Date().toISOString(),
    });
  }
  updateInitialTimer = setTimeout(() => {
    void checkForUpdates(false);
  }, UPDATE_INITIAL_DELAY_MS);
  updateTimer = setInterval(() => {
    void checkForUpdates(false);
  }, UPDATE_INTERVAL_MS);
}

autoUpdater.on('checking-for-update', () => {
  publishUpdateState({
    status: 'checking',
    message: 'Checking for updates…',
  });
});
autoUpdater.on('update-available', (info) => {
  publishUpdateState({
    status: 'available',
    availableVersion: info.version,
    message: `Version ${info.version} is available and is downloading in the background.`,
    checkedAt: new Date().toISOString(),
  });
});
autoUpdater.on('update-not-available', () => {
  publishUpdateState({
    status: 'up_to_date',
    availableVersion: null,
    message: `You are running the latest configured version (${app.getVersion()}).`,
    checkedAt: new Date().toISOString(),
  });
});
autoUpdater.on('update-downloaded', (info) => {
  publishUpdateState({
    status: 'downloaded',
    availableVersion: info.version,
    message: `Version ${info.version} is ready and will install when the app is closed.`,
    checkedAt: new Date().toISOString(),
  });
});
autoUpdater.on('error', (error) => {
  publishUpdateState({
    status: 'error',
    availableVersion: null,
    message: error instanceof Error ? error.message : 'Update check failed.',
    checkedAt: new Date().toISOString(),
  });
});

/**
 * Electron safeStorage-backed secret store for the Supabase API key. When the OS
 * keychain is available the key is encrypted at rest; otherwise it is stored as
 * plaintext base64 and the UI warns that encryption is unavailable. The key is
 * never sent to the renderer (only a masked hint is).
 */
class ElectronSafeStorageSyncSecretStore implements SyncSecretStore {
  readonly available: boolean;
  constructor() {
    this.available = safeStorage.isEncryptionAvailable();
  }
  encrypt(plaintext: string): string {
    if (this.available) {
      return safeStorage.encryptString(plaintext).toString('base64');
    }
    return Buffer.from(plaintext, 'utf8').toString('base64');
  }
  decrypt(stored: string): string {
    const buffer = Buffer.from(stored, 'base64');
    if (this.available) {
      try {
        return safeStorage.decryptString(buffer);
      } catch {
        // Not a safeStorage blob (e.g. stored via the plaintext fallback) —
        // decode it as UTF-8 below.
      }
    }
    return buffer.toString('utf8');
  }
}

/** (Re)build the background sync engine from the persisted configuration. */
function recreateSyncEngine(): void {
  engine?.stop();
  engine = null;
  const config = database.getSyncConfigRecord();
  let transport: SupabaseTransport | AccountSupabaseTransport;
  if (cloudAccount?.isAccountSyncConfigured() && config.storeId) {
    const accountConfig = cloudAccount.getCachedSupabaseConfig();
    if (config.enabled && accountConfig) {
      // The account transport reads its token lazily on the first cycle.
      // Configuration is already cached in the main process.
      transport = new AccountSupabaseTransport({
        supabaseUrl: accountConfig.supabaseUrl,
        anonKey: accountConfig.supabaseAnonKey,
        deviceId: config.deviceId ?? '',
        getAccessToken: (force) => cloudAccount.getAccessToken(force),
      });
    } else {
      return;
    }
  } else {
    if (
      !config.enabled ||
      !config.storeId ||
      !config.supabaseUrl ||
      !config.apiKeySecret
    )
      return;
    const apiKey = secretStore.decrypt(config.apiKeySecret);
    transport = new SupabaseTransport({
      supabaseUrl: config.supabaseUrl,
      apiKey,
    });
  }
  engine = new SyncEngine(database, transport, {
    canSync: () => cloudAccount?.isSyncAllowed() ?? true,
  });
  engine.start();
}

async function configureAccountStore(storeId: string): Promise<void> {
  const local = database.getSyncConfigRecord();
  if (
    local.storeId &&
    local.storeId !== storeId &&
    database.hasPushedSyncEvents()
  )
    throw new Error(
      'This PC already contains data linked to a different cloud store.',
    );
  database.setCloudStoreId(storeId);
  database.ensureDeviceId();
  database.setSyncEnabled(true);
  const config = await cloudAccount.getSupabaseConfig();
  const transport = new AccountSupabaseTransport({
    supabaseUrl: config.supabaseUrl,
    anonKey: config.supabaseAnonKey,
    deviceId: database.ensureDeviceId(),
    getAccessToken: (force) => cloudAccount.getAccessToken(force),
  });
  const prefix = await transport.claimDevicePrefix(
    storeId,
    database.ensureDeviceId(),
  );
  database.validateReceiptPrefix(prefix);
  database.setDeviceReceiptPrefix(prefix);
  if (database.isRestoreAllowed())
    await restoreFromCloud(database, transport, storeId);
  recreateSyncEngine();
}
const idSchema = z.string().uuid();
function lanIpv4Addresses(): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter((entry) => !entry.internal && entry.family === 'IPv4')
        .map((entry) => entry.address),
    ),
  ];
}
const imageTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Shul Store Manager',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL;
    if (!developmentUrl || !url.startsWith(developmentUrl))
      event.preventDefault();
  });
  window.on('focus', () => void cloudAccount?.refresh());

  database.runStartupReconciliation().catch(console.error);

  if (process.env.VITE_DEV_SERVER_URL)
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else
    await window.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
}

import { initiateChargeInputSchema } from '@shul-store/shared';

function registerIpc(): void {
  ipcMain.handle('auth:getState', () => session.state);
  ipcMain.handle('auth:listAccounts', () => database.listStaffPickerAccounts());
  ipcMain.handle('auth:signIn', (_event, staffId, pin) => {
    return session.signIn(idSchema.parse(staffId), staffPinSchema.parse(pin));
  });
  ipcMain.handle('auth:signOut', () => session.signOut());
  ipcMain.handle('auth:touch', () => session.touch());
  ipcMain.handle('auth:elevate', (_event, permission, pin) => {
    session.elevate(
      grantablePermissionSchema.parse(permission),
      staffPinSchema.parse(pin),
    );
  });
  ipcMain.handle('auth:createFirstOwner', (_event, name, pin) => {
    const cleanPin = staffPinSchema.parse(pin);
    const owner = database.createFirstOwner(
      z.string().trim().min(1).max(200).parse(name),
      cleanPin,
    );
    session.signIn(owner.id, cleanPin);
    return owner;
  });
  ipcMain.handle('cloudAccount:getState', () => cloudAccount.getState());
  ipcMain.handle('cloudAccount:shouldShowOnboarding', () =>
    cloudAccount.shouldShowOnboarding(),
  );
  ipcMain.handle('cloudAccount:dismissOnboarding', () =>
    cloudAccount.dismissOnboarding(),
  );
  ipcMain.handle('cloudAccount:signIn', (_event, email, password) =>
    cloudAccount.signIn(
      z.string().trim().email().parse(email),
      z.string().min(1).max(500).parse(password),
    ),
  );
  ipcMain.handle('cloudAccount:signUp', (_event, email, password) =>
    cloudAccount.signUp(
      z.string().trim().email().parse(email),
      z.string().min(8).max(500).parse(password),
    ),
  );
  ipcMain.handle('cloudAccount:signOut', () => cloudAccount.signOut());
  ipcMain.handle('cloudAccount:refresh', () => cloudAccount.refresh());
  ipcMain.handle('cloudAccount:link', (_event, username, password) =>
    cloudAccount.link(
      z.string().trim().min(1).max(320).parse(username),
      z.string().min(1).max(500).parse(password),
    ),
  );
  ipcMain.handle('cloudAccount:linkHint', () => cloudAccount.linkHint());
  ipcMain.handle('cloudAccount:checkout', () => cloudAccount.checkout());
  ipcMain.handle('cloudAccount:portal', () => cloudAccount.portal());
  ipcMain.handle('staff:list', () => database.listStaffAccounts());
  ipcMain.handle('staff:create', (_event, input) =>
    database.createStaff(staffCreateInputSchema.parse(input)),
  );
  ipcMain.handle('staff:update', (_event, id, input) =>
    database.updateStaff(
      idSchema.parse(id),
      staffUpdateInputSchema.parse(input),
    ),
  );
  ipcMain.handle('staff:setPin', (_event, id, pin) =>
    database.setStaffPin(idSchema.parse(id), staffPinSchema.parse(pin)),
  );
  ipcMain.handle('staff:setIdleLock', (_event, minutes) => {
    const value = z.number().int().min(0).max(1440).parse(minutes);
    return database.setIdleLockMinutes(value);
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('updates:check', () => checkForUpdates(true));
  ipcMain.handle('updates:getState', () => ({
    ...updateState,
    currentVersion: app.getVersion(),
  }));
  ipcMain.handle('kiosk:getSettings', () => {
    const settings = database.getKioskServerSettings();
    return {
      ...settings,
      running: kioskServer?.isRunning() ?? false,
      addresses: lanIpv4Addresses(),
      kiosks: database.listKiosks(),
    };
  });
  ipcMain.handle('kiosk:pairCode', () => {
    if (!kioskServer) throw new Error('Enable Kiosk server first');
    return kioskServer.newPairingCode();
  });
  ipcMain.handle('kiosk:revoke', (_e, id) =>
    database.revokeKiosk(idSchema.parse(id)),
  );
  ipcMain.handle('kiosk:setServer', async (_e, enabled, port) => {
    const p = z.number().int().min(1).max(65535).parse(port);
    database.setKioskServerSettings(z.boolean().parse(enabled), p);
    if (enabled) {
      kioskServer ??= new KioskServer(database);
      if (kioskServer.isRunning() && kioskServer.port() !== p)
        await kioskServer.stop();
      await kioskServer.start(p);
      kioskReconcileTimer ??= setInterval(
        () => void database.runStartupReconciliation(),
        600000,
      );
    } else {
      await kioskServer?.stop();
      kioskServer = null;
      if (kioskReconcileTimer) clearInterval(kioskReconcileTimer);
      kioskReconcileTimer = null;
    }
  });
  // Payments — every integrated card charge goes through the shared payment service so the
  // manager and the LAN kiosk share one validation, snapshot, reservation, finalization and
  // reconciliation path.
  ipcMain.handle('payments:initiateCharge', async (_event, input) => {
    const value = initiateChargeInputSchema.parse(input);
    return database.payments.charge(
      {
        chargeReference: value.chargeReference,
        idempotencyKey: value.idempotencyKey,
        lines: value.lines,
      },
      { channel: 'manager', kioskId: null },
    );
  });

  ipcMain.handle(
    'payments:getChargeStatus',
    async (_event, chargeReference) => {
      const id = z.string().uuid().parse(chargeReference);
      return database.payments.reconcile(id);
    },
  );

  ipcMain.handle('payments:getPendingTransactions', () => {
    return database.getPendingPaymentTransactions();
  });

  ipcMain.handle('payments:reconcileTransactions', async () => {
    await database.runStartupReconciliation();
  });

  // Approved-but-unfinalizable charges that need an operator.
  ipcMain.handle('payments:listNeedsAttention', () =>
    database.payments.listNeedsAttention(),
  );
  ipcMain.handle(
    'payments:resolveNeedsAttention',
    (_event, chargeReference, action, note) =>
      database.payments.resolveNeedsAttention(
        z.string().uuid().parse(chargeReference),
        z.enum(['retry', 'void']).parse(action),
        z.string().trim().max(400).optional().parse(note),
      ),
  );

  // Categories
  ipcMain.handle('categories:list', (_event, includeInactive) =>
    database.listCategories(z.boolean().optional().parse(includeInactive)),
  );
  ipcMain.handle('categories:create', (_event, input) =>
    database.createCategory(categoryInputSchema.parse(input)),
  );
  ipcMain.handle('categories:update', (_event, id, input) =>
    database.updateCategory(
      idSchema.parse(id),
      categoryInputSchema.parse(input),
    ),
  );
  ipcMain.handle('categories:setActive', (_event, id, active) =>
    database.setCategoryActive(idSchema.parse(id), z.boolean().parse(active)),
  );

  // Products
  ipcMain.handle('products:list', (_event, includeInactive) =>
    database.listProducts(z.boolean().optional().parse(includeInactive)),
  );
  ipcMain.handle('products:create', (_event, input) =>
    database.createProduct(productInputSchema.parse(input)),
  );
  ipcMain.handle('products:update', (_event, id, input) =>
    database.updateProduct(idSchema.parse(id), productInputSchema.parse(input)),
  );
  ipcMain.handle('products:setActive', (_event, id, active) =>
    database.setProductActive(idSchema.parse(id), z.boolean().parse(active)),
  );
  ipcMain.handle('products:generateBarcode', () =>
    database.generateInternalBarcode(),
  );

  // Inventory
  ipcMain.handle('inventory:addMovement', (_event, input) =>
    database.addInventoryMovement(inventoryMovementInputSchema.parse(input)),
  );
  ipcMain.handle('inventory:list', (_event, productId) =>
    database.listInventoryMovements(idSchema.parse(productId)),
  );

  // Settings
  ipcMain.handle('settings:get', () => database.getSettings());
  ipcMain.handle('settings:update', (_event, input) => {
    return database.updateSettings(storeSettingsSchema.parse(input));
  });
  ipcMain.handle('settings:getDevice', () => database.getDeviceSettings());
  ipcMain.handle('settings:updateDevice', (_event, input) => {
    const updated = database.updateDeviceSettings(
      deviceSettingsSchema.parse(input),
    );
    if (app.isPackaged) configureAutoUpdater(updated);
    return updated;
  });
  ipcMain.handle('settings:setProcessorConfig', (_event, input) =>
    database.setCardProcessorConfigJson(
      processorConfigInputSchema.parse(input),
    ),
  );
  ipcMain.handle('settings:getProcessorConfigStatus', () =>
    database.getCardProcessorConfigStatus(),
  );
  ipcMain.handle('settings:listPrinters', (event) => listPrinters(event));

  ipcMain.handle('labels:render', (_event, input) =>
    buildLabelsHtml(labelPrintRequestSchema.parse(input)),
  );
  ipcMain.handle('labels:print', (_event, input) =>
    printLabels(labelPrintRequestSchema.parse(input)),
  );

  // Checkout
  ipcMain.handle('checkout:lookupBarcode', (_event, value) =>
    database.lookupProductByBarcode(
      z.string().trim().min(1).max(100).parse(value),
    ),
  );
  const checkoutBoundarySchema = completeSaleInputSchema.extend({
    payment: z.discriminatedUnion('method', [
      z.object({
        method: z.literal('cash'),
        cashReceivedCents: z.number().int().safe().nonnegative(),
      }),
      z.object({
        method: z.literal('external_terminal'),
        approved: z.literal(true),
        terminalReference: z.string().trim().max(100).nullable(),
      }),
      z.object({
        method: z.literal('account'),
        customerId: z.string().uuid(),
        confirmed: z.literal(true),
      }),
    ]),
  }) satisfies z.ZodType<
    Omit<CompleteSaleInput, 'payment'> & {
      payment: Exclude<
        CompleteSaleInput['payment'],
        { method: 'integrated_card' }
      >;
    }
  >;
  ipcMain.handle('checkout:complete', (_event, input) =>
    database.completeSale(checkoutBoundarySchema.parse(input)),
  );

  // Sales
  ipcMain.handle('sales:list', () => database.listSales());
  ipcMain.handle('sales:get', (_event, id) =>
    database.getSale(idSchema.parse(id)),
  );
  ipcMain.handle('sales:receipt', (_event, id) => ({
    sale: database.getSale(idSchema.parse(id)),
    settings: database.getSettings(),
  }));
  ipcMain.handle('sales:print', (_event, id) =>
    printReceipt(idSchema.parse(id)),
  );
  ipcMain.handle('sales:lookupReceiptBarcode', (_event, value) =>
    database.lookupReceiptBarcode(
      z.string().trim().min(1).max(200).parse(value),
    ),
  );
  ipcMain.handle('refunds:refundable', (_event, id) =>
    database.refundableSale(idSchema.parse(id)),
  );
  ipcMain.handle('refunds:record', (_event, input) =>
    database.payments.refund(recordRefundInputSchema.parse(input)),
  );
  ipcMain.handle('refunds:list', (_event, id) =>
    database.listRefunds(idSchema.parse(id)),
  );
  ipcMain.handle('refunds:print', (_event, id) =>
    printRefund(idSchema.parse(id)),
  );
  ipcMain.handle('refunds:listAttention', () =>
    database.payments.listRefundAttention(),
  );
  ipcMain.handle('refunds:resolveAttention', (_event, operationId) =>
    database.payments.resolveRefundAttention(
      z.string().uuid().parse(operationId),
    ),
  );

  // Customers
  ipcMain.handle('customers:list', (_event, includeInactive) =>
    database.listCustomers(z.boolean().optional().parse(includeInactive)),
  );
  ipcMain.handle('customers:get', (_event, id) =>
    database.getCustomer(idSchema.parse(id)),
  );
  ipcMain.handle('customers:search', (_event, query, includeInactive) =>
    database.searchCustomers(
      z.string().parse(query),
      z.boolean().optional().parse(includeInactive),
    ),
  );
  ipcMain.handle('customers:create', (_event, input) =>
    database.createCustomer(customerInputSchema.parse(input)),
  );
  ipcMain.handle('customers:update', (_event, id, input) =>
    database.updateCustomer(
      idSchema.parse(id),
      customerInputSchema.parse(input),
    ),
  );
  ipcMain.handle('customers:setActive', (_event, id, active) =>
    database.setCustomerActive(idSchema.parse(id), z.boolean().parse(active)),
  );
  ipcMain.handle('customers:setBlocked', (_event, id, blocked) =>
    database.setCustomerBlocked(idSchema.parse(id), z.boolean().parse(blocked)),
  );
  ipcMain.handle('customers:generateAccountNumber', () =>
    database.generateAccountNumber(),
  );
  ipcMain.handle('customers:generateBarcode', () =>
    database.generateCustomerBarcode(),
  );
  ipcMain.handle('customers:lookupBarcode', (_event, value) =>
    database.lookupCustomerByBarcodeOrAccount(
      z.string().trim().min(1).max(100).parse(value),
    ),
  );
  ipcMain.handle('customers:getLedger', (_event, customerId) =>
    database.listCustomerLedger(idSchema.parse(customerId)),
  );
  ipcMain.handle('customers:getStatement', (_event, customerId, options) =>
    database.getCustomerStatement(
      idSchema.parse(customerId),
      statementOptionsSchema.optional().parse(options),
    ),
  );
  ipcMain.handle('customers:printStatement', (_event, statementData) =>
    printStatement(customerStatementDataSchema.parse(statementData)),
  );

  // Account Payments
  ipcMain.handle('accountPayments:record', (_event, input) =>
    database.recordAccountPayment(recordAccountPaymentInputSchema.parse(input)),
  );
  ipcMain.handle('accountPayments:list', (_event, customerId) =>
    database.listAccountPayments(
      idSchema.optional().nullable().parse(customerId) ?? undefined,
    ),
  );
  ipcMain.handle('accountPayments:get', (_event, id) =>
    database.getAccountPayment(idSchema.parse(id)),
  );
  ipcMain.handle('accountPayments:receipt', (_event, id) => ({
    payment: database.getAccountPayment(idSchema.parse(id)),
    settings: database.getSettings(),
  }));
  ipcMain.handle('accountPayments:print', (_event, id) =>
    printAccountPayment(idSchema.parse(id)),
  );

  // Images
  ipcMain.handle('images:choose', chooseImage);
  ipcMain.handle('images:discard', async (_event, rawId) => {
    const id = idSchema.parse(rawId);
    const relativePath = database.removeImageIfUnreferenced(id);
    if (!relativePath || path.basename(relativePath) !== relativePath)
      return false;
    await unlink(
      path.join(app.getPath('userData'), 'images', relativePath),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return true;
  });

  // Cloud sync (optional Supabase backup). All network activity happens here in
  // the main process; the renderer only ever sees sanitised status and a masked
  // key hint — never the API key itself.
  ipcMain.handle('sync:getConfig', () => {
    const config = database.getSyncConfigRecord();
    let hint: string | null = null;
    if (config.apiKeySecret) {
      try {
        hint = maskApiKey(secretStore.decrypt(config.apiKeySecret));
      } catch {
        hint = null;
      }
    }
    return database.getSyncConfigView(hint);
  });

  ipcMain.handle('sync:getStatus', () => database.getSyncStatus());

  ipcMain.handle('sync:isRestoreAvailable', () => database.isRestoreAllowed());

  ipcMain.handle('sync:saveConfig', (_event, input) => {
    const value = syncConfigInputSchema.parse(input);
    database.ensureStoreId();
    const apiKeySecret = secretStore.encrypt(value.apiKey);
    database.applySyncCredentials({
      enabled: value.enabled,
      supabaseUrl: value.supabaseUrl,
      apiKeySecret,
      apiKeyEncrypted: secretStore.available,
    });
    if (value.enabled && database.needsBackfill()) {
      database.backfillOutbox();
    }
    recreateSyncEngine();
    return database.getSyncConfigView(maskApiKey(value.apiKey));
  });

  ipcMain.handle('sync:setEnabled', (_event, enabled) => {
    database.setSyncEnabled(z.boolean().parse(enabled));
    recreateSyncEngine();
    return database.getSyncStatus();
  });

  ipcMain.handle('sync:testConnection', async (_event, input) => {
    const value = syncConfigInputSchema.parse(input);
    const transport = new SupabaseTransport({
      supabaseUrl: value.supabaseUrl,
      apiKey: value.apiKey,
    });
    return transport.testConnection();
  });

  ipcMain.handle('sync:syncNow', async () => {
    if (!engine) {
      return {
        pushed: 0,
        remaining: database.pendingSyncEventCount(),
        error: 'Cloud backup is not enabled.',
        skipped: false,
      };
    }
    const result = await engine.syncNow();
    return {
      pushed: result.pushed,
      remaining: result.remaining,
      error: result.error,
      skipped: result.skipped,
    };
  });

  ipcMain.handle('sync:restore', async (_event, input) => {
    const value = restoreInputSchema.parse(input);
    if (!database.isRestoreAllowed()) {
      return {
        ok: false,
        message:
          'Restore from cloud is only available on a fresh installation with no local business data.',
        summary: null,
      };
    }
    const transport = new SupabaseTransport({
      supabaseUrl: value.supabaseUrl,
      apiKey: value.apiKey,
    });
    const result = await restoreFromCloud(database, transport, value.storeId);
    if (result.ok) {
      // The restored device adopts the source store id and credentials so it
      // resumes pushing new changes from the restored sequence.
      const apiKeySecret = secretStore.encrypt(value.apiKey);
      database.applySyncCredentials({
        enabled: true,
        supabaseUrl: value.supabaseUrl,
        apiKeySecret,
        apiKeyEncrypted: secretStore.available,
      });
      database.connection
        .prepare('UPDATE sync_settings SET store_id = ? WHERE singleton_id = 1')
        .run(value.storeId);
      database.markBackfillCompleted();
      recreateSyncEngine();
    }
    return result;
  });
  ipcMain.handle('backups:list', () => database.listBackups());
  ipcMain.handle('backups:create', () => database.createBackup('manual'));
  ipcMain.handle('backups:getLastRestoreResult', () =>
    database.getLastRestoreResult(),
  );
  ipcMain.handle('backups:revealFolder', () => {
    void shell.openPath(backupDirectory);
  });
  ipcMain.handle(
    'backups:restore',
    async (_event, filename: unknown, confirmation: unknown) => {
      const selected = z.string().max(200).parse(filename);
      if (!parseBackupName(selected)) throw new Error('Invalid backup name.');
      const expectedConfirmation = `RESTORE ${selected}`;
      if (confirmation !== expectedConfirmation)
        throw new Error(`Type "${expectedConfirmation}" to confirm restore.`);
      const available = database
        .listBackups()
        .find(
          (backup) =>
            backup.filename === selected && backup.ok && backup.available,
        );
      if (!available) throw new Error('That backup is not available.');

      const safety = database.createBackup('prerestore');
      if (!safety.ok)
        throw new Error(`Pre-restore backup failed: ${safety.message}`);
      const temporary = `${databasePath}.restore-${randomUUID()}`;
      await copyFile(path.join(backupDirectory, selected), temporary);
      database.close();
      try {
        for (const staleFile of [
          `${databasePath}-wal`,
          `${databasePath}-shm`,
        ]) {
          try {
            await unlink(staleFile);
          } catch (error) {
            if (!(
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ENOENT'
            ))
              throw error;
          }
        }
        await rename(temporary, databasePath);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        database = new StoreDatabase(databasePath, secretStore, {
          backupDirectory,
          imageDirectory,
        });
        session.replaceDatabase(database);
        throw error;
      }
      const imageResult = restoreImagesFromVault(
        databasePath,
        backupDirectory,
        imageDirectory,
      );
      database = new StoreDatabase(databasePath, secretStore, {
        backupDirectory,
        imageDirectory,
      });
      session.replaceDatabase(database);
      database.recordRestoreResult({
        completedAt: new Date().toISOString(),
        filename: selected,
        imagesRestored: imageResult.imagesRestored,
        imagesMissing: imageResult.imagesMissing,
        message:
          imageResult.imagesMissing > 0
            ? `${imageResult.imagesMissing} image(s) could not be restored from the backup vault.`
            : 'All images referenced by the restored database are available.',
      });
      app.relaunch();
      app.exit(0);
    },
  );
  ipcMain.handle('reports:daily', (_event, input) => {
    const value = dailyReportInputSchema.parse(input);
    businessDayRange(value.businessDate);
    return database.dailyReport(value.businessDate, value.openingFloatCents);
  });
  ipcMain.handle('reports:close', (_event, input) => {
    const value = dailyCloseInputSchema.parse(input);
    businessDayRange(value.businessDate);
    return database.recordDailyClose(
      value.businessDate,
      value.openingFloatCents,
      value.countedCashCents,
      value.notes,
    );
  });
  ipcMain.handle('reports:listCloses', (_event, limit) =>
    database.listDailyCloses(
      z.number().int().min(1).max(100).optional().parse(limit),
    ),
  );
  ipcMain.handle('reports:print', (_event, input) => {
    const value = dailyReportPrintInputSchema.parse(input);
    businessDayRange(value.businessDate);
    const settings = database.getSettings();
    return printHtmlDocument(
      dailyReportHtml({
        businessDate: value.businessDate,
        report: value.report,
        storeName: settings.storeName,
      }),
      settings.receiptPrinterName,
    );
  });
}

function buildLabelsHtml(request: LabelPrintRequest): string {
  const products = new Map(
    database.listProducts(true).map((product) => [product.id, product]),
  );
  const settings = database.getSettings();
  const items = request.items.map((item) => {
    const product = products.get(item.productId);
    if (!product) {
      throw new Error('Product not found.');
    }
    const barcode = product.barcodes.find(
      (entry) => entry.value.toLowerCase() === item.barcode.toLowerCase(),
    );
    if (!barcode) {
      throw new Error(
        `Barcode ${item.barcode} does not belong to ${product.name}.`,
      );
    }
    return {
      name: product.name,
      secondaryName: product.secondaryName,
      sellingPriceCents: product.sellingPriceCents,
      barcode: barcode.value,
      quantity: item.quantity,
    };
  });
  return labelsHtml({
    items,
    storeName: settings.storeName,
    template: request.template,
  });
}

async function listPrinters(
  event: Electron.IpcMainInvokeEvent,
): Promise<PrinterInfo[]> {
  const contents =
    BrowserWindow.fromWebContents(event.sender)?.webContents ?? event.sender;
  const printers = await contents.getPrintersAsync();
  return printers.map((printer) => {
    const extra = printer as Electron.PrinterInfo & {
      status?: number;
      isDefault?: boolean;
      options?: Record<string, string>;
    };
    return {
      name: printer.name,
      displayName: printer.displayName,
      description: printer.description,
      status: extra.status ?? 0,
      isDefault:
        extra.isDefault ?? extra.options?.['printer-is-default'] === 'true',
    };
  });
}

function invokePrint(
  contents: Electron.WebContents,
  options: Electron.WebContentsPrintOptions,
): Promise<{ success: boolean; error: string | null }> {
  return new Promise((resolve) => {
    contents.print(options, (success, failureReason) =>
      resolve({
        success,
        error: success
          ? null
          : failureReason || 'Printing was canceled or failed.',
      }),
    );
  });
}

async function printHtmlDocument(
  html: string,
  deviceName: string | null,
): Promise<PrintResult> {
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  try {
    await printWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );

    let fallbackReason: string | null = null;
    if (deviceName) {
      try {
        const printers = await printWindow.webContents.getPrintersAsync();
        const found = printers.some((printer) => printer.name === deviceName);
        if (!found) {
          fallbackReason = `Configured printer "${deviceName}" was not found. Opening the system print dialog.`;
        } else {
          const silent = await invokePrint(printWindow.webContents, {
            silent: true,
            deviceName,
            printBackground: true,
          });
          if (silent.success) {
            return { success: true, error: null, fallbackReason: null };
          }
          fallbackReason = `Silent printing to "${deviceName}" failed${silent.error ? `: ${silent.error}` : ''}. Opening the system print dialog.`;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Printer lookup failed';
        fallbackReason = `Could not use the configured printer "${deviceName}" (${message}). Opening the system print dialog.`;
      }
    }

    const dialogResult = await invokePrint(printWindow.webContents, {
      silent: false,
      printBackground: true,
    });
    if (dialogResult.success) {
      return { success: true, error: null, fallbackReason };
    }
    return {
      success: false,
      error: fallbackReason
        ? `${fallbackReason} ${dialogResult.error ?? ''}`.trim()
        : dialogResult.error,
      fallbackReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Printing failed';
    return { success: false, error: message, fallbackReason: null };
  } finally {
    printWindow.destroy();
  }
}

async function printReceipt(saleId: string): Promise<PrintResult> {
  const data: ReceiptData = {
    sale: database.getSale(saleId),
    settings: database.getSettings(),
  };
  const result = await printHtmlDocument(
    receiptHtml(data),
    data.settings.receiptPrinterName,
  );
  database.recordPrintAttempt(saleId, result.success, result.error);
  return result;
}

async function printAccountPayment(paymentId: string): Promise<PrintResult> {
  const data: AccountPaymentReceiptData = {
    payment: database.getAccountPayment(paymentId),
    settings: database.getSettings(),
  };
  const result = await printHtmlDocument(
    accountPaymentReceiptHtml(data),
    data.settings.receiptPrinterName,
  );
  database.recordAccountPaymentPrintAttempt(
    paymentId,
    result.success,
    result.error,
  );
  return result;
}

async function printRefund(refundId: string): Promise<PrintResult> {
  const refund = database.getRefund(refundId);
  if (!refund) throw new Error('Refund not found');
  const settings = database.getSettings();
  const result = await printHtmlDocument(
    refundReceiptHtml({ refund, storeName: settings.storeName, settings }),
    settings.receiptPrinterName,
  );
  return result;
}

async function printStatement(
  data: CustomerStatementData,
): Promise<PrintResult> {
  return printHtmlDocument(
    statementHtml(data),
    database.getSettings().receiptPrinterName,
  );
}

async function printLabels(request: LabelPrintRequest): Promise<PrintResult> {
  return printHtmlDocument(
    buildLabelsHtml(request),
    database.getSettings().labelPrinterName,
  );
}

async function chooseImage() {
  const selection = await dialog.showOpenDialog({
    title: 'Choose product or category image',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
    ],
  });
  const source = selection.filePaths[0];
  if (selection.canceled || !source) return null;
  const extension = path.extname(source).toLowerCase();
  const mimeType = imageTypes[extension];
  if (!mimeType)
    throw new Error('Please choose a JPG, PNG, WebP, or GIF image.');
  const info = await stat(source);
  if (info.size > 10 * 1024 * 1024)
    throw new Error('Images must be smaller than 10 MB.');

  const id = randomUUID();
  const relativePath = `${id}${extension}`;
  const destination = path.join(imageDirectory, relativePath);
  await mkdir(imageDirectory, { recursive: true });
  await copyFile(source, destination);
  try {
    const digest = createHash('sha256')
      .update(await readFile(destination))
      .digest('hex');
    database.registerImage({
      id,
      relativePath,
      originalName: path.basename(source),
      mimeType,
      byteSize: info.size,
      sha256: digest,
    });
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
  return {
    id,
    url: `store-image://local/${id}`,
    originalName: path.basename(source),
    mimeType,
  };
}

app.whenReady().then(async () => {
  const dataDirectory = app.getPath('userData');
  await mkdir(dataDirectory, { recursive: true });
  backupDirectory = path.join(dataDirectory, 'backups');
  imageDirectory = path.join(dataDirectory, 'images');
  databasePath = path.join(dataDirectory, 'shul-store.sqlite');
  secretStore = new ElectronSafeStorageSyncSecretStore();
  cloudAccount = new CloudAccountManager(
    path.join(dataDirectory, 'cloud-account.json'),
    secretStore,
    globalThis.fetch,
    async (url) => {
      await shell.openExternal(url);
    },
    () => {
      if (!database) return false;
      const config = database.getSyncConfigRecord();
      return Boolean(
        config.enabled && config.supabaseUrl && config.apiKeySecret,
      );
    },
    {
      getLocalStoreIdentity: () => {
        const config = database.getSyncConfigRecord();
        return {
          storeId: config.storeId,
          hasPushedEvents: database.hasPushedSyncEvents(),
        };
      },
      onStoreIdentity: configureAccountStore,
    },
  );
  cloudAccount.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send('cloudAccount:state', state);
    }
    const syncAllowed = state.entitlement?.active === true;
    if (syncAllowed && !cloudWasSyncAllowed) void engine?.syncNow();
    cloudWasSyncAllowed = syncAllowed;
  });
  await cloudAccount.load();
  database = new StoreDatabase(databasePath, secretStore, {
    backupDirectory,
    imageDirectory,
  });
  const savedStoreId = await cloudAccount.getStoreId();
  if (savedStoreId && (await cloudAccount.getState()).signedIn) {
    void configureAccountStore(savedStoreId).catch(() => undefined);
  }
  session = new ManagerSession(database, () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send('auth:state', session.state);
    }
  });
  idleTimer = setInterval(() => {
    if (session.checkIdle()) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('auth:locked');
      }
    }
  }, 1000);
  registerIpc();
  const newestScheduled = () =>
    database
      .listBackups()
      .filter(
        (backup) =>
          backup.kind === 'scheduled' && backup.ok && backup.available,
      )
      .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))[0];
  const scheduledBackupDue = () => {
    const latest = newestScheduled();
    return (
      !latest ||
      Date.now() - Date.parse(latest.attemptedAt) >= SCHEDULED_BACKUP_MAX_AGE_MS
    );
  };
  const runScheduledBackup = () => {
    if (scheduledBackupDue()) database.createBackup('scheduled');
  };
  runScheduledBackup();
  backupTimer = setInterval(runScheduledBackup, SCHEDULED_BACKUP_INTERVAL_MS);
  const kioskConfig = database.getKioskServerSettings();
  if (kioskConfig.enabled) {
    kioskServer = new KioskServer(database);
    await kioskServer.start(kioskConfig.port);
    kioskReconcileTimer = setInterval(
      () => void database.runStartupReconciliation(),
      600000,
    );
  }
  // Start the background sync loop immediately if cloud backup is enabled.
  recreateSyncEngine();
  protocol.handle('store-image', (request) => {
    const imageId = idSchema.safeParse(new URL(request.url).pathname.slice(1));
    if (!imageId.success) return new Response('Not found', { status: 404 });
    const relativePath = database.getImagePath(imageId.data);
    if (!relativePath || path.basename(relativePath) !== relativePath)
      return new Response('Not found', { status: 404 });
    return net.fetch(
      pathToFileURL(
        path.join(dataDirectory, 'images', relativePath),
      ).toString(),
    );
  });
  await createWindow();
  startAutomaticUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  engine?.stop();
  if (idleTimer) clearInterval(idleTimer);
  if (database) {
    try {
      const latest = database
        .listBackups()
        .filter(
          (backup) =>
            backup.kind === 'scheduled' && backup.ok && backup.available,
        )
        .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))[0];
      if (
        !latest ||
        new Date(latest.attemptedAt).toDateString() !==
          new Date().toDateString()
      )
        database.createBackup('scheduled');
    } catch {
      // Quitting must remain best-effort even if the backup cannot run.
    }
  }
  if (backupTimer) clearInterval(backupTimer);
  if (updateInitialTimer) clearTimeout(updateInitialTimer);
  if (updateTimer) clearInterval(updateTimer);
});
app.on('will-quit', () => {
  database?.close();
});
