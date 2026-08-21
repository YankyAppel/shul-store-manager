import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { z } from 'zod';
import { StoreDatabase } from '@shul-store/database';
import {
  accountPaymentReceiptHtml,
  categoryInputSchema,
  completeSaleInputSchema,
  customerInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
  receiptHtml,
  recordAccountPaymentInputSchema,
  statementHtml,
  statementOptionsSchema,
  storeSettingsSchema,
  type AccountPaymentReceiptData,
  type ReceiptData,
} from '@shul-store/shared';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'store-image',
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
]);

let database: StoreDatabase;
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
      preload: path.join(import.meta.dirname, 'preload.js'),
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

  if (process.env.VITE_DEV_SERVER_URL)
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else
    await window.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
}

function registerIpc(): void {
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
  ipcMain.handle('customers:printStatement', (_event, customerId, options) =>
    printStatement(
      idSchema.parse(customerId),
      statementOptionsSchema.optional().parse(options),
    ),
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
}

async function printReceipt(
  saleId: string,
): Promise<{ success: boolean; error: string | null }> {
  const data: ReceiptData = {
    sale: database.getSale(saleId),
    settings: database.getSettings(),
  };
  const receiptWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await receiptWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(receiptHtml(data))}`,
    );
    const result = await new Promise<{
      success: boolean;
      error: string | null;
    }>((resolve) => {
      receiptWindow.webContents.print(
        { silent: false, printBackground: true },
        (success, failureReason) =>
          resolve({
            success,
            error: success
              ? null
              : failureReason || 'Printing was canceled or failed.',
          }),
      );
    });
    database.recordPrintAttempt(saleId, result.success, result.error);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Printing failed';
    database.recordPrintAttempt(saleId, false, message);
    return { success: false, error: message };
  } finally {
    receiptWindow.destroy();
  }
}

async function printAccountPayment(
  paymentId: string,
): Promise<{ success: boolean; error: string | null }> {
  const data: AccountPaymentReceiptData = {
    payment: database.getAccountPayment(paymentId),
    settings: database.getSettings(),
  };
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await printWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(accountPaymentReceiptHtml(data))}`,
    );
    const result = await new Promise<{
      success: boolean;
      error: string | null;
    }>((resolve) => {
      printWindow.webContents.print(
        { silent: false, printBackground: true },
        (success, failureReason) =>
          resolve({
            success,
            error: success
              ? null
              : failureReason || 'Printing was canceled or failed.',
          }),
      );
    });
    database.recordAccountPaymentPrintAttempt(
      paymentId,
      result.success,
      result.error,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Printing failed';
    database.recordAccountPaymentPrintAttempt(paymentId, false, message);
    return { success: false, error: message };
  } finally {
    printWindow.destroy();
  }
}

async function printStatement(
  customerId: string,
  options?: any,
): Promise<{ success: boolean; error: string | null }> {
  const data = database.getCustomerStatement(customerId, options);
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await printWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(statementHtml(data))}`,
    );
    const result = await new Promise<{
      success: boolean;
      error: string | null;
    }>((resolve) => {
      printWindow.webContents.print(
        { silent: false, printBackground: true },
        (success, failureReason) =>
          resolve({
            success,
            error: success
              ? null
              : failureReason || 'Printing was canceled or failed.',
          }),
      );
    });
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Statement printing failed';
    return { success: false, error: message };
  } finally {
    printWindow.destroy();
  }
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
app.on('before-quit', () => database?.close());
