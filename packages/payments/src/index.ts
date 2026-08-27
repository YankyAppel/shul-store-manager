import { z } from 'zod';
import { randomUUID } from 'crypto';

export type ChargeStatus = 'approved' | 'declined' | 'error' | 'pending';

export interface ChargeResult {
  status: ChargeStatus;
  processorTransactionId?: string;
  cardBrand?: string;
  cardLast4?: string;
  errorMessage?: string;
  declineReason?: string;
}

export interface ChargeRequest {
  chargeReference: string;
  amountCents: number;
}

export interface RefundRequest {
  chargeReference: string;
  refundReference: string;
  amountCents: number;
}

export interface RefundResult {
  status: 'refunded' | 'declined' | 'error';
  processorRefundId?: string;
  errorMessage?: string;
}

export interface ProcessorStorage {
  get(key: string): Promise<ChargeResult | undefined>;
  set(key: string, value: ChargeResult): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PaymentProcessor<TConfig> {
  id: string;
  displayName: string;
  configSchema: z.ZodType<TConfig, z.ZodTypeDef, any>;
  createCharge(
    request: ChargeRequest,
    config: TConfig,
    storage: ProcessorStorage,
  ): Promise<ChargeResult>;
  getChargeStatus(
    chargeReference: string,
    config: TConfig,
    storage: ProcessorStorage,
  ): Promise<ChargeResult>;
  cancelCharge(
    chargeReference: string,
    config: TConfig,
    storage: ProcessorStorage,
  ): Promise<void>;
  refundCharge?(
    request: RefundRequest,
    config: TConfig,
    storage: ProcessorStorage,
  ): Promise<RefundResult>;
  getRefundStatus?(
    request: Pick<RefundRequest, 'chargeReference' | 'refundReference'>,
    config: TConfig,
    storage: ProcessorStorage,
  ): Promise<RefundResult>;
}

// SIMULATED PROCESSOR
export const simulatedConfigSchema = z.object({
  simulateDelayMs: z.number().optional(),
});

export type SimulatedConfig = z.infer<typeof simulatedConfigSchema>;

export const simulatedProcessor: PaymentProcessor<SimulatedConfig> = {
  id: 'simulated',
  displayName: 'Simulated card processor (testing)',
  configSchema: simulatedConfigSchema,
  async createCharge(request, config, storage) {
    if (config.simulateDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.simulateDelayMs),
      );
    }

    const amountStr = (request.amountCents / 100).toFixed(2);
    let result: ChargeResult;

    if (amountStr.endsWith('.01')) {
      result = { status: 'declined', declineReason: 'Simulated decline (.01)' };
    } else if (amountStr.endsWith('.02')) {
      result = { status: 'error', errorMessage: 'Simulated error (.02)' };
    } else if (amountStr.endsWith('.03')) {
      result = { status: 'pending' };
    } else {
      result = {
        status: 'approved',
        processorTransactionId: `sim_${randomUUID()}`,
        cardBrand: 'Visa',
        cardLast4: '4242',
      };
    }

    await storage.set(request.chargeReference, result);
    return result;
  },
  async getChargeStatus(chargeReference, config, storage) {
    if (config.simulateDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.simulateDelayMs),
      );
    }

    let stored = await storage.get(chargeReference);
    if (!stored) {
      return { status: 'error', errorMessage: 'Not found in simulated store' };
    }

    if (stored.status === 'pending') {
      stored = {
        status: 'approved',
        processorTransactionId: `sim_${randomUUID()}`,
        cardBrand: 'MasterCard',
        cardLast4: '5555',
      };
      await storage.set(chargeReference, stored);
    }

    return stored;
  },
  async cancelCharge(chargeReference, config, storage) {
    if (config.simulateDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.simulateDelayMs),
      );
    }
    await storage.delete(chargeReference);
  },
  async refundCharge(request, config, storage) {
    const amountStr = (request.amountCents / 100).toFixed(2);
    if (amountStr.endsWith('.01'))
      return { status: 'declined', errorMessage: 'Simulated decline (.01)' };
    if (amountStr.endsWith('.02'))
      return { status: 'error', errorMessage: 'Simulated error (.02)' };
    const charge = await storage.get(request.chargeReference);
    if (!charge || charge.status !== 'approved')
      return {
        status: 'error',
        errorMessage: 'Charge was not approved in simulated store',
      };
    const result = {
      status: 'refunded' as const,
      processorRefundId: `sim_refund_${randomUUID()}`,
    };
    await storage.set(request.refundReference, {
      status: 'approved',
      processorTransactionId: result.processorRefundId,
    });
    return result;
  },
  async getRefundStatus(request, config, storage) {
    const result = await storage.get(request.refundReference);
    if (!result)
      return {
        status: 'error',
        errorMessage: 'Refund not found in simulated store',
      };
    if (result.processorTransactionId)
      return {
        status: 'refunded',
        processorRefundId: result.processorTransactionId,
      };
    return { status: 'error', errorMessage: 'Refund result is unavailable' };
  },
};

export const processors: PaymentProcessor<any>[] = [simulatedProcessor];

export const processorConnectionConfigSchema = z.object({
  processorId: z.enum(['sola', 'cardknox', 'usaepay', 'other']),
  apiKey: z.string().trim().min(1).max(1000),
  mode: z.enum(['test', 'live']),
});
export type ProcessorConnectionConfig = z.infer<
  typeof processorConnectionConfigSchema
>;

export interface ProcessorConnectionTestResult {
  ok: boolean;
  message: string;
}

const TEST_CARD = '4444333322221111';
const TEST_EXPIRY = '1230';
const TEST_AMOUNT = '0.01';

async function jsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function approved(value: Record<string, unknown>): boolean {
  return (
    value.xResult === 'A' ||
    value.result_code === 'A' ||
    value.result === 'Approved'
  );
}

function reference(value: Record<string, unknown>): string | null {
  for (const key of ['xRefNum', 'refnum', 'ref_num', 'key']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number')
      return String(value[key]);
  }
  return null;
}

export async function testProcessorConnection(
  config: ProcessorConnectionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProcessorConnectionTestResult> {
  try {
    processorConnectionConfigSchema.parse(config);
    if (config.processorId === 'other')
      return {
        ok: false,
        message: 'Choose Sola, Cardknox, or USAePay to test a connection.',
      };

    if (config.processorId === 'usaepay') {
      const response = await fetchImpl(
        'https://sandbox.usaepay.com/api/v2/transactions',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.apiKey}:`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            command: 'authonly',
            amount: TEST_AMOUNT,
            creditcard: {
              number: TEST_CARD,
              expiration: TEST_EXPIRY,
              cvc: '123',
            },
          }),
        },
      );
      const auth = await jsonResponse(response);
      if (!response.ok || !approved(auth))
        return {
          ok: false,
          message: 'USAePay did not approve the test authorization.',
        };
      const ref = reference(auth);
      if (!ref)
        return {
          ok: false,
          message: 'USAePay approved the test but returned no reference.',
        };
      const voidResponse = await fetchImpl(
        'https://sandbox.usaepay.com/api/v2/transactions',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.apiKey}:`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command: 'void', refnum: ref }),
        },
      );
      const voided = await jsonResponse(voidResponse);
      if (!voidResponse.ok || !approved(voided))
        return {
          ok: false,
          message: 'USAePay approved the test, but could not void it.',
        };
      return {
        ok: true,
        message: 'USAePay test authorization succeeded and was voided.',
      };
    }

    const gateway =
      config.processorId === 'sola'
        ? 'https://secure.solapayments.com/gatewayjson'
        : 'https://x1.cardknox.com/gatewayjson';
    const base = {
      xKey: config.apiKey,
      xVersion: '5.0.0',
      xSoftwareName: 'Shul Store Manager',
      xSoftwareVersion: '0.1.0',
    };
    const authResponse = await fetchImpl(gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...base,
        xCommand: 'cc:authonly',
        xAmount: TEST_AMOUNT,
        xCardNum: TEST_CARD,
        xExp: TEST_EXPIRY,
      }),
    });
    const auth = await jsonResponse(authResponse);
    if (!authResponse.ok || !approved(auth))
      return {
        ok: false,
        message: `${config.processorId === 'sola' ? 'Sola' : 'Cardknox'} did not approve the test authorization.`,
      };
    const ref = reference(auth);
    if (!ref)
      return {
        ok: false,
        message: 'The processor approved the test but returned no reference.',
      };
    const voidResponse = await fetchImpl(gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, xCommand: 'cc:void', xRefNum: ref }),
    });
    const voided = await jsonResponse(voidResponse);
    if (!voidResponse.ok || !approved(voided))
      return {
        ok: false,
        message: 'The processor approved the test, but could not void it.',
      };
    return {
      ok: true,
      message: `${config.processorId === 'sola' ? 'Sola' : 'Cardknox'} test authorization succeeded and was voided.`,
    };
  } catch {
    return {
      ok: false,
      message:
        'Could not reach the processor sandbox. Check the key and try again.',
    };
  }
}
