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
};

export const processors: PaymentProcessor<any>[] = [simulatedProcessor];
