import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KioskServer, StoreDatabase } from '../src/index.js';

/**
 * Real LAN coverage: every request below crosses an actual TCP socket against a kiosk
 * server bound to a loopback port, and every restart reopens the SQLite file from disk.
 * Nothing is mocked except the processor, which is the bundled simulated one.
 */

interface Lan {
  db: StoreDatabase;
  server: KioskServer;
  origin: string;
}

let directory: string;
let databaseFile: string;
let active: Lan[] = [];

function openLan(): Lan {
  const db = new StoreDatabase(databaseFile);
  const lan: Lan = { db, server: new KioskServer(db), origin: '' };
  active.push(lan);
  return lan;
}

async function startLan(): Promise<Lan> {
  const lan = openLan();
  const port = await lan.server.start(0, '127.0.0.1');
  lan.origin = `http://127.0.0.1:${port}`;
  return lan;
}

async function pair(lan: Lan, name = 'Front table') {
  const code = lan.server.newPairingCode();
  const response = await fetch(`${lan.origin}/api/pair`, {
    method: 'POST',
    body: JSON.stringify({ code, name, adminPin: '1234' }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; kioskId: string };
}

async function api(
  lan: Lan,
  method: string,
  route: string,
  token?: string,
  body?: unknown,
) {
  const response = await fetch(`${lan.origin}${route}`, {
    method,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function apiFromAddress(
  lan: Lan,
  localAddress: string,
  route: string,
  body: unknown,
) {
  const payload = JSON.stringify(body);
  const response = await new Promise<{
    status: number;
    text: string;
  }>((resolve, reject) => {
    const request = http.request(
      `${lan.origin}${route}`,
      {
        method: 'POST',
        localAddress,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => {
          text += chunk;
        });
        incoming.on('end', () =>
          resolve({ status: incoming.statusCode ?? 0, text }),
        );
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
  return {
    status: response.status,
    body: response.text
      ? (JSON.parse(response.text) as Record<string, unknown>)
      : {},
  };
}

function chargeBody(productId: string, quantity = 1) {
  return {
    chargeReference: randomUUID(),
    idempotencyKey: randomUUID(),
    lines: [{ productId, quantity, barcodeUsed: null }],
  };
}

describe('kiosk LAN API', () => {
  let water: { id: string };
  let soda: { id: string };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'shul-kiosk-lan-'));
    databaseFile = path.join(directory, 'store.sqlite');
    const db = new StoreDatabase(databaseFile);
    const categoryId = db.createCategory({ name: 'Drinks' }).id;
    // Simulated processor approves $10.00 and leaves $10.03 pending.
    water = db.createProduct({
      categoryId,
      name: 'Water',
      purchaseCostCents: 40,
      sellingPriceCents: 1000,
      taxable: false,
      lowStockThreshold: 1,
      barcodes: ['WATER-1'],
    });
    soda = db.createProduct({
      categoryId,
      name: 'Soda',
      purchaseCostCents: 60,
      sellingPriceCents: 1003,
      taxable: false,
      lowStockThreshold: 1,
      barcodes: ['SODA-1'],
    });
    for (const product of [water, soda])
      db.addInventoryMovement({
        productId: product.id,
        quantityChange: 50,
        reason: 'stock_received',
        notes: 'Opening stock',
      });
    db.updateSettings({
      ...db.getSettings(),
      cardProcessingEnabled: true,
      cardProcessorId: 'simulated',
    });
    db.close();
  });

  afterEach(async () => {
    for (const lan of active) {
      await lan.server.stop();
      lan.db.close();
    }
    active = [];
    rmSync(directory, { recursive: true, force: true });
  });

  it('pairs, quotes and completes a card sale over a real socket', async () => {
    const lan = await startLan();
    const { token, kioskId } = await pair(lan);

    const catalog = await api(lan, 'GET', '/api/catalog', token);
    expect(catalog.status).toBe(200);
    expect((catalog.body.products as unknown[]).length).toBe(2);

    const quote = await api(lan, 'POST', '/api/cart/price', token, {
      lines: [{ productId: water.id, quantity: 2 }],
    });
    expect(quote.status).toBe(200);
    expect(quote.body.totalCents).toBe(2000);

    const charge = await api(lan, 'POST', '/api/charges', token, {
      ...chargeBody(water.id, 2),
    });
    expect(charge.status).toBe(200);
    expect(charge.body.status).toBe('approved');
    expect(charge.body.totalCents).toBe(2000);
    expect(typeof charge.body.receiptNumber).toBe('number');
    expect(lan.db.listSales()).toHaveLength(1);
    expect(lan.db.listSales()[0]!.payment.chargeReference).toBe(
      charge.body.chargeReference,
    );

    const status = await api(
      lan,
      'GET',
      `/api/charges/${charge.body.chargeReference}`,
      token,
    );
    expect(status.body.status).toBe('approved');
    expect(status.body.receiptNumber).toBe(charge.body.receiptNumber);

    const row = lan.db.getPaymentTransaction(
      String(charge.body.chargeReference),
    )!;
    expect(String(row.origin_channel)).toBe('kiosk');
    expect(String(row.kiosk_id)).toBe(kioskId);
    expect(row.snapshot_hash).toBeTruthy();
    expect(row.processor_config_hash).toBeTruthy();
  });

  it('surfaces revocation state and rejects a revoked kiosk bearer token', async () => {
    const lan = await startLan();
    const { token } = await pair(lan);

    expect((await api(lan, 'GET', '/api/catalog')).status).toBe(401);
    expect((await api(lan, 'GET', '/api/catalog', 'not-a-token')).status).toBe(
      401,
    );

    const [kiosk] = lan.db.listKiosks();
    expect(kiosk!.revokedAt).toBeNull();
    lan.db.revokeKiosk(kiosk!.id);
    expect(lan.db.listKiosks()[0]!.revokedAt).toEqual(expect.any(String));
    expect((await api(lan, 'GET', '/api/catalog', token)).status).toBe(401);
    expect(
      (await api(lan, 'POST', '/api/charges', token, chargeBody(water.id)))
        .status,
    ).toBe(401);
    expect(lan.db.listSales()).toHaveLength(0);
  });

  it('limits pairing attempts per address while allowing another address in the same window', async () => {
    const lan = await startLan();
    const wrongCode = (code: string) =>
      code === '100000' ? '200000' : '100000';
    const attempt = async () => {
      const code = lan.server.newPairingCode();
      return api(lan, 'POST', '/api/pair', undefined, {
        code: wrongCode(code),
        name: 'Front table',
        adminPin: '1234',
      });
    };

    for (let index = 0; index < 10; index += 1)
      expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);

    const code = lan.server.newPairingCode();
    const otherAddress = await apiFromAddress(lan, '127.0.0.2', '/api/pair', {
      code: wrongCode(code),
      name: 'Side table',
      adminPin: '1234',
    });
    expect(otherAddress.status).toBe(400);
    expect(otherAddress.body.error).toBe('Invalid pairing code');
  });

  it('keeps the per-address pairing budget when a new code is generated', async () => {
    const lan = await startLan();
    const wrongCode = (code: string) =>
      code === '100000' ? '200000' : '100000';

    for (let index = 0; index < 10; index += 1) {
      const code = lan.server.newPairingCode();
      const response = await api(lan, 'POST', '/api/pair', undefined, {
        code: wrongCode(code),
        name: 'Front table',
        adminPin: '1234',
      });
      expect(response.status).toBe(400);
    }

    const newCode = lan.server.newPairingCode();
    const response = await api(lan, 'POST', '/api/pair', undefined, {
      code: newCode,
      name: 'Front table',
      adminPin: '1234',
    });
    expect(response.status).toBe(429);
  });

  it('rejects a wrong-length pairing code with a generic 400 response', async () => {
    const lan = await startLan();
    const code = lan.server.newPairingCode();
    const response = await api(lan, 'POST', '/api/pair', undefined, {
      code: code.slice(0, -1),
      name: 'Front table',
      adminPin: '1234',
    });
    expect(response.status).not.toBe(500);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid-request' });
  });

  it('authorizes exactly once when the same charge is retried concurrently', async () => {
    const { processors } = await import('@shul-store/payments');
    const processor = processors[0]!;
    const original = processor.createCharge;
    let authorizations = 0;
    processor.createCharge = async (...args) => {
      authorizations += 1;
      return original(...args);
    };

    const lan = await startLan();
    const { token } = await pair(lan);
    const body = chargeBody(water.id, 1);
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          api(lan, 'POST', '/api/charges', token, body),
        ),
      );

      // Every retry sees the winning authorization; none of them repeats it.
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(
        responses.every((response) => response.body.status === 'approved'),
      ).toBe(true);
      expect(authorizations).toBe(1);
      expect(
        (
          lan.db.connection
            .prepare('SELECT COUNT(*) AS count FROM payment_transactions')
            .get() as { count: number }
        ).count,
      ).toBe(1);
      expect(lan.db.listSales()).toHaveLength(1);
      expect(lan.db.getProduct(water.id).stockQuantity).toBe(49);
    } finally {
      processor.createCharge = original;
    }
  });

  it('lets exactly one cart win when several charge references share an idempotency key', async () => {
    const lan = await startLan();
    const { token } = await pair(lan);
    const idempotencyKey = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        api(lan, 'POST', '/api/charges', token, {
          ...chargeBody(water.id, 1),
          idempotencyKey,
        }),
      ),
    );

    const winners = responses.filter((response) => response.status === 200);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    expect(
      (
        lan.db.connection
          .prepare('SELECT COUNT(*) AS count FROM payment_transactions')
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(lan.db.listSales()).toHaveLength(1);
  });

  it('recovers a pending charge after a full restart and finalizes it once', async () => {
    const lan = await startLan();
    const { token } = await pair(lan);
    const body = chargeBody(soda.id, 1);

    const first = await api(lan, 'POST', '/api/charges', token, body);
    expect(first.body.status).toBe('unknown');
    expect(lan.db.listSales()).toHaveLength(0);

    // Hard stop: close the socket and the database, exactly like a crash or a reboot.
    await lan.server.stop();
    lan.db.close();
    active = active.filter((entry) => entry !== lan);

    const restarted = openLan();
    const port = await restarted.server.start(0, '127.0.0.1');
    restarted.origin = `http://127.0.0.1:${port}`;

    const status = await api(
      restarted,
      'GET',
      `/api/charges/${body.chargeReference}`,
      token,
    );
    expect(status.body.status).toBe('approved');
    expect(typeof status.body.receiptNumber).toBe('number');
    expect(restarted.db.listSales()).toHaveLength(1);

    // Asking again must not create a second sale.
    const again = await api(
      restarted,
      'GET',
      `/api/charges/${body.chargeReference}`,
      token,
    );
    expect(again.body.receiptNumber).toBe(status.body.receiptNumber);
    expect(restarted.db.listSales()).toHaveLength(1);
    expect(restarted.db.getProduct(soda.id).stockQuantity).toBe(49);
  });

  it('reconciles a pending charge with its frozen processor config after settings change', async () => {
    const lan = await startLan();
    const { token } = await pair(lan);
    const body = chargeBody(soda.id, 1);

    const first = await api(lan, 'POST', '/api/charges', token, body);
    expect(first.body.status).toBe('unknown');

    lan.db.updateSettings({
      ...lan.db.getSettings(),
      cardProcessorConfigJson: JSON.stringify({ simulateDelayMs: 25 }),
    });

    const status = await api(
      lan,
      'GET',
      `/api/charges/${body.chargeReference}`,
      token,
    );
    expect(status.body.status).toBe('approved');
    expect(lan.db.listSales()).toHaveLength(1);
    expect(lan.db.payments.listNeedsAttention()).toHaveLength(0);
    expect(lan.db.heldQuantityFor(soda.id, null)).toBe(0);
  });

  it('reports cart problems with a stable 409 marker and never charges', async () => {
    const lan = await startLan();
    const { token } = await pair(lan);

    const oversold = await api(lan, 'POST', '/api/charges', token, {
      ...chargeBody(water.id, 5000),
    });
    expect(oversold.status).toBe(409);
    expect(oversold.body.error).toBe('cart-unavailable');

    const badBarcode = await api(lan, 'POST', '/api/charges', token, {
      chargeReference: randomUUID(),
      idempotencyKey: randomUUID(),
      lines: [{ productId: water.id, quantity: 1, barcodeUsed: 'SODA-1' }],
    });
    expect(badBarcode.status).toBe(409);
    expect(badBarcode.body.error).toBe('cart-unavailable');

    const malformed = await api(lan, 'POST', '/api/charges', token, {
      chargeReference: 'nope',
      idempotencyKey: randomUUID(),
      lines: [{ productId: water.id, quantity: 1, barcodeUsed: null }],
    });
    expect(malformed.status).toBe(400);

    expect(lan.db.listSales()).toHaveLength(0);
    expect(
      (
        lan.db.connection
          .prepare('SELECT COUNT(*) AS count FROM payment_transactions')
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
});
