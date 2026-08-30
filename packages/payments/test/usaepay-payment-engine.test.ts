import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkUsaepayDevice,
  createUsaepayPaymentEngineProcessor,
  registerUsaepayDevice,
  usaepayPaymentEngineConfigSchema,
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

function storage(onSet?: (key: string, value: ChargeResult) => void) {
  const values = new Map<string, ChargeResult>();
  const result: ProcessorStorage = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      onSet?.(key, value);
      values.set(key, value);
    },
    delete: async (key) => void values.delete(key),
  };
  return { values, result };
}

const config = usaepayPaymentEngineConfigSchema.parse({
  apiKey: 'source-key',
  apiPin: '1234',
  deviceKey: 'device-key',
  mode: 'test',
});

function transaction(resultCode = 'A') {
  return {
    refnum: 'sale-ref',
    result_code: resultCode,
    result: resultCode === 'A' ? 'Approved' : 'Declined',
    error: resultCode === 'D' ? 'Insufficient funds' : '',
    creditcard: { number: '************4242', cardtype: 'Visa' },
  };
}

describe('USAePay Payment Engine processor', () => {
  it('constructs the documented auth hash and sandbox URL', async () => {
    const fake = fakeFetch([
      response({ key: 'pr_1' }),
      response({
        complete: true,
        status: 'transaction complete',
        transaction: transaction(),
      }),
    ]);
    await createUsaepayPaymentEngineProcessor(
      fake.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-1', amountCents: 888 },
      config,
      storage().result,
    );
    const authorization = String(
      fake.calls[0]?.init?.headers &&
        new Headers(fake.calls[0].init.headers).get('Authorization'),
    );
    const decoded = Buffer.from(
      authorization.replace('Basic ', ''),
      'base64',
    ).toString();
    const [apiKey, hash] = decoded.split(':');
    const parts = hash.split('/');
    expect(apiKey).toBe('source-key');
    expect(parts[0]).toBe('s2');
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[2]).toBe(
      createHash('sha256').update(`source-key${parts[1]}1234`).digest('hex'),
    );
    expect(fake.calls[0]?.input).toBe(
      'https://sandbox.usaepay.com/api/v2/paymentengine/payrequests',
    );
  });

  it('uses the live Payment Engine base URL for live mode', async () => {
    const fake = fakeFetch([
      response({ key: 'pr_live' }),
      response({
        complete: true,
        status: 'transaction complete',
        transaction: transaction(),
      }),
    ]);
    await createUsaepayPaymentEngineProcessor(
      fake.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-live', amountCents: 100 },
      { ...config, mode: 'live' },
      storage().result,
    );
    expect(fake.calls[0]?.input).toBe(
      'https://usaepay.com/api/v2/paymentengine/payrequests',
    );
  });

  it('posts the sale body and persists the request key before polling', async () => {
    const sets: string[] = [];
    const fake = fakeFetch([
      response({ key: 'pr_2' }),
      response({
        complete: true,
        status: 'transaction complete',
        transaction: transaction(),
      }),
    ]);
    const store = storage((key) => sets.push(key));
    const result = await createUsaepayPaymentEngineProcessor(
      fake.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-reference-1234', amountCents: 888 },
      config,
      store.result,
    );
    expect(result).toEqual({
      status: 'approved',
      processorTransactionId: 'sale-ref',
      cardBrand: 'Visa',
      cardLast4: '4242',
    });
    expect(sets).toEqual([
      'charge-reference-1234',
      'charge-reference-1234',
      'charge-reference-1234',
    ]);
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toMatchObject({
      devicekey: 'device-key',
      command: 'sale',
      amount: '8.88',
      timeout: 180,
      invoice: 'erence-1234',
      orderid: 'charge-reference-1234',
      software: 'Shul Store Manager 0.1.5',
    });
  });

  it('does not post when a pending marker already exists', async () => {
    const fake = fakeFetch([]);
    const store = storage();
    await store.result.set('charge-3', {
      status: 'pending',
      errorMessage: 'already sent',
    });
    const result = await createUsaepayPaymentEngineProcessor(
      fake.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-3', amountCents: 100 },
      config,
      store.result,
    );
    expect(result).toEqual({ status: 'pending', errorMessage: 'already sent' });
    expect(fake.calls).toHaveLength(0);
  });

  it('maps declined, failed, timeout, and canceled terminal results', async () => {
    const run = async (body: Record<string, unknown>) => {
      const fake = fakeFetch([response({ key: 'pr_4' }), response(body)]);
      return createUsaepayPaymentEngineProcessor(
        fake.fetchImpl,
        async () => undefined,
      ).createCharge(
        { chargeReference: randomUUID(), amountCents: 100 },
        config,
        storage().result,
      );
    };
    await expect(
      run({
        complete: true,
        status: 'transaction complete',
        transaction: transaction('D'),
      }),
    ).resolves.toMatchObject({
      status: 'declined',
      declineReason: 'Insufficient funds',
    });
    await expect(
      run({ complete: true, status: 'transaction failed' }),
    ).resolves.toMatchObject({
      status: 'error',
    });
    await expect(
      run({ complete: true, status: 'timeout' }),
    ).resolves.toMatchObject({
      status: 'error',
    });
    await expect(
      run({ complete: true, status: 'canceled' }),
    ).resolves.toMatchObject({
      status: 'declined',
    });
  });

  it('keeps network failures and missing request keys pending', async () => {
    const failed = fakeFetch([new Error('offline')]);
    const failedResult = await createUsaepayPaymentEngineProcessor(
      failed.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-5', amountCents: 100 },
      config,
      storage().result,
    );
    expect(failedResult.status).toBe('pending');

    const lostPoll = fakeFetch([
      response({ key: 'pr_5b' }),
      new Error('offline'),
    ]);
    const lostPollResult = await createUsaepayPaymentEngineProcessor(
      lostPoll.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-5b', amountCents: 100 },
      config,
      storage().result,
    );
    expect(lostPollResult.status).toBe('pending');

    const missing = fakeFetch([response({ status: 'sent to device' })]);
    const missingStore = storage();
    const missingResult = await createUsaepayPaymentEngineProcessor(
      missing.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-6', amountCents: 100 },
      config,
      missingStore.result,
    );
    expect(missingResult.status).toBe('pending');
    expect(missing.calls).toHaveLength(1);
  });

  it('polls once for recovery and keeps an unknown result pending', async () => {
    const fake = fakeFetch([
      response({
        complete: true,
        status: 'transaction complete',
        transaction: transaction(),
      }),
    ]);
    const store = storage();
    await store.result.set('charge-7', {
      status: 'pending',
      requestKey: 'pr_7',
    } as ChargeResult & { requestKey: string });
    const result = await createUsaepayPaymentEngineProcessor(
      fake.fetchImpl,
      async () => undefined,
    ).getChargeStatus('charge-7', config, store.result);
    expect(result.status).toBe('approved');
    expect(fake.calls).toHaveLength(1);
  });

  it('returns pending without polling when the request key was lost', async () => {
    const fake = fakeFetch([]);
    const result = await createUsaepayPaymentEngineProcessor(
      fake.fetchImpl,
      async () => undefined,
    ).getChargeStatus('charge-8', config, storage().result);
    expect(result.status).toBe('pending');
    expect(fake.calls).toHaveLength(0);
  });

  it('cancels a stored request and ignores a missing request', async () => {
    const fake = fakeFetch([response({})]);
    const store = storage();
    await store.result.set('charge-9', {
      status: 'pending',
      requestKey: 'pr_9',
    } as ChargeResult & { requestKey: string });
    await createUsaepayPaymentEngineProcessor(fake.fetchImpl).cancelCharge(
      'charge-9',
      config,
      store.result,
    );
    expect(fake.calls[0]?.init?.method).toBe('DELETE');
    const noRequest = fakeFetch([]);
    await createUsaepayPaymentEngineProcessor(noRequest.fetchImpl).cancelCharge(
      'charge-10',
      config,
      storage().result,
    );
    expect(noRequest.calls).toHaveLength(0);
  });

  it('refunds by processor reference and refuses missing references', async () => {
    const fake = fakeFetch([
      response({ transaction: { result_code: 'A', refnum: 'refund-ref' } }),
    ]);
    const result = await createUsaepayPaymentEngineProcessor(fake.fetchImpl)
      .refundCharge!(
      {
        chargeReference: 'charge-11',
        refundReference: 'refund-11',
        amountCents: 500,
        processorTransactionId: 'sale-ref',
      },
      config,
      storage().result,
    );
    expect(result).toEqual({
      status: 'refunded',
      processorRefundId: 'refund-ref',
    });
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({
      command: 'refund',
      refnum: 'sale-ref',
      amount: '5.00',
    });
    const refused = await createUsaepayPaymentEngineProcessor(fake.fetchImpl)
      .refundCharge!(
      {
        chargeReference: 'charge-12',
        refundReference: 'refund-12',
        amountCents: 500,
      },
      config,
      storage().result,
    );
    expect(refused.status).toBe('error');
    expect(fake.calls).toHaveLength(1);
  });

  it('never issues a refund command during refund status recovery', async () => {
    const fake = fakeFetch([]);
    const result = await createUsaepayPaymentEngineProcessor(fake.fetchImpl)
      .getRefundStatus!(
      {
        chargeReference: 'charge-13',
        refundReference: 'refund-13',
        amountCents: 500,
      },
      config,
      storage().result,
    );
    expect(result.status).toBe('error');
    expect(fake.calls).toHaveLength(0);
  });

  it('registers and checks a terminal without exposing card data', async () => {
    const register = fakeFetch([
      response({
        key: 'device-1',
        pairing_code: '123456',
        expires_at: 'later',
      }),
    ]);
    await expect(
      registerUsaepayDevice(config, 'Front Terminal', register.fetchImpl),
    ).resolves.toEqual({
      deviceKey: 'device-1',
      pairingCode: '123456',
      expiresAt: 'later',
    });
    const check = fakeFetch([response({ status: 'online' })]);
    await expect(checkUsaepayDevice(config, check.fetchImpl)).resolves.toEqual({
      ok: true,
      message: 'The USAePay terminal is online.',
    });
    const card = fakeFetch([
      response({ key: 'pr_14' }),
      response({
        complete: true,
        status: 'transaction complete',
        transaction: {
          ...transaction(),
          creditcard: { number: '4111111111111111', cardtype: 'Visa' },
        },
      }),
    ]);
    const result = await createUsaepayPaymentEngineProcessor(
      card.fetchImpl,
      async () => undefined,
    ).createCharge(
      { chargeReference: 'charge-14', amountCents: 100 },
      config,
      storage().result,
    );
    expect(result).not.toHaveProperty('number');
    expect(result).not.toHaveProperty('creditcard');
    expect(result.cardLast4).toBe('1111');
  });
});
