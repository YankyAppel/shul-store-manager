import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
} from 'electron';
import { z } from 'zod';
import { StoreDatabase } from '@shul-store/database';
import {
  accountPaymentReceiptHtml,
  categoryInputSchema,
  completeSaleInputSchema,
  customerInputSchema,
  customerStatementDataSchema,
  inventoryMovementInputSchema,
  labelPrintRequestSchema,
  labelsHtml,
  productInputSchema,
  receiptHtml,
  recordAccountPaymentInputSchema,
  statementHtml,
  statementOptionsSchema,
  storeSettingsSchema,
  type AccountPaymentReceiptData,
  type CustomerStatementData,
  type LabelPrintRequest,
  type PrinterInfo,
  type PrintResult,
  type ReceiptData,
} from '@shul-store/shared';
import {
  maskApiKey,
  PlaintextSyncSecretStore,
  restoreFromCloud,
  SupabaseTransport,
  SyncEngine,
  type SyncSecretStore,
} from '@shul-store/sync';
import { restoreInputSchema, syncConfigInputSchema } from '@shul-store/shared';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'store-image',
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
]);

let database: StoreDatabase;
let engine: SyncEngine | null = null;
let secretStore: SyncSecretStore = new PlaintextSyncSecretStore();

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
  if (
    !config.enabled ||
    !config.storeId ||
    !config.supabaseUrl ||
    !config.apiKeySecret
  ) {
    return;
  }
  const apiKey = secretStore.decrypt(config.apiKeySecret);
  const transport = new SupabaseTransport({
    supabaseUrl: config.supabaseUrl,
    apiKey,
  });
  engine = new SyncEngine(database, transport);
  engine.start();
}
const idSchema = z.string().uuid();
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

  database.runStartupReconciliation().catch(console.error);

  if (process.env.VITE_DEV_SERVER_URL)
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else
    await window.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
}

import { processors } from '@shul-store/payments';
import {
  initiateChargeInputSchema,
  calculateCart,
  errorMessage,
} from '@shul-store/shared';

function registerIpc(): void {
  // Payments
  ipcMain.handle('payments:initiateCharge', async (_event, input) => {
    const value = initiateChargeInputSchema.parse(input);
    const settings = database.getSettings();
    if (!settings.cardProcessingEnabled || !settings.cardProcessorId) {
      throw new Error('Card processing is not enabled');
    }

    const calculated = calculateCart(
      value.lines.map((l) => ({
        product: database.getProduct(l.productId),
        quantity: l.quantity,
      })),
      settings,
    );

    if (calculated.totalCents <= 0)
      throw new Error('Cannot process $0.00 charge');

    const cartSnapshotJson = JSON.stringify({
      lines: value.lines.map((l, i) => {
        const product = database.getProduct(l.productId);
        const calcLine = calculated.lines[i]!;
        return {
          productId: l.productId,
          quantity: l.quantity,
          barcodeUsed: l.barcodeUsed,
          productName: product.name,
          secondaryName: product.secondaryName,
          unitSellingPriceCents: product.sellingPriceCents,
          unitPurchaseCostCents: product.purchaseCostCents,
          taxable: product.taxable,
          unitPriceCents: calcLine.unitPriceCents,
          subtotalCents: calcLine.subtotalCents,
          taxCents: calcLine.taxCents,
          totalCents: calcLine.totalCents,
        };
      }),
      totals: {
        subtotalCents: calculated.subtotalCents,
        taxCents: calculated.taxCents,
        totalCents: calculated.totalCents,
      },
    });

    database.createPaymentTransaction(
      value.chargeReference,
      settings.cardProcessorId,
      calculated.totalCents,
      cartSnapshotJson,
      value.idempotencyKey,
    );

    try {
      const processor = processors.find(
        (p) => p.id === settings.cardProcessorId,
      );
      if (!processor) throw new Error('Processor not found');

      let config = {};
      if (settings.cardProcessorConfigJson && processor.configSchema) {
        try {
          config = processor.configSchema.parse(
            JSON.parse(settings.cardProcessorConfigJson),
          );
        } catch {
          throw new Error('Invalid processor configuration');
        }
      }

      const result = await processor.createCharge(
        {
          chargeReference: value.chargeReference,
          amountCents: calculated.totalCents,
        },
        config,
        database.getProcessorStorage(),
      );

      database.updatePaymentTransactionStatus(
        value.chargeReference,
        result.status === 'pending' ? 'unknown' : result.status,
        result.processorTransactionId,
        result.cardBrand,
        result.cardLast4,
      );

      return result;
    } catch (e: unknown) {
      database.updatePaymentTransactionStatus(value.chargeReference, 'unknown');
      return { status: 'unknown', errorMessage: errorMessage(e) };
    }
  });

  ipcMain.handle(
    'payments:getChargeStatus',
    async (_event, chargeReference) => {
      const id = z.string().uuid().parse(chargeReference);
      const settings = database.getSettings();
      const processor = processors.find(
        (p) => p.id === settings.cardProcessorId,
      );
      if (!processor) throw new Error('Processor not found');

      try {
        let config = {};
        if (settings.cardProcessorConfigJson && processor.configSchema) {
          try {
            config = processor.configSchema.parse(
              JSON.parse(settings.cardProcessorConfigJson),
            );
          } catch {
            throw new Error('Invalid processor configuration');
          }
        }

        const result = await processor.getChargeStatus(
          id,
          config,
          database.getProcessorStorage(),
        );
        database.updatePaymentTransactionStatus(
          id,
          result.status === 'pending' ? 'unknown' : result.status,
          result.processorTransactionId,
          result.cardBrand,
          result.cardLast4,
        );
        return result;
      } catch (e: unknown) {
        return { status: 'error', errorMessage: errorMessage(e) };
      }
    },
  );

  ipcMain.handle('payments:getPendingTransactions', () => {
    return database.getPendingPaymentTransactions();
  });

  ipcMain.handle('payments:reconcileTransactions', async () => {
    
    await database.runStartupReconciliation();
  });

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
  ipcMain.handle('settings:update', (_event, input) =>
    database.updateSettings(storeSettingsSchema.parse(input)),
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
  ipcMain.handle('checkout:complete', (_event, input) =>
    database.completeSale(completeSaleInputSchema.parse(input)),
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
  const imageDirectory = path.join(app.getPath('userData'), 'images');
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
  database = new StoreDatabase(path.join(dataDirectory, 'shul-store.sqlite'));
  registerIpc();
  secretStore = new ElectronSafeStorageSyncSecretStore();
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  engine?.stop();
  database?.close();
});
