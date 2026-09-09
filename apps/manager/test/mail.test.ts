import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '@shul-store/database';
import type { EmailConfig, PurchaseOrder } from '@shul-store/shared';
import {
  MailWorker,
  describeMailError,
  sendWithConfig,
} from '../electron/mail.js';

const config: EmailConfig = {
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  username: 'shop@example.com',
  password: 'app-password',
  authType: 'password',
  oauth: null,
  fromName: 'Shop',
  fromAddress: 'shop@example.com',
  ccSelf: false,
};

let store: StoreDatabase;
let order: PurchaseOrder;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
  const categoryId = store.createCategory({ name: 'Drinks' }).id;
  const vendorId = store.createVendor({
    name: 'ABC',
    email: 'orders@abc.example',
  }).id;
  const cola = store.createProduct({
    categoryId,
    name: 'Cola',
    purchaseCostCents: 150,
    sellingPriceCents: 300,
    taxable: false,
    lowStockThreshold: 5,
    barcodes: ['111'],
    vendors: [{ vendorId, preferred: true, costCents: 120, vendorSku: null }],
  });
  order = store.markPurchaseOrderSent(
    store.createPurchaseOrder({
      vendorId,
      subject: 'PO',
      message: '',
      notes: '',
      lines: [{ productId: cola.id, quantity: 6, unitCostCents: 120 }],
    }).id,
    'email',
  );
  store.purchaseOrders.enqueueEmail({
    purchaseOrderId: order.id,
    to: 'orders@abc.example',
    subject: 'PO',
    textBody: 'text',
    htmlBody: '<p>html</p>',
  });
});

afterEach(() => store.close());

describe('MailWorker', () => {
  it('publishes the order to the cloud, sends, and marks the email sent', async () => {
    const published: string[] = [];
    const sent: string[] = [];
    store.purchaseOrders.setEmailConfig(config);
    const worker = new MailWorker(
      store,
      () => ({
        isAccountSyncConfigured: () => true,
        publishPurchaseOrder: async (value) => {
          published.push(value.id);
        },
      }),
      () => undefined,
      async (_config, email) => {
        sent.push(email.to);
      },
    );
    await worker.kick();
    expect(published).toEqual([order.id]);
    expect(sent).toEqual(['orders@abc.example']);
    expect(store.purchaseOrders.pendingEmails()).toHaveLength(0);
    expect(store.purchaseOrders.find(order.id)?.publishedAt).not.toBeNull();
    expect(store.purchaseOrders.list()[0]?.emailStatus).toBe('sent');
  });

  it('keeps the email pending while offline and fails it on a permanent error', async () => {
    store.purchaseOrders.setEmailConfig(config);
    let attempt = 0;
    const worker = new MailWorker(
      store,
      () => null,
      () => undefined,
      async () => {
        attempt += 1;
        if (attempt === 1)
          throw Object.assign(new Error('connect ETIMEDOUT'), {
            code: 'ETIMEDOUT',
          });
        throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
      },
    );
    await worker.kick();
    expect(store.purchaseOrders.list()[0]?.emailStatus).toBe('pending');
    await worker.kick();
    const summary = store.purchaseOrders.list()[0]!;
    expect(summary.emailStatus).toBe('failed');
    expect(summary.emailError).toContain('App Password');
    expect(store.purchaseOrders.pendingEmails()).toHaveLength(0);
  });

  it('fails immediately when no email account is configured', async () => {
    const worker = new MailWorker(
      store,
      () => null,
      () => undefined,
      async () => {
        throw new Error('should not send');
      },
    );
    await worker.kick();
    expect(store.purchaseOrders.list()[0]?.emailStatus).toBe('failed');
    expect(store.purchaseOrders.list()[0]?.emailError).toContain(
      'No email account',
    );
  });

  it('explains connection errors in plain language', () => {
    expect(
      describeMailError(
        Object.assign(new Error('boom'), { code: 'ECONNECTION' }),
      ),
    ).toContain('Could not reach the mail server');
  });
});

describe('sendWithConfig (Gmail API)', () => {
  const gmailConfig: EmailConfig = {
    ...config,
    authType: 'gmail',
    password: '',
    oauth: { refreshToken: 'rt', accessToken: 'stale', expiresAt: 0 },
  };
  const googleClient = { clientId: 'cid', clientSecret: 'sec' };

  it('refreshes the token and posts a base64url MIME message to users.messages.send', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.startsWith('https://oauth2.googleapis.com/token'))
        return Response.json({ access_token: 'fresh', expires_in: 3600 });
      return Response.json({ id: 'msg1' });
    }) as typeof fetch;
    await sendWithConfig(
      gmailConfig,
      {
        to: 'orders@abc.example',
        subject: 'PO-1',
        textBody: 'hello',
        htmlBody: '<p>hello</p>',
      },
      { googleClient, fetchImpl },
    );
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    ]);
    const tokenBody = String(calls[0]!.init.body);
    expect(tokenBody).toContain('grant_type=refresh_token');
    expect(tokenBody).toContain('refresh_token=rt');
    const send = calls[1]!.init;
    expect((send.headers as Record<string, string>).authorization).toBe(
      'Bearer fresh',
    );
    const raw = (JSON.parse(String(send.body)) as { raw: string }).raw;
    const mime = Buffer.from(raw, 'base64url').toString();
    expect(mime).toContain('To: orders@abc.example');
    expect(mime).toContain('Subject: PO-1');
    expect(mime).toContain('hello');
  });

  it('reports a revoked grant as a re-sign-in problem', async () => {
    const fetchImpl = (async () =>
      Response.json(
        {
          error: 'invalid_grant',
          error_description: 'Token has been revoked.',
        },
        { status: 400 },
      )) as typeof fetch;
    await expect(
      sendWithConfig(
        {
          ...gmailConfig,
          oauth: { refreshToken: 'revoked', accessToken: null, expiresAt: 0 },
        },
        { to: 'a@b.c', subject: 's', textBody: 't', htmlBody: '<p>t</p>' },
        { googleClient, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'EOAUTH2' });
  });
});
