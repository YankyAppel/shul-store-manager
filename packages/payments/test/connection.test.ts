import { describe, expect, it } from 'vitest';
import { testProcessorConnection } from '../src/index.js';

function response(body: Record<string, unknown>, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchSequence(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
} {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return next;
    },
  };
}

const config = {
  processorId: 'sola' as const,
  apiKey: 'test-key',
  mode: 'test' as const,
};

describe('testProcessorConnection', () => {
  it('authorizes and then voids an approved Sola test', async () => {
    const fake = fetchSequence([
      response({ xResult: 'A', xRefNum: 'ref-123' }),
      response({ xResult: 'A' }),
    ]);

    const result = await testProcessorConnection(
      { ...config, apiKey: '   ' },
      fake.fetchImpl,
    );

    expect(result).toEqual({
      ok: true,
      message: 'Sola test authorization succeeded and was voided.',
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.input).toBe('https://x1.cardknox.com/gatewayjson');
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toMatchObject({
      xKey: 'SolaSupport_Test',
      xCommand: 'cc:authonly',
      xAmount: '0.01',
    });
    expect(JSON.parse(String(fake.calls[1]?.init?.body))).toMatchObject({
      xCommand: 'cc:void',
      xRefNum: 'ref-123',
    });
  });

  it('reports a declined authorization without attempting a void', async () => {
    const fake = fetchSequence([response({ xResult: 'D' }, false)]);

    const result = await testProcessorConnection(config, fake.fetchImpl);

    expect(result).toEqual({
      ok: false,
      message: 'Sola did not approve the test authorization.',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('reports an approved authorization with no reference', async () => {
    const fake = fetchSequence([response({ xResult: 'A' })]);

    const result = await testProcessorConnection(config, fake.fetchImpl);

    expect(result).toEqual({
      ok: false,
      message: 'The processor approved the test but returned no reference.',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('reports a void failure after an approved authorization', async () => {
    const fake = fetchSequence([
      response({ xResult: 'A', xRefNum: 'ref-123' }),
      response({ xResult: 'D' }, false),
    ]);

    const result = await testProcessorConnection(config, fake.fetchImpl);

    expect(result).toEqual({
      ok: false,
      message: 'The processor approved the test, but could not void it.',
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('reports a network failure without exposing provider details', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('secret provider response');
    };

    const result = await testProcessorConnection(config, fetchImpl);

    expect(result).toEqual({
      ok: false,
      message:
        'Could not reach the processor sandbox. Check the key and try again.',
    });
  });

  it('does not issue a request for live mode', async () => {
    const fake = fetchSequence([]);

    const result = await testProcessorConnection(
      { ...config, mode: 'live' },
      fake.fetchImpl,
    );

    expect(result).toEqual({
      ok: false,
      message:
        'Live keys are not charged for a test. They are proven by the first real sale.',
    });
    expect(fake.calls).toHaveLength(0);
  });
});
