import type {
  CloudEvent,
  ConnectionTestResult,
  SyncEntityType,
  SyncOperation,
} from '@shul-store/shared';
import type { PushAck, SyncTransport } from './transport.js';

type FetchImpl = typeof globalThis.fetch;

interface SupabaseTransportOptions {
  supabaseUrl: string;
  apiKey: string;
  fetchImpl?: FetchImpl;
  pageSize?: number;
}

interface CloudEventRow {
  event_id: string;
  store_id: string;
  sequence: number;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: SyncOperation;
  payload: unknown;
  created_at: string;
}

/** Normalise the project URL into a PostgREST base, e.g.
 *  "https://x.supabase.co" -> "https://x.supabase.co/rest/v1". */
function restBase(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/\/rest\/v1$/.test(url)) url = `${url}/rest/v1`;
  return url;
}

/** Convert an HTTP failure into a sanitised message that never contains the key. */
function describeHttpFailure(response: Response, action: string): string {
  const status = response.status;
  if (status === 401 || status === 403)
    return `${action} failed: authentication rejected (${status}). Check the API key.`;
  if (status === 404)
    return `${action} failed: the sync_events table was not found (${status}). Apply the cloud DDL from docs/cloud-sync.md.`;
  return `${action} failed: the server returned HTTP ${status}.`;
}

/**
 * Supabase transport using plain HTTPS calls to the PostgREST endpoint. No
 * supabase-js SDK dependency is required: a single upsert (idempotent on
 * event_id via `on_conflict` + `Prefer: resolution=ignore-duplicates`) and a
 * paginated ordered read are all the engine needs.
 */
export class SupabaseTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchImpl;
  private readonly pageSize: number;

  constructor(options: SupabaseTransportOptions) {
    this.baseUrl = restBase(options.supabaseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.pageSize = options.pageSize ?? 1000;
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async pushEvents(events: CloudEvent[]): Promise<PushAck> {
    if (events.length === 0) return { acknowledgedEventIds: [] };
    const rows: CloudEventRow[] = events.map((event) => ({
      event_id: event.eventId,
      store_id: event.storeId,
      sequence: event.sequence,
      entity_type: event.entityType,
      entity_id: event.entityId,
      operation: event.operation,
      payload: event.payload,
      created_at: event.createdAt,
    }));
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/sync_events?on_conflict=event_id`,
        {
          method: 'POST',
          headers: {
            ...this.headers(true),
            Prefer: 'resolution=ignore-duplicates',
          },
          body: JSON.stringify(rows),
        },
      );
    } catch {
      throw new Error(
        'Could not reach the Supabase project (network error). The local store is unaffected; sync will retry.',
      );
    }
    if (!response.ok) {
      throw new Error(describeHttpFailure(response, 'Pushing events'));
    }
    // With ignore-duplicates the server accepts every idempotently; acknowledge
    // all pushed ids so the outbox can mark them.
    return { acknowledgedEventIds: events.map((event) => event.eventId) };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/sync_events?select=event_id&limit=1`,
        { method: 'GET', headers: this.headers() },
      );
    } catch {
      return {
        ok: false,
        reachable: false,
        message:
          'Could not reach the Supabase project. Check the URL and your internet connection.',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reachable: true,
        message: 'Reached the project, but the API key was rejected.',
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        reachable: true,
        message:
          'Reached the project, but the sync_events table was not found. Apply the cloud DDL from docs/cloud-sync.md.',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reachable: true,
        message: `Reached the project, but it returned HTTP ${response.status}.`,
      };
    }
    return {
      ok: true,
      reachable: true,
      message: 'Connected successfully. The sync_events table is reachable.',
    };
  }

  async listEvents(
    storeId: string,
    afterSequence: number,
  ): Promise<CloudEvent[]> {
    const collected: CloudEvent[] = [];
    let offset = 0;
    // Paginate until a page returns fewer rows than the page size.
    for (;;) {
      const url =
        `${this.baseUrl}/sync_events?store_id=eq.${encodeURIComponent(storeId)}` +
        `&sequence=gt.${afterSequence}` +
        `&order=sequence.asc&select=event_id,store_id,sequence,entity_type,entity_id,operation,payload,created_at` +
        `&limit=${this.pageSize}&offset=${offset}`;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.headers(),
        });
      } catch {
        throw new Error(
          'Could not reach the Supabase project while downloading events (network error).',
        );
      }
      if (!response.ok) {
        throw new Error(describeHttpFailure(response, 'Downloading events'));
      }
      const rows = (await response.json()) as CloudEventRow[];
      for (const row of rows) {
        collected.push({
          eventId: String(row.event_id),
          storeId: String(row.store_id),
          sequence: Number(row.sequence),
          entityType: row.entity_type,
          entityId: String(row.entity_id),
          operation: row.operation,
          payload: row.payload,
          createdAt: String(row.created_at),
        });
      }
      if (rows.length < this.pageSize) break;
      offset += this.pageSize;
    }
    collected.sort((a, b) => a.sequence - b.sequence);
    return collected;
  }
}
