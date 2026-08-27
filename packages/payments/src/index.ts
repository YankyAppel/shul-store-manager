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
  processorTransactionId?: string;
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
    request: Pick<
      RefundRequest,
      | 'chargeReference'
      | 'refundReference'
      | 'processorTransactionId'
      | 'amountCents'
    >,
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

export const cardknoxBbposConfigSchema = z.object({
  apiKey: z.string().trim().min(1).max(1000),
  deviceName: z.string().trim().min(1).max(200),
  connection: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('usb'),
      comPort: z.string().trim().min(1).max(100),
    }),
    z.object({
      kind: z.literal('ip'),
      address: z.string().trim().min(1).max(255),
      port: z.number().int().min(1).max(65535),
    }),
  ]),
  silentMode: z.boolean().default(false),
  readerOnly: z.boolean().default(false),
  amountConfirmationPrompt: z.boolean().default(false),
  deviceTimeoutSeconds: z.number().int().min(1).max(600).default(120),
  mode: z.enum(['test', 'live']).default('live'),
});
export type CardknoxBbposConfig = z.infer<typeof cardknoxBbposConfigSchema>;

const BBPOS_ENDPOINT = 'https://localemv.com:8887';
const CARDKNOX_GATEWAY_ENDPOINT = 'https://x1.cardknox.com/gatewayjson';
const CARDKNOX_REPORT_ENDPOINT = 'https://x1.cardknox.com/reportjson';
const BBPOS_INSTALL_URL = 'https://cdn.cardknox.com/dl/bbpos.exe';

type FetchImplementation = typeof fetch;

function bbposFields(
  config: CardknoxBbposConfig,
  command: string,
  invoice?: string,
): Record<string, string> {
  const fields: Record<string, string> = {
    ...bbposDeviceFields(config),
    xCommand: command,
    xEnableSilentMode: config.silentMode ? '1' : '0',
    xEnableAmountConfirmationPrompt: config.amountConfirmationPrompt
      ? '1'
      : '0',
  };
  if (config.readerOnly) fields.xEnableKeyedEntry = '1';
  if (invoice) fields.xInvoice = invoice;
  return fields;
}

function bbposDeviceFields(
  config: CardknoxBbposConfig,
): Record<string, string> {
  const fields: Record<string, string> = {
    xResponseFormat: 'JSON',
    xKey: config.apiKey,
    xDeviceName: config.deviceName,
    xDeviceTimeOut: String(config.deviceTimeoutSeconds),
  };
  if (config.connection.kind === 'usb') {
    fields.xDeviceComPort = config.connection.comPort;
  } else {
    fields.xDeviceIPAddress = config.connection.address;
    fields.xDeviceIPPort = String(config.connection.port);
  }
  return fields;
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function bbposJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  if (!response.ok) return null;
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resultCode(value: Record<string, unknown>): string {
  for (const key of [
    'xResult',
    'xResponseResult',
    'result_code',
    'result',
    'xStatus',
  ]) {
    const candidate = value[key];
    if (typeof candidate === 'string') return candidate.trim().toLowerCase();
  }
  return '';
}

function approvedCharge(value: Record<string, unknown>): boolean {
  const code = resultCode(value);
  return code === 'a' || code === 'approved' || code === 'success';
}

function declinedCharge(value: Record<string, unknown>): boolean {
  const code = resultCode(value);
  return code === 'd' || code === 'declined' || code === 'decline';
}

function responseText(value: Record<string, unknown>): string | undefined {
  for (const key of ['xError', 'xErrorMessage', 'xMessage', 'message']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key]
        .trim()
        .replace(
          /(?<!\d)(?:\d[\s-]?){11,18}\d(?!\d)/g,
          '[redacted card number]',
        );
    }
  }
  return undefined;
}

function transactionReference(
  value: Record<string, unknown>,
): string | undefined {
  for (const key of ['xRefNum', 'xTransactionId', 'refnum', 'ref_num']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number')
      return String(value[key]);
  }
  return undefined;
}

function cardBrand(value: Record<string, unknown>): string | undefined {
  for (const key of ['xCardType', 'xCardBrand', 'cardBrand']) {
    if (typeof value[key] === 'string' && value[key].trim())
      return value[key].trim();
  }
  return undefined;
}

function cardLast4(value: Record<string, unknown>): string | undefined {
  for (const key of [
    'xMaskedCardNumber',
    'xCardNumber',
    'xCardNum',
    'cardLast4',
  ]) {
    if (typeof value[key] !== 'string' && typeof value[key] !== 'number')
      continue;
    const digits = String(value[key]).replace(/\D/g, '');
    if (digits.length >= 4) return digits.slice(-4);
  }
  return undefined;
}

function bbposPending(message: string): ChargeResult {
  return { status: 'pending', errorMessage: message };
}

function unreachableMessage(): string {
  return `The card reader could not be reached. Install BBPOS (${BBPOS_INSTALL_URL}), ask Sola to activate BBPOS on the account, and use a reader bought key-injected from Sola.`;
}

async function postBbpos(
  fields: Record<string, string>,
  fetchImpl: FetchImplementation,
): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(BBPOS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(fields),
  });
  return bbposJson(response);
}

type ReportLookup =
  | { kind: 'found'; transaction: Record<string, unknown> }
  | { kind: 'not-found' }
  | { kind: 'ambiguous' };

function reportRows(
  body: Record<string, unknown>,
): Record<string, unknown>[] | null {
  const data = body.xReportData ?? body.reportData;
  if (Array.isArray(data))
    return data.filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === 'object',
    );
  if (data && typeof data === 'object')
    return [data as Record<string, unknown>];
  if (typeof data !== 'string' || !data.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (Array.isArray(parsed))
      return parsed.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === 'object',
      );
    if (parsed && typeof parsed === 'object')
      return [parsed as Record<string, unknown>];
  } catch {
    return null;
  }
  return null;
}

function reportInvoice(
  transaction: Record<string, unknown>,
): string | undefined {
  for (const key of ['xInvoice', 'invoice', 'invoiceNumber']) {
    const value = transaction[key];
    if (typeof value === 'string' || typeof value === 'number')
      return String(value);
  }
  return undefined;
}

function classifyReport(
  body: Record<string, unknown>,
  invoice: string,
): ReportLookup {
  const result = resultCode(body);
  if (result && !['a', 'approved', 's', 'success'].includes(result))
    return { kind: 'ambiguous' };
  const rows = reportRows(body);
  const recordsReturned = Number(
    body.xRecordsReturned ?? body.recordsReturned ?? NaN,
  );
  if (recordsReturned === 0 || (rows && rows.length === 0))
    return { kind: 'not-found' };
  if (!rows) return { kind: 'ambiguous' };
  const matching = rows.filter((row) => reportInvoice(row) === invoice);
  const matchingTransaction = matching[0];
  if (matching.length === 1 && matchingTransaction)
    return { kind: 'found', transaction: matchingTransaction };
  if (matching.length > 1) return { kind: 'ambiguous' };
  const onlyTransaction = rows[0];
  if (rows.length === 1 && onlyTransaction && !reportInvoice(onlyTransaction))
    return { kind: 'found', transaction: onlyTransaction };
  return { kind: 'ambiguous' };
}

async function lookupReport(
  invoice: string,
  config: CardknoxBbposConfig,
  fetchImpl: FetchImplementation,
): Promise<ReportLookup> {
  try {
    const response = await fetchImpl(CARDKNOX_REPORT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        xKey: config.apiKey,
        xVersion: '5.0.0',
        xSoftwareName: 'Shul Store Manager',
        xSoftwareVersion: '0.1.0',
        xCommand: 'Report:Transactions',
        xInvoice: invoice,
      }),
    });
    const body = await bbposJson(response);
    return body ? classifyReport(body, invoice) : { kind: 'ambiguous' };
  } catch {
    return { kind: 'ambiguous' };
  }
}

export function createCardknoxBbposProcessor(
  fetchImpl: FetchImplementation = fetch,
): PaymentProcessor<CardknoxBbposConfig> {
  return {
    id: 'cardknox-bbpos',
    displayName: 'Sola / Cardknox BBPOS card reader',
    configSchema: cardknoxBbposConfigSchema,
    async createCharge(request, rawConfig, storage) {
      const config = cardknoxBbposConfigSchema.parse(rawConfig);
      let body: Record<string, unknown> | null;
      try {
        body = await postBbpos(
          {
            ...bbposFields(config, 'cc:sale', request.chargeReference),
            xAmount: (request.amountCents / 100).toFixed(2),
          },
          fetchImpl,
        );
      } catch {
        const result = bbposPending(unreachableMessage());
        await storage.set(request.chargeReference, result);
        return result;
      }
      if (!body) {
        const result = bbposPending(
          'The card reader did not answer. The payment needs attention; do not try the card again.',
        );
        await storage.set(request.chargeReference, result);
        return result;
      }
      let result: ChargeResult;
      if (approvedCharge(body)) {
        const processorTransactionId = transactionReference(body);
        const brand = cardBrand(body);
        const last4 = cardLast4(body);
        result = processorTransactionId
          ? {
              status: 'approved',
              processorTransactionId,
              ...(brand !== undefined ? { cardBrand: brand } : {}),
              ...(last4 !== undefined ? { cardLast4: last4 } : {}),
            }
          : {
              status: 'pending',
              errorMessage:
                'The reader approved a payment but returned no transaction reference. The payment needs attention.',
            };
      } else if (declinedCharge(body)) {
        result = {
          status: 'declined',
          declineReason:
            responseText(body) ?? 'The card was declined by the processor.',
        };
      } else {
        result = bbposPending(
          responseText(body) ??
            'The card reader returned an unclear response. The payment needs attention.',
        );
      }
      await storage.set(request.chargeReference, result);
      return result;
    },
    async getChargeStatus(chargeReference, rawConfig, storage) {
      const config = cardknoxBbposConfigSchema.parse(rawConfig);
      const stored = await storage.get(chargeReference);
      if (stored?.status === 'approved' || stored?.status === 'declined')
        return stored;
      const lookup = await lookupReport(chargeReference, config, fetchImpl);
      if (lookup.kind === 'found') {
        const transaction = lookup.transaction;
        const processorTransactionId = transactionReference(transaction);
        if (approvedCharge(transaction) && processorTransactionId) {
          const brand = cardBrand(transaction);
          const last4 = cardLast4(transaction);
          const result: ChargeResult = {
            status: 'approved',
            processorTransactionId,
            ...(brand !== undefined ? { cardBrand: brand } : {}),
            ...(last4 !== undefined ? { cardLast4: last4 } : {}),
          };
          await storage.set(chargeReference, result);
          return result;
        }
        if (declinedCharge(transaction) || !approvedCharge(transaction)) {
          const reason = responseText(transaction);
          const result: ChargeResult = {
            status: 'declined',
            ...(reason ? { declineReason: reason } : {}),
          };
          await storage.set(chargeReference, result);
          return result;
        }
      }
      throw new Error(
        'BBPOS does not provide a safe status lookup for a lost response. This payment needs attention.',
      );
    },
    async cancelCharge(chargeReference, rawConfig) {
      const config = cardknoxBbposConfigSchema.parse(rawConfig);
      const body = await postBbpos(
        { ...bbposDeviceFields(config), xCancel: '1' },
        fetchImpl,
      );
      if (!body)
        throw new Error(
          'The reader did not confirm cancellation. The payment needs attention.',
        );
    },
    async refundCharge(request, rawConfig, storage) {
      const config = cardknoxBbposConfigSchema.parse(rawConfig);
      try {
        const response = await fetchImpl(CARDKNOX_GATEWAY_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            xKey: config.apiKey,
            xCommand: 'cc:refund',
            xRefNum: request.processorTransactionId ?? request.chargeReference,
            xAmount: (request.amountCents / 100).toFixed(2),
            xInvoice: request.refundReference,
          }),
        });
        const body = await bbposJson(response);
        if (!body)
          return {
            status: 'error',
            errorMessage: 'The refund processor did not answer.',
          };
        if (!approvedCharge(body))
          return {
            status: 'declined',
            errorMessage: responseText(body) ?? 'The refund was declined.',
          };
        const processorRefundId = transactionReference(body);
        const result: RefundResult = {
          status: 'refunded',
          ...(processorRefundId ? { processorRefundId } : {}),
        };
        await storage.set(request.refundReference, {
          status: 'approved',
          ...(processorRefundId
            ? { processorTransactionId: processorRefundId }
            : {}),
        });
        return result;
      } catch {
        return {
          status: 'error',
          errorMessage: 'The refund could not be sent.',
        };
      }
    },
    async getRefundStatus(request, rawConfig, storage) {
      const config = cardknoxBbposConfigSchema.parse(rawConfig);
      const stored = await storage.get(request.refundReference);
      if (stored?.status === 'approved')
        return {
          status: 'refunded',
          ...(stored.processorTransactionId
            ? { processorRefundId: stored.processorTransactionId }
            : {}),
        };
      const lookup = await lookupReport(
        request.refundReference,
        config,
        fetchImpl,
      );
      if (lookup.kind === 'found') {
        const transaction = lookup.transaction;
        if (approvedCharge(transaction)) {
          const processorRefundId = transactionReference(transaction);
          if (!processorRefundId)
            return {
              status: 'error',
              errorMessage:
                'The refund report was missing its transaction reference; the refund needs attention.',
            };
          await storage.set(request.refundReference, {
            status: 'approved',
            processorTransactionId: processorRefundId,
          });
          return { status: 'refunded', processorRefundId };
        }
        const reason = responseText(transaction);
        return {
          status: 'declined',
          ...(reason ? { errorMessage: reason } : {}),
        };
      }
      return {
        status: 'error',
        errorMessage:
          'The refund status is unavailable; the refund needs attention.',
      };
    },
  };
}

export const cardknoxBbposProcessor = createCardknoxBbposProcessor();

export async function checkCardknoxBbposReader(
  rawConfig: CardknoxBbposConfig,
  fetchImpl: FetchImplementation = fetch,
): Promise<{ ok: boolean; message: string }> {
  try {
    const config = cardknoxBbposConfigSchema.parse(rawConfig);
    const body = await postBbpos(
      bbposFields(config, 'Device_ShowWelcomeScreen'),
      fetchImpl,
    );
    if (!body) return { ok: false, message: unreachableMessage() };
    if (approvedCharge(body) || resultCode(body) === 'ok')
      return { ok: true, message: 'The BBPOS reader was found and woke up.' };
    return {
      ok: false,
      message: responseText(body) ?? 'BBPOS could not wake the reader.',
    };
  } catch {
    return { ok: false, message: unreachableMessage() };
  }
}

export const processors: PaymentProcessor<any>[] = [
  simulatedProcessor,
  cardknoxBbposProcessor,
];

export const processorConnectionConfigSchema = z.object({
  processorId: z.enum(['sola', 'cardknox', 'usaepay', 'other']),
  apiKey: z.string().trim().max(1000),
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
const SOLA_TEST_KEY = 'SolaSupport_Test';

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

function endpoint(
  processorId: Exclude<ProcessorConnectionConfig['processorId'], 'other'>,
  mode: ProcessorConnectionConfig['mode'],
): string {
  if (processorId === 'usaepay')
    return mode === 'test'
      ? 'https://sandbox.usaepay.com/api/v2/transactions'
      : 'https://usaepay.com/api/v2/transactions';
  if (processorId === 'sola')
    return mode === 'test'
      ? 'https://x1.cardknox.com/gatewayjson'
      : 'https://x1.cardknox.com/gatewayjson';
  return 'https://x1.cardknox.com/gatewayjson';
}

export async function testProcessorConnection(
  input: ProcessorConnectionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProcessorConnectionTestResult> {
  try {
    const config = processorConnectionConfigSchema.parse(input);
    if (config.processorId === 'other')
      return {
        ok: false,
        message: 'Choose Sola, Cardknox, or USAePay to test a connection.',
      };
    if (config.mode === 'live')
      return {
        ok: false,
        message:
          'Live keys are not charged for a test. They are proven by the first real sale.',
      };

    if (config.processorId === 'usaepay') {
      if (!config.apiKey)
        return {
          ok: false,
          message: 'Enter the USAePay key before testing the connection.',
        };
      const usaepayEndpoint = endpoint(config.processorId, config.mode);
      const response = await fetchImpl(usaepayEndpoint, {
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
      });
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
      const voidResponse = await fetchImpl(usaepayEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.apiKey}:`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: 'void', refnum: ref }),
      });
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

    const gateway = endpoint(config.processorId, config.mode);
    const apiKey = config.apiKey || SOLA_TEST_KEY;
    const base = {
      xKey: apiKey,
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
