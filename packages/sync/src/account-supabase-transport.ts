import type {
  CloudEvent,
  ConnectionTestResult,
  SyncEntityType,
  SyncOperation,
} from '@shul-store/shared';
import type { PushAck, SyncTransport } from './transport.js';

type FetchImpl = typeof globalThis.fetch;

export interface AccountSupabaseTransportOptions {
  supabaseUrl: string;
  anonKey: string;
  deviceId: string;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
  fetchImpl?: FetchImpl;
}

interface AccountEventRow {
  id: number;
  event_id: string;
  store_id: string;
  device_id: string;
  sequence: number;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: SyncOperation;
  payload: unknown;
  created_at: string;
}

function restBase(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/\/rest\/v1$/.test(url)) url = `${url}/rest/v1`;
  return url;
}

function describe(status: number, action: string): string {
  if (status === 401 || status === 403)
    return `${action} failed: authentication was rejected.`;
  if (status === 404)
    return `${action} failed: the store sync table was not found.`;
  return `${action} failed: the server returned HTTP ${status}.`;
}

export class AccountSupabaseTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(private readonly options: AccountSupabaseTransportOptions) {
    this.baseUrl = restBase(options.supabaseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private async request(
    input: string,
    init: RequestInit,
    action: string,
  ): Promise<Response> {
    let token = await this.options.getAccessToken(false);
    const send = () =>
      this.fetchImpl(input, {
        ...init,
        headers: {
          apikey: this.options.anonKey,
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    let response: Response;
    try {
      response = await send();
    } catch {
      throw new Error(
        `Could not reach the cloud while ${action.toLowerCase()}.`,
      );
    }
    if (response.status === 401) {
      token = await this.options.getAccessToken(true);
      try {
        response = await send();
      } catch {
        throw new Error(
          `Could not reach the cloud while ${action.toLowerCase()}.`,
        );
      }
    }
    if (!response.ok) throw new Error(describe(response.status, action));
    return response;
  }

  async pushEvents(events: CloudEvent[]): Promise<PushAck> {
    if (events.length === 0) return { acknowledgedEventIds: [] };
    const rows = events.map((event) => ({
      event_id: event.eventId,
      store_id: event.storeId,
      device_id: event.deviceId ?? this.options.deviceId,
      sequence: event.sequence,
      entity_type: event.entityType,
      entity_id: event.entityId,
      operation: event.operation,
      payload: event.payload,
      created_at: event.createdAt,
    }));
    await this.request(
      `${this.baseUrl}/store_sync_events?on_conflict=event_id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates',
        },
        body: JSON.stringify(rows),
      },
      'Pushing events',
    );
    return { acknowledgedEventIds: events.map((event) => event.eventId) };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      await this.request(
        `${this.baseUrl}/store_sync_events?select=id&limit=1`,
        { method: 'GET' },
        'Testing the cloud connection',
      );
      return { ok: true, reachable: true, message: 'Connected successfully.' };
    } catch (error) {
      return {
        ok: false,
        reachable: true,
        message: error instanceof Error ? error.message : 'Connection failed.',
      };
    }
  }

  async listEvents(
    storeId: string,
    afterSequence: number,
  ): Promise<CloudEvent[]> {
    const rows = await this.fetchRows(
      `${this.baseUrl}/store_sync_events?store_id=eq.${encodeURIComponent(storeId)}` +
        `&id=gt.${afterSequence}&order=id.asc&select=id,event_id,store_id,device_id,sequence,entity_type,entity_id,operation,payload,created_at&limit=500`,
      'Downloading cloud events',
    );
    return rows.map(toCloudEvent);
  }

  async listEventsSince(
    storeId: string,
    pullCursor: number,
    deviceId: string,
  ): Promise<CloudEvent[]> {
    const rows = await this.fetchRows(
      `${this.baseUrl}/store_sync_events?store_id=eq.${encodeURIComponent(storeId)}` +
        `&id=gt.${pullCursor}&device_id=neq.${encodeURIComponent(deviceId)}` +
        `&order=id.asc&select=id,event_id,store_id,device_id,sequence,entity_type,entity_id,operation,payload,created_at&limit=500`,
      'Downloading cloud events',
    );
    return rows.map(toCloudEvent);
  }

  async claimDevicePrefix(storeId: string, deviceId: string): Promise<number> {
    const existing = await this.fetchRows<Array<{ prefix: number }>>(
      `${this.baseUrl}/store_devices?store_id=eq.${encodeURIComponent(storeId)}` +
        `&device_id=eq.${encodeURIComponent(deviceId)}&select=prefix&limit=1`,
      'Checking the cloud device registration',
    );
    if (existing.length > 0)
      return Number((existing[0] as { prefix: number }).prefix);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rows = await this.fetchRows<Array<{ prefix: number }>>(
        `${this.baseUrl}/store_devices?store_id=eq.${encodeURIComponent(storeId)}&select=prefix`,
        'Reading cloud device registrations',
      );
      const prefix =
        rows.reduce(
          (maximum, row) => Math.max(maximum, Number(row.prefix)),
          0,
        ) + 1;
      if (prefix > 8999)
        throw new Error('This cloud store has reached its device limit.');
      try {
        await this.request(
          `${this.baseUrl}/store_devices`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({
              store_id: storeId,
              device_id: deviceId,
              prefix,
            }),
          },
          'Registering this device',
        );
        return prefix;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('HTTP 409'))
          throw error;
      }
    }
    throw new Error('Could not claim a unique cloud device prefix.');
  }

  private async fetchRows<T extends unknown[] = AccountEventRow[]>(
    url: string,
    action: string,
  ): Promise<T> {
    const response = await this.request(url, { method: 'GET' }, action);
    return (await response.json()) as T;
  }
}

function toCloudEvent(row: AccountEventRow): CloudEvent {
  return {
    cloudId: Number(row.id),
    eventId: String(row.event_id),
    storeId: String(row.store_id),
    deviceId: String(row.device_id),
    sequence: Number(row.sequence),
    entityType: row.entity_type,
    entityId: String(row.entity_id),
    operation: row.operation,
    payload: row.payload,
    createdAt: String(row.created_at),
  };
}
