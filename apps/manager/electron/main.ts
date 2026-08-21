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
  customerInputSchema,
  inventoryMovementInputSchema,
  productInputSchema,
  recordAccountPaymentInputSchema,
  statementOptionsSchema,
  storeSettingsSchema,
  type AccountPaymentReceiptData,
  type CustomerStatementData,
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

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function receiptHtml({ sale, settings }: ReceiptData): string {
  const rows = sale.items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.productName)} × ${item.quantity}</td><td>${formatCents(item.lineTotalCents)}</td></tr>`,
    )
    .join('');

  let paymentDetails = '';
  if (sale.payment.method === 'cash') {
    paymentDetails = `Cash ${formatCents(sale.payment.cashReceivedCents ?? 0)} · Change ${formatCents(sale.payment.changeDueCents ?? 0)}`;
  } else if (sale.payment.method === 'external_terminal') {
    paymentDetails = `External terminal${sale.payment.terminalReference ? ` · Ref ${escapeHtml(sale.payment.terminalReference)}` : ''}`;
  } else if (sale.payment.method === 'account') {
    const prev = sale.payment.previousBalanceCents ?? 0;
    const next = sale.payment.newBalanceCents ?? prev + sale.totalCents;
    paymentDetails = `<b>Charged to Account</b><br>Customer: ${escapeHtml(sale.payment.customerName ?? '')} (${escapeHtml(sale.payment.accountNumber ?? '')})<br>Previous balance: ${formatCents(prev)}<br>This purchase: ${formatCents(sale.totalCents)}<br><b>New balance: ${formatCents(next)}</b>`;
  }

  const customerHeader =
    sale.payment.method === 'account'
      ? `<div style="text-align:center;margin:6px 0;font-size:13px"><b>Customer:</b> ${escapeHtml(sale.payment.customerName ?? '')} (Acct #${escapeHtml(sale.payment.accountNumber ?? '')})</div>`
      : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body{font:14px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;max-width:360px;margin:auto;padding:20px;color:#111}
    h1{text-align:center;margin:0 0 6px 0;font-size:18px}
    table{width:100%;border-collapse:collapse;margin:12px 0}
    td{padding:3px 0}
    td:last-child{text-align:right}
    .totals{border-top:1px dashed #666;margin-top:10px;padding-top:8px;line-height:1.5}
    .footer{text-align:center;margin-top:20px;white-space:pre-line;font-size:12px;color:#555}
  </style>
</head>
<body>
  <h1>${escapeHtml(settings.storeName)}</h1>
  ${settings.contactLines.map((line) => `<div style="text-align:center;font-size:12px">${escapeHtml(line)}</div>`).join('')}
  <p style="margin:10px 0 6px;font-size:12px">Receipt #${sale.receiptNumber}<br>${escapeHtml(new Date(sale.completedAt ?? sale.createdAt).toLocaleString())}</p>
  ${customerHeader}
  <table>${rows}</table>
  <div class="totals">
    Subtotal: ${formatCents(sale.subtotalCents)}<br>
    Tax: ${formatCents(sale.taxCents)}<br>
    <b>Total: ${formatCents(sale.totalCents)}</b>
    <hr style="border:none;border-top:1px dotted #aaa;margin:8px 0">
    ${paymentDetails}
  </div>
  ${settings.receiptFooter ? `<div class="footer">${escapeHtml(settings.receiptFooter)}</div>` : ''}
</body>
</html>`;
}

function accountPaymentReceiptHtml({
  payment,
  settings,
}: AccountPaymentReceiptData): string {
  const methodText =
    payment.method === 'cash'
      ? `Cash: ${formatCents(payment.cashReceivedCents ?? payment.amountCents)} · Change: ${formatCents(payment.changeDueCents ?? 0)}`
      : `External terminal${payment.terminalReference ? ` (Ref: ${escapeHtml(payment.terminalReference)})` : ''}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body{font:14px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;max-width:360px;margin:auto;padding:20px;color:#111}
    h1{text-align:center;margin:0 0 6px 0;font-size:18px}
    .payment-box{border:1px solid #333;border-radius:4px;padding:12px;margin:12px 0;background:#fafafa}
    .totals{line-height:1.6}
    .footer{text-align:center;margin-top:20px;white-space:pre-line;font-size:12px;color:#555}
  </style>
</head>
<body>
  <h1>${escapeHtml(settings.storeName)}</h1>
  ${settings.contactLines.map((line) => `<div style="text-align:center;font-size:12px">${escapeHtml(line)}</div>`).join('')}
  <div style="text-align:center;margin:10px 0;font-size:15px"><b>Account Payment Receipt #${payment.receiptNumber}</b></div>
  <div style="font-size:12px;margin-bottom:10px;text-align:center">${escapeHtml(new Date(payment.createdAt).toLocaleString())}</div>
  
  <div class="payment-box">
    <div><b>Customer:</b> ${escapeHtml(payment.customerName)}</div>
    <div><b>Account #:</b> ${escapeHtml(payment.accountNumber)}</div>
    ${payment.notes ? `<div><b>Notes:</b> ${escapeHtml(payment.notes)}</div>` : ''}
  </div>

  <div class="totals">
    Previous balance: ${formatCents(payment.previousBalanceCents)}<br>
    <b>Payment applied: ${formatCents(payment.amountCents)}</b><br>
    Method: ${methodText}<br>
    <hr style="border:none;border-top:1px dashed #666;margin:8px 0">
    <b>New balance: ${formatCents(payment.newBalanceCents)}</b>
  </div>

  ${settings.receiptFooter ? `<div class="footer">${escapeHtml(settings.receiptFooter)}</div>` : ''}
</body>
</html>`;
}

function statementHtml(data: CustomerStatementData): string {
  const {
    customer,
    settings,
    period,
    openingBalanceCents,
    entries,
    closingBalanceCents,
    totalChargesCents,
    totalPaymentsCents,
  } = data;

  const rows = entries
    .map((entry) => {
      const ref = entry.relatedSaleReceiptNumber
        ? `Sale #${entry.relatedSaleReceiptNumber}`
        : entry.relatedPaymentReceiptNumber
          ? `Payment #${entry.relatedPaymentReceiptNumber}`
          : '—';
      const charge =
        entry.chargeCents !== null ? formatCents(entry.chargeCents) : '';
      const payment =
        entry.paymentCents !== null ? formatCents(entry.paymentCents) : '';
      return `<tr>
      <td>${escapeHtml(new Date(entry.occurredAt).toLocaleDateString())}</td>
      <td>${escapeHtml(entry.notes)}</td>
      <td>${escapeHtml(ref)}</td>
      <td style="text-align:right">${charge}</td>
      <td style="text-align:right">${payment}</td>
      <td style="text-align:right"><b>${formatCents(entry.runningBalanceCents)}</b></td>
    </tr>`;
    })
    .join('');

  const balanceLabel =
    closingBalanceCents > 0
      ? `Amount owed: ${formatCents(closingBalanceCents)}`
      : closingBalanceCents < 0
        ? `Customer credit: ${formatCents(Math.abs(closingBalanceCents))}`
        : `Settled ($0.00)`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Statement - ${escapeHtml(customer.name)}</title>
  <style>
    body{font:13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:auto;padding:30px;color:#111}
    .header{display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:14px;margin-bottom:16px}
    .cust-info{background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;padding:12px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse;margin:16px 0}
    th, td{border:1px solid #ddd;padding:6px 8px;font-size:12px}
    th{background:#f1f3f5;text-align:left}
    .summary-box{margin-top:20px;float:right;width:280px;background:#f8f9fa;border:1px solid #333;border-radius:4px;padding:12px;line-height:1.6}
    .footer{clear:both;text-align:center;padding-top:40px;font-size:11px;color:#666;white-space:pre-line}
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h2 style="margin:0 0 4px 0">${escapeHtml(settings.storeName)}</h2>
      ${settings.contactLines.map((line) => `<div style="font-size:12px;color:#555">${escapeHtml(line)}</div>`).join('')}
    </div>
    <div style="text-align:right">
      <h3 style="margin:0 0 4px 0">ACCOUNT STATEMENT</h3>
      <div style="font-size:12px"><b>Period:</b> ${escapeHtml(period.label)}</div>
      <div style="font-size:11px;color:#666">Generated: ${escapeHtml(new Date(data.generatedAt).toLocaleString())}</div>
    </div>
  </div>

  <div class="cust-info">
    <strong>Customer:</strong> ${escapeHtml(customer.name)} ${customer.secondaryName ? `(${escapeHtml(customer.secondaryName)})` : ''}<br>
    <strong>Account #:</strong> ${escapeHtml(customer.accountNumber)}
    ${customer.phone ? ` &nbsp;·&nbsp; <strong>Phone:</strong> ${escapeHtml(customer.phone)}` : ''}
    ${customer.email ? ` &nbsp;·&nbsp; <strong>Email:</strong> ${escapeHtml(customer.email)}` : ''}
    ${customer.address ? `<br><strong>Address:</strong> ${escapeHtml(customer.address)}` : ''}
  </div>

  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Description</th>
        <th>Reference</th>
        <th style="text-align:right">Charges</th>
        <th style="text-align:right">Payments</th>
        <th style="text-align:right">Balance</th>
      </tr>
    </thead>
    <tbody>
      <tr style="background:#fdfdfd">
        <td colspan="5"><em>Opening Balance</em></td>
        <td style="text-align:right"><b>${formatCents(openingBalanceCents)}</b></td>
      </tr>
      ${rows}
    </tbody>
  </table>

  <div class="summary-box">
    <div style="display:flex;justify-content:space-between"><span>Opening balance:</span> <span>${formatCents(openingBalanceCents)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>Total charges:</span> <span>+${formatCents(totalChargesCents)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>Total payments:</span> <span>-${formatCents(totalPaymentsCents)}</span></div>
    <hr style="border:none;border-top:1px solid #333;margin:6px 0">
    <div style="display:flex;justify-content:space-between;font-size:14px"><b>Closing balance:</b> <b>${escapeHtml(balanceLabel)}</b></div>
  </div>

  ${settings.statementFooter ? `<div class="footer">${escapeHtml(settings.statementFooter)}</div>` : ''}
</body>
</html>`;
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
