import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { z } from 'zod';
import { StoreDatabase } from '@shul-store/database';
import {
  categoryInputSchema,
  completeSaleInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
  storeSettingsSchema,
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

  ipcMain.handle('inventory:addMovement', (_event, input) =>
    database.addInventoryMovement(inventoryMovementInputSchema.parse(input)),
  );
  ipcMain.handle('inventory:list', (_event, productId) =>
    database.listInventoryMovements(idSchema.parse(productId)),
  );
  ipcMain.handle('settings:get', () => database.getSettings());
  ipcMain.handle('settings:update', (_event, input) =>
    database.updateSettings(storeSettingsSchema.parse(input)),
  );
  ipcMain.handle('checkout:lookupBarcode', (_event, value) =>
    database.lookupProductByBarcode(
      z.string().trim().min(1).max(100).parse(value),
    ),
  );
  ipcMain.handle('checkout:complete', (_event, input) =>
    database.completeSale(completeSaleInputSchema.parse(input)),
  );
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

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function receiptHtml({ sale, settings }: ReceiptData): string {
  const rows = sale.items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.productName)} × ${item.quantity}</td><td>$${(item.lineTotalCents / 100).toFixed(2)}</td></tr>`,
    )
    .join('');
  const payment =
    sale.payment.method === 'cash'
      ? `Cash $${((sale.payment.cashReceivedCents ?? 0) / 100).toFixed(2)} · Change $${((sale.payment.changeDueCents ?? 0) / 100).toFixed(2)}`
      : `External terminal${sale.payment.terminalReference ? ` · Ref ${escapeHtml(sale.payment.terminalReference)}` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;max-width:360px;margin:auto;padding:20px}h1{text-align:center}table{width:100%}td:last-child{text-align:right}.totals{border-top:1px solid;margin-top:12px;padding-top:8px}.footer{text-align:center;margin-top:20px;white-space:pre-line}</style></head><body><h1>${escapeHtml(settings.storeName)}</h1>${settings.contactLines.map((line) => `<div style="text-align:center">${escapeHtml(line)}</div>`).join('')}<p>Receipt #${sale.receiptNumber}<br>${escapeHtml(new Date(sale.completedAt ?? sale.createdAt).toLocaleString())}</p><table>${rows}</table><div class="totals">Subtotal: $${(sale.subtotalCents / 100).toFixed(2)}<br>Tax: $${(sale.taxCents / 100).toFixed(2)}<br><b>Total: $${(sale.totalCents / 100).toFixed(2)}</b><br>${payment}</div><div class="footer">${escapeHtml(settings.receiptFooter)}</div></body></html>`;
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
