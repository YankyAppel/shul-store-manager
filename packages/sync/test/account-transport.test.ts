import { describe, expect, it } from 'vitest';
import { AccountSupabaseTransport } from '../src/index.js';

const STORE_ID = '00000000-0000-0000-0000-000000000001';
const DEVICE_ID = '00000000-0000-0000-0000-000000000002';

describe('account Supabase transport', () => {
  it('refreshes the access token once after a 401', async () => {
    const requests: Request[] = [];
    const tokens: Array<boolean | undefined> = [];
    let call = 0;
    const transport = new AccountSupabaseTransport({
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'public-anon-key',
      deviceId: DEVICE_ID,
      getAccessToken: async (forceRefresh) => {
        tokens.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'stale-token';
      },
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        return call === 1
          ? new Response(null, { status: 401 })
          : new Response('[]', { status: 200 });
      },
    });

    await expect(
      transport.listEventsSince(STORE_ID, 0, DEVICE_ID),
    ).resolves.toEqual([]);
    expect(tokens).toEqual([false, true]);
    expect(
      requests.map((request) => request.headers.get('authorization')),
    ).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
    expect(requests[0].headers.get('apikey')).toBe('public-anon-key');
  });

  it('retries a raced device-prefix claim and keeps prefixes distinct', async () => {
    let prefixReads = 0;
    let registrations = 0;
    const transport = new AccountSupabaseTransport({
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'public-anon-key',
      deviceId: DEVICE_ID,
      getAccessToken: async () => 'access-token',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('device_id=eq.')) return new Response('[]');
        if (url.includes('select=prefix')) {
          prefixReads += 1;
          return new Response(prefixReads === 1 ? '[]' : '[{"prefix":1}]', {
            status: 200,
          });
        }
        registrations += 1;
        return registrations === 1
          ? new Response(null, { status: 409 })
          : new Response(null, { status: 201 });
      },
    });

    await expect(
      transport.claimDevicePrefix(STORE_ID, DEVICE_ID),
    ).resolves.toBe(2);
    expect(registrations).toBe(2);
    expect(prefixReads).toBe(2);
  });
});
