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

function storage(onSet?: (value: ChargeResult) => void): ProcessorStorage {
  const values = new Map<string, ChargeResult>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      onSet?.(value);
      values.set(key, value);
    },
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
    const stored: ChargeResult[] = [];
    const fake = fakeFetch([
      response({
        xResult: 'A',
        xRefNum: 'processor-ref',
        xCardType: 'Visa',
        xCardNum: '4111111111111111',
      }),
    ]);
    const result = await createCardknoxBbposProcessor(
      fake.fetchImpl,
    ).createCharge(
      { chargeReference: 'charge-1', amountCents: 1234 },
      config,
      storage((value) => stored.push(value)),
    );
    expect(result).toEqual({
      status: 'approved',
      processorTransactionId: 'processor-ref',
      cardBrand: 'Visa',
      cardLast4: '1111',
    });
    expect(String(fake.calls[0]?.init?.body)).toContain('xCommand=cc%3Asale');
    expect(String(fake.calls[0]?.init?.body)).toContain('xDeviceComPort=COM4');
    expect(String(fake.calls[0]?.init?.body)).not.toContain(
      'xEnableKeyedEntry',
    );
    expect(result).not.toHaveProperty('apiKey');
    expect(result).not.toHaveProperty('xCardNum');
    expect(stored[0]).not.toHaveProperty('xCardNum');
  });

  it('declines a sale with the provider reason', async () => {
    const fake = fakeFetch([
      response({
        xResult: 'D',
        xErrorMessage: 'Card 4111 1111 1111 1111 declined',
      }),
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
      declineReason: 'Card [redacted card number] declined',
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
    expect(body).not.toContain('xCommand');
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

  it('sends reader-only mode only when explicitly enabled', async () => {
    const fake = fakeFetch([
      response({ xResult: 'A', xRefNum: 'processor-ref' }),
    ]);
    await createCardknoxBbposProcessor(fake.fetchImpl).createCharge(
      { chargeReference: 'charge-reader-only', amountCents: 1000 },
      cardknoxBbposConfigSchema.parse({
        ...config,
        readerOnly: true,
      }),
      storage(),
    );
    expect(String(fake.calls[0]?.init?.body)).toContain('xEnableKeyedEntry=1');
  });

  it('resolves a lost sale from an approved report row', async () => {
    const stored: ChargeResult[] = [];
    const fake = fakeFetch([
      response({
        xResult: 'A',
        xRecordsReturned: '1',
        xReportData: [
          {
            xInvoice: 'charge-8',
            xResponseResult: 'A',
            xRefNum: 'reported-ref',
            xCardType: 'MasterCard',
            xCardNum: '5555555555555555',
          },
        ],
      }),
    ]);
    const result = await createCardknoxBbposProcessor(
      fake.fetchImpl,
    ).getChargeStatus(
      'charge-8',
      config,
      storage((value) => stored.push(value)),
    );
    expect(result).toEqual({
      status: 'approved',
      processorTransactionId: 'reported-ref',
      cardBrand: 'MasterCard',
      cardLast4: '5555',
    });
    expect(stored[0]).not.toHaveProperty('xCardNum');
    expect(fake.calls[0]?.input).toBe('https://x1.cardknox.com/reportjson');
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toMatchObject({
      xKey: 'secret-key',
      xVersion: '5.0.0',
      xSoftwareName: 'Shul Store Manager',
      xSoftwareVersion: '0.1.0',
      xCommand: 'Report:Transactions',
      xInvoice: 'charge-8',
    });
  });

  it('resolves a lost sale from a declined report row', async () => {
    const fake = fakeFetch([
      response({
        xResult: 'A',
        xRecordsReturned: '1',
        xReportData: [
          {
            xInvoice: 'charge-9',
            xResponseResult: 'D',
            xError: 'Declined by issuer',
          },
        ],
      }),
    ]);
    const result = await createCardknoxBbposProcessor(
      fake.fetchImpl,
    ).getChargeStatus('charge-9', config, storage());
    expect(result).toEqual({
      status: 'declined',
      declineReason: 'Declined by issuer',
    });
  });

  it('keeps an approved report without a transaction reference unresolved', async () => {
    const fake = fakeFetch([
      response({
        xResult: 'A',
        xRecordsReturned: '1',
        xReportData: [
          {
            xInvoice: 'charge-approved-without-reference',
            xResponseResult: 'A',
          },
        ],
      }),
    ]);
    await expect(
      createCardknoxBbposProcessor(fake.fetchImpl).getChargeStatus(
        'charge-approved-without-reference',
        config,
        storage(),
      ),
    ).rejects.toThrow('safe status lookup');
  });

  it('does not invent a status when the report finds no sale', async () => {
    const fake = fakeFetch([
      response({ xResult: 'A', xRecordsReturned: '0', xReportData: [] }),
    ]);
    await expect(
      createCardknoxBbposProcessor(fake.fetchImpl).getChargeStatus(
        'missing-charge',
        config,
        storage(),
      ),
    ).rejects.toThrow('safe status lookup');
  });

  it('keeps an unmatched report row unresolved', async () => {
    const fake = fakeFetch([
      response({
        xResult: 'A',
        xRecordsReturned: '1',
        xReportData: [{ xInvoice: 'a-different-charge', xResponseResult: 'A' }],
      }),
    ]);
    await expect(
      createCardknoxBbposProcessor(fake.fetchImpl).getChargeStatus(
        'charge-not-in-row',
        config,
        storage(),
      ),
    ).rejects.toThrow('safe status lookup');
  });

  it('keeps a lost sale unresolved when report lookup is unreachable', async () => {
    const fake = fakeFetch([new Error('report offline')]);
    await expect(
      createCardknoxBbposProcessor(fake.fetchImpl).getChargeStatus(
        'offline-charge',
        config,
        storage(),
      ),
    ).rejects.toThrow('safe status lookup');
  });

  it('looks up refund status without issuing another refund', async () => {
    const fake = fakeFetch([
      response({
        xResult: 'A',
        xRecordsReturned: '1',
        xReportData: [
          {
            xInvoice: 'refund-2',
            xResponseResult: 'A',
            xRefNum: 'refund-reported-ref',
          },
        ],
      }),
    ]);
    const result = await createCardknoxBbposProcessor(fake.fetchImpl)
      .getRefundStatus!(
      {
        chargeReference: 'charge-10',
        refundReference: 'refund-2',
        amountCents: 1000,
      },
      config,
      storage(),
    );
    expect(result).toEqual({
      status: 'refunded',
      processorRefundId: 'refund-reported-ref',
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.input).toBe('https://x1.cardknox.com/reportjson');
    expect(String(fake.calls[0]?.init?.body)).not.toContain('cc%3Arefund');
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toMatchObject({
      xCommand: 'Report:Transactions',
      xInvoice: 'refund-2',
    });
  });
});
