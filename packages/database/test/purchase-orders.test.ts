import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  purchaseOrderEmailHtml,
  purchaseOrderEmailText,
} from '@shul-store/shared';
import { StoreDatabase } from '../src/index.js';

let store: StoreDatabase;
let categoryId: string;
let vendorId: string;

const product = (name: string, barcode: string, threshold = 5) =>
  store.createProduct({
    categoryId,
    name,
    purchaseCostCents: 150,
    sellingPriceCents: 300,
    taxable: false,
    lowStockThreshold: threshold,
    barcodes: [barcode],
    vendors: [{ vendorId, preferred: true, costCents: 120, vendorSku: 'SKU1' }],
  });

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  categoryId = store.createCategory({ name: 'Drinks' }).id;
  vendorId = store.createVendor({
    name: 'ABC Distributors',
    email: 'orders@abc.example',
    defaultReorderQty: 6,
  }).id;
});

afterEach(() => store.close());

describe('purchase orders', () => {
  it('creates a draft from the buying list and marks suggestions ordered', () => {
    const cola = product('Cola', '111');
    const lines = store.vendors.listBuyingList(vendorId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(6);
    expect(lines[0]!.unitCostCents).toBe(120);

    const order = store.createPurchaseOrder({
      vendorId,
      subject: 'PO',
      message: 'Hi',
      notes: '',
      lines: [{ productId: cola.id, quantity: 6, unitCostCents: 120 }],
    });
    expect(order.status).toBe('draft');
    expect(order.number).toMatch(/^PO-\d{8}-001$/);
    expect(order.totalCents).toBe(720);
    expect(order.lines[0]).toMatchObject({
      productName: 'Cola',
      barcode: '111',
      vendorSku: 'SKU1',
      quantity: 6,
      receivedQuantity: 0,
    });
    expect(order.accessToken.length).toBeGreaterThan(20);

    expect(store.vendors.listBuyingList(vendorId)).toHaveLength(0);
    const ordered = store.vendors.listBuyingList(vendorId, ['ordered']);
    expect(ordered).toHaveLength(1);
    expect(store.vendors.listVendorSummaries()[0]!.openLineCount).toBe(0);
  });

  it('receives stock, posts movements and releases the suggestion', () => {
    const cola = product('Cola', '111');
    const order = store.createPurchaseOrder({
      vendorId,
      subject: 'PO',
      message: '',
      notes: '',
      lines: [{ productId: cola.id, quantity: 12, unitCostCents: null }],
    });
    expect(() =>
      store.receivePurchaseOrder(order.id, {
        lines: [{ lineId: order.lines[0]!.id, quantity: 12 }],
      }),
    ).toThrow(/Only sent orders/);

    const sent = store.markPurchaseOrderSent(order.id, 'manual');
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();

    const partial = store.receivePurchaseOrder(sent.id, {
      lines: [{ lineId: sent.lines[0]!.id, quantity: 5 }],
    });
    expect(partial.status).toBe('partially_received');
    expect(partial.lines[0]!.receivedQuantity).toBe(5);
    expect(store.getProduct(cola.id).stockQuantity).toBe(5);
    // Still in transit: stock (5) <= threshold (5) but no new suggestion.
    expect(store.vendors.listBuyingList(vendorId)).toHaveLength(0);

    const done = store.receivePurchaseOrder(sent.id, {
      lines: [{ lineId: sent.lines[0]!.id, quantity: 7 }],
      notes: 'second box',
    });
    expect(done.status).toBe('received');
    expect(done.receivedAt).not.toBeNull();
    expect(store.getProduct(cola.id).stockQuantity).toBe(12);
    const movements = store.listInventoryMovements(cola.id);
    expect(movements).toHaveLength(2);
    expect(movements[0]!.reason).toBe('stock_received');
    expect(movements[0]!.notes).toContain(done.number);
    expect(store.vendors.listBuyingList(vendorId, ['ordered'])).toHaveLength(0);

    const summaries = store.purchaseOrders.list(vendorId);
    expect(summaries[0]).toMatchObject({
      status: 'received',
      unitCount: 12,
      receivedUnitCount: 12,
      emailStatus: null,
    });
  });

  it('cancelling a draft releases the suggestion again', () => {
    const cola = product('Cola', '111');
    const order = store.createPurchaseOrder({
      vendorId,
      subject: 'PO',
      message: '',
      notes: '',
      lines: [{ productId: cola.id, quantity: 6, unitCostCents: 120 }],
    });
    expect(store.vendors.listBuyingList(vendorId)).toHaveLength(0);
    store.cancelPurchaseOrder(order.id);
    expect(store.purchaseOrders.get(order.id).status).toBe('cancelled');
    expect(store.vendors.listBuyingList(vendorId)).toHaveLength(1);
  });

  it('queues, sends and retries emails', () => {
    const cola = product('Cola', '111');
    const order = store.createPurchaseOrder({
      vendorId,
      subject: 'PO',
      message: '',
      notes: '',
      lines: [{ productId: cola.id, quantity: 6, unitCostCents: 120 }],
    });
    const email = store.purchaseOrders.enqueueEmail({
      purchaseOrderId: order.id,
      to: 'orders@abc.example',
      subject: 'PO',
      textBody: 'text',
      htmlBody: '<p>html</p>',
    });
    expect(store.purchaseOrders.pendingEmails()).toHaveLength(1);
    store.purchaseOrders.markEmailFailed(email.id, 'ECONNREFUSED', false);
    expect(store.purchaseOrders.getEmail(email.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'ECONNREFUSED',
    });
    store.purchaseOrders.markEmailFailed(email.id, 'EAUTH', true);
    expect(store.purchaseOrders.list()[0]!.emailStatus).toBe('failed');
    store.purchaseOrders.requeueEmail(email.id);
    store.purchaseOrders.markEmailSent(email.id);
    expect(store.purchaseOrders.getEmail(email.id).status).toBe('sent');
    expect(store.purchaseOrders.getEmailConfigStatus()).toMatchObject({
      configured: false,
      pendingCount: 0,
      failedCount: 0,
    });
  });

  it('stores the SMTP config and reports a masked status', () => {
    const status = store.purchaseOrders.setEmailConfig({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      username: 'shop@gmail.com',
      password: 'app-password',
      fromName: 'Shop',
      fromAddress: 'shop@gmail.com',
      ccSelf: true,
    });
    expect(status).toMatchObject({
      configured: true,
      host: 'smtp.gmail.com',
      fromAddress: 'shop@gmail.com',
      ccSelf: true,
    });
    expect(JSON.stringify(status)).not.toContain('app-password');
    expect(store.purchaseOrders.getEmailConfig()?.password).toBe(
      'app-password',
    );
    expect(store.purchaseOrders.setEmailConfig(null).configured).toBe(false);
  });

  it('renders the email templates', () => {
    const data = {
      storeName: 'Corner Shop',
      storeEmail: 'shop@example.com',
      number: 'PO-1',
      vendorName: 'ABC',
      message: 'Hello <b>',
      lines: [
        {
          productName: 'Cola & Co',
          barcode: '111',
          vendorSku: null,
          quantity: 6,
          unitCostCents: 120,
        },
      ],
      portalUrl: 'https://vendorportal.sumasystems.com/o/abc',
    };
    const html = purchaseOrderEmailHtml(data);
    expect(html).toContain('Cola &amp; Co');
    expect(html).toContain('Hello &lt;b&gt;');
    expect(html).toContain('$7.20');
    expect(html).toContain('View order online');
    const text = purchaseOrderEmailText(data);
    expect(text).toContain('Cola & Co');
    expect(text).toContain('Estimated total: $7.20');
  });
});
