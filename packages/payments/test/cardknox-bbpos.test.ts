import { describe, expect, it } from 'vitest';
import {
  cardknoxBbposConfigSchema,
  checkCardknoxBbposReader,
  createCardknoxBbposProcessor,
} from '../src/index.js';
import type { ChargeResult, ProcessorStorage } from '../src/index.js';

function response(body: Record<string, unknown>, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

function storage(): ProcessorStorage {
  const values = new Map<string, ChargeResult>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  };
}

const config = cardknoxBbposConfigSchema.parse({
  apiKey: 'secret-key',
  deviceName: 'Reader 1',
  connection: { kind: 'usb', comPort: 'COM4' },
  mode: 'live',
});

describe('Cardknox BBPOS processor', () => {
  it('approves a sale and preserves sanitized card details', async () => {
    const fake = fakeFetch([
      response({
        xResult: 'A',
        xRefNum: 'processor-ref',
        xCardType: 'Visa',
        xMaskedCardNumber: '************4242',
      }),
    ]);
    const result = await createCardknoxBbposProcessor(
      fake.fetchImpl,
    ).createCharge(
      { chargeReference: 'charge-1', amountCents: 1234 },
      config,
      storage(),
    );
    expect(result).toEqual({
      status: 'approved',
      processorTransactionId: 'processor-ref',
      cardBrand: 'Visa',
      cardLast4: '4242',
    });
    expect(String(fake.calls[0]?.init?.body)).toContain('xCommand=cc%3Asale');
    expect(String(fake.calls[0]?.init?.body)).toContain('xDeviceComPort=COM4');
    expect(result).not.toHaveProperty('apiKey');
  });

  it('declines a sale with the provider reason', async () => {
    const fake = fakeFetch([
      response({ xResult: 'D', xErrorMessage: 'Card declined' }),
    ]);
    const result = await createCardknoxBbposProcessor(
      fake.fetchImpl,
    ).createCharge(
      { chargeReference: 'charge-2', amountCents: 1000 },
      config,
      storage(),
    );
    expect(result).toEqual({
      status: 'declined',
      declineReason: 'Card declined',
    });
  });

  it('maps an unreachable reader to a setup message and pending', async () => {
    const fake = fakeFetch([new Error('connect refused')]);
    const result = await createCardknoxBbposProcessor(
      fake.fetchImpl,
    ).createCharge(
      { chargeReference: 'charge-3', amountCents: 1000 },
      config,
      storage(),
    );
    expect(result.status).toBe('pending');
    expect(result.errorMessage).toContain('Install BBPOS');
    expect(result.errorMessage).not.toContain('connect refused');
  });

  it('maps no response to pending and does not invent a result', async () => {
    const fake = fakeFetch([new Response('', { status: 200 })]);
    const result = await createCardknoxBbposProcessor(
      fake.fetchImpl,
    ).createCharge(
      { chargeReference: 'charge-4', amountCents: 1000 },
      config,
      storage(),
    );
    expect(result).toEqual({
      status: 'pending',
      errorMessage:
        'The card reader did not answer. The payment needs attention; do not try the card again.',
    });
  });

  it('cancels through BBPOS and includes the cancellation flag', async () => {
    const fake = fakeFetch([response({ xResult: 'A' })]);
    await createCardknoxBbposProcessor(fake.fetchImpl).cancelCharge(
      'charge-5',
      config,
      storage(),
    );
    const body = String(fake.calls[0]?.init?.body);
    expect(body).toContain('xCancel=1');
    expect(body).toContain('xCommand=cc%3Asale');
  });

  it('sends refunds to the remote gateway with the processor reference', async () => {
    const fake = fakeFetch([response({ xResult: 'A', xRefNum: 'refund-ref' })]);
    const result = await createCardknoxBbposProcessor(fake.fetchImpl)
      .refundCharge!(
      {
        chargeReference: 'charge-6',
        processorTransactionId: 'sale-ref',
        refundReference: 'refund-1',
        amountCents: 1000,
      },
      config,
      storage(),
    );
    expect(result).toEqual({
      status: 'refunded',
      processorRefundId: 'refund-ref',
    });
    expect(fake.calls[0]?.input).toBe('https://x1.cardknox.com/gatewayjson');
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toMatchObject({
      xCommand: 'cc:refund',
      xRefNum: 'sale-ref',
    });
  });

  it('checks the configured reader without charging', async () => {
    const fake = fakeFetch([response({ xResult: 'ok' })]);
    const result = await checkCardknoxBbposReader(config, fake.fetchImpl);
    expect(result).toEqual({
      ok: true,
      message: 'The BBPOS reader was found and woke up.',
    });
    expect(String(fake.calls[0]?.init?.body)).toContain(
      'xCommand=Device_ShowWelcomeScreen',
    );
  });

  it('uses network reader fields when configured for IP', async () => {
    const fake = fakeFetch([
      response({ xResult: 'A', xRefNum: 'processor-ref' }),
    ]);
    await createCardknoxBbposProcessor(fake.fetchImpl).createCharge(
      { chargeReference: 'charge-7', amountCents: 1000 },
      cardknoxBbposConfigSchema.parse({
        ...config,
        connection: { kind: 'ip', address: '192.168.1.40', port: 9100 },
      }),
      storage(),
    );
    const body = String(fake.calls[0]?.init?.body);
    expect(body).toContain('xDeviceIPAddress=192.168.1.40');
    expect(body).toContain('xDeviceIPPort=9100');
    expect(body).not.toContain('xDeviceComPort');
  });

  it('does not invent a status for a lost response', async () => {
    await expect(
      createCardknoxBbposProcessor().getChargeStatus(
        'missing-charge',
        config,
        storage(),
      ),
    ).rejects.toThrow('safe status lookup');
  });
});
