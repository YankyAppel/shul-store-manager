import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { z } from 'zod';
import { StoreDatabase } from '@shul-store/database';
import {
  categoryInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
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
  ipcMain.handle('images:choose', chooseImage);
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
