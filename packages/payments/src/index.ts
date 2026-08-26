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
