import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreDatabase } from '@shul-store/database';
import { PlaintextSecretStore } from '@shul-store/shared';
import { SyncEngine, type SyncTransport } from '@shul-store/sync';
import { CloudAccountManager } from '../electron/cloud-account.js';

const secretStore = new PlaintextSecretStore();
const files: string[] = [];

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

function accountFile(): string {
  const file = path.join(tmpdir(), `shul-cloud-account-${randomUUID()}.json`);
  files.push(file);
  return file;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudAccountManager', () => {
  it('refreshes the token after a 401 without exposing credentials in state', async () => {
    const file = accountFile();
    const calls: string[] = [];
    let storeRequestCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/store/config'))
        return jsonResponse({
          supabase_url: 'https://supabase.example',
          supabase_anon_key: 'anon-key',
        });
      if (url.includes('/auth/v1/token?grant_type=password'))
        return jsonResponse({
          access_token: 'old-access',
          refresh_token: 'refresh-one',
          expires_in: 3600,
          user: { email: 'owner@example.com' },
        });
      if (url.includes('/auth/v1/token?grant_type=refresh_token'))
        return jsonResponse({
          access_token: 'new-access',
          refresh_token: 'refresh-two',
          expires_in: 3600,
        });
      if (url.endsWith('/api/store/account')) {
        storeRequestCount += 1;
        return storeRequestCount === 1
          ? jsonResponse({ error: 'expired' }, 401)
          : jsonResponse({
              account: { store_id: '11111111-1111-4111-8111-111111111111' },
            });
      }
      if (url.endsWith('/api/store/entitlement'))
        return jsonResponse({
          tier: 'standalone',
          active: false,
          price: 10,
          status: 'inactive',
          current_period_end: null,
        });
      throw new Error(`Unexpected request: ${url} ${init?.method ?? ''}`);
    };

    const manager = new CloudAccountManager(file, secretStore, fetchImpl);
    const state = await manager.signIn('owner@example.com', 'password');

    expect(state).toEqual({
      email: 'owner@example.com',
      signedIn: true,
      entitlement: {
        tier: 'standalone',
        active: false,
        price: 10,
        status: 'inactive',
        current_period_end: null,
      },
    });
    expect(
      calls.filter((url) => url.endsWith('/api/store/account')),
    ).toHaveLength(2);
    expect(
      calls.filter((url) => url.includes('grant_type=refresh_token')),
    ).toHaveLength(1);
    const persisted = await readFile(file, 'utf8');
    expect(persisted).not.toContain('old-access');
    expect(persisted).not.toContain('new-access');
    expect(persisted).not.toContain('refresh-one');
    expect(persisted).not.toContain('refresh-two');
    expect(JSON.stringify(state)).not.toMatch(/access|refresh|anon-key/i);
  });

  it('signs out when a proactive token refresh fails', async () => {
    const file = accountFile();
    await writeFile(
      file,
      JSON.stringify({
        accountStarted: true,
        siteUrl: 'https://site.example',
        supabaseUrl: 'https://supabase.example',
        supabaseAnonKey: 'anon-key',
        email: 'owner@example.com',
        accessToken: secretStore.encrypt('expired-access'),
        refreshToken: secretStore.encrypt('refresh-token'),
        expiresAt: Date.now() - 1,
        entitlement: null,
        entitlementFetchedAt: null,
      }),
    );
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/auth/v1/token?grant_type=refresh_token'))
        return jsonResponse({ error: 'invalid refresh token' }, 400);
      throw new Error(`Unexpected request: ${url}`);
    };
    const manager = new CloudAccountManager(file, secretStore, fetchImpl);

    await expect(manager.linkHint()).rejects.toThrow(
      'Your session expired. Please sign in again.',
    );
    await expect(manager.getState()).resolves.toMatchObject({
      email: null,
      signedIn: false,
      entitlement: null,
    });
  });

  it('keeps the cached entitlement when the server response is invalid', async () => {
    const file = accountFile();
    const entitlement = {
      tier: 'linked',
      active: true,
      price: 5,
      status: 'active',
      current_period_end: null,
    };
    const fetchedAt = Date.now() - 60_000;
    await writeFile(
      file,
      JSON.stringify({
        accountStarted: true,
        siteUrl: 'https://site.example',
        supabaseUrl: 'https://supabase.example',
        supabaseAnonKey: 'anon-key',
        email: 'owner@example.com',
        accessToken: secretStore.encrypt('access'),
        refreshToken: secretStore.encrypt('refresh'),
        expiresAt: Date.now() + 3600000,
        entitlement,
        entitlementFetchedAt: fetchedAt,
      }),
    );
    const manager = new CloudAccountManager(file, secretStore, async () =>
      jsonResponse({ active: 'yes' }),
    );

    await expect(manager.refresh(true)).resolves.toMatchObject({
      entitlement: { tier: 'linked', active: true },
    });
    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      entitlement: unknown;
      entitlementFetchedAt: number;
    };
    expect(persisted.entitlement).toEqual(entitlement);
    expect(persisted.entitlementFetchedAt).toBe(fetchedAt);
  });

  it('returns a confirmation state for sign-up without an access token', async () => {
    const file = accountFile();
    const calls: string[] = [];
    const manager = new CloudAccountManager(
      file,
      secretStore,
      async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/api/store/config'))
          return jsonResponse({
            supabase_url: 'https://supabase.example',
            supabase_anon_key: 'anon-key',
          });
        if (url.includes('/auth/v1/signup'))
          return jsonResponse({
            user: { email: 'new@example.com' },
          });
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    await expect(
      manager.signUp('new@example.com', 'password123'),
    ).resolves.toEqual({
      email: 'new@example.com',
      signedIn: false,
      entitlement: null,
    });
    expect(calls.some((url) => url.endsWith('/api/store/account'))).toBe(false);
  });

  it('uses cached entitlement only during the 14-day offline grace window', async () => {
    const file = accountFile();
    const entitlement = {
      tier: 'linked',
      active: true,
      price: 5,
      status: 'active',
      current_period_end: null,
    };
    await writeFile(
      file,
      JSON.stringify({
        accountStarted: true,
        siteUrl: 'https://site.example',
        supabaseUrl: 'https://supabase.example',
        supabaseAnonKey: 'anon-key',
        email: 'owner@example.com',
        accessToken: secretStore.encrypt('access'),
        refreshToken: secretStore.encrypt('refresh'),
        expiresAt: Date.now() + 3600000,
        entitlement,
        entitlementFetchedAt: Date.now() - 13 * 24 * 60 * 60 * 1000,
      }),
    );
    const manager = new CloudAccountManager(file, secretStore, async () => {
      throw new Error('offline');
    });

    await expect(manager.getState()).resolves.toMatchObject({
      email: 'owner@example.com',
      signedIn: true,
      entitlement: { tier: 'linked', active: true },
    });
    await expect(manager.refresh()).resolves.toMatchObject({
      entitlement: { tier: 'linked', active: true },
    });
    expect(manager.isSyncAllowed()).toBe(true);

    await writeFile(
      file,
      JSON.stringify({
        accountStarted: true,
        siteUrl: 'https://site.example',
        supabaseUrl: 'https://supabase.example',
        supabaseAnonKey: 'anon-key',
        email: 'owner@example.com',
        accessToken: secretStore.encrypt('access'),
        refreshToken: secretStore.encrypt('refresh'),
        expiresAt: Date.now() + 3600000,
        entitlement,
        entitlementFetchedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      }),
    );
    const expired = new CloudAccountManager(file, secretStore, async () => {
      throw new Error('offline');
    });
    await expect(expired.getState()).resolves.toMatchObject({
      entitlement: { tier: 'linked', active: false },
    });
    expect(expired.isSyncAllowed()).toBe(false);
  });

  it('throttles repeated entitlement refreshes unless forced', async () => {
    const file = accountFile();
    let entitlementRequests = 0;
    await writeFile(
      file,
      JSON.stringify({
        accountStarted: true,
        siteUrl: 'https://site.example',
        supabaseUrl: 'https://supabase.example',
        supabaseAnonKey: 'anon-key',
        email: 'owner@example.com',
        accessToken: secretStore.encrypt('access'),
        refreshToken: secretStore.encrypt('refresh'),
        expiresAt: Date.now() + 3600000,
        entitlement: null,
        entitlementFetchedAt: null,
      }),
    );
    const manager = new CloudAccountManager(
      file,
      secretStore,
      async (input) => {
        const url = String(input);
        if (url.endsWith('/api/store/entitlement')) {
          entitlementRequests += 1;
          return jsonResponse({
            tier: 'standalone',
            active: false,
            price: 10,
            status: 'inactive',
            current_period_end: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    await manager.refresh();
    await manager.refresh();
    expect(entitlementRequests).toBe(1);
    await manager.refresh(true);
    expect(entitlementRequests).toBe(2);
  });

  it('does not gate an existing pasted-credentials sync configuration', async () => {
    const file = accountFile();
    const database = new StoreDatabase(':memory:');
    const transport: SyncTransport = {
      async pushEvents(events) {
        return { acknowledgedEventIds: events.map((event) => event.eventId) };
      },
      async testConnection() {
        return { ok: true, reachable: true, message: 'connected' };
      },
      async listEvents() {
        return [];
      },
    };
    database.applySyncCredentials({
      enabled: true,
      supabaseUrl: 'https://legacy.example',
      apiKeySecret: 'legacy-key',
      apiKeyEncrypted: false,
    });
    database.connection
      .prepare('UPDATE sync_settings SET store_id = ? WHERE singleton_id = 1')
      .run('00000000-0000-0000-0000-000000000001');
    database.createCategory({ name: 'Legacy cloud sync' });
    const manager = new CloudAccountManager(file, secretStore, async () => {
      throw new Error('offline');
    });
    const engine = new SyncEngine(database, transport, {
      canSync: () => manager.isSyncAllowed(),
    });

    expect(manager.isSyncAllowed()).toBe(true);
    const result = await engine.pushCycle();
    expect(result.pushed).toBe(1);
    expect(database.pendingSyncEventCount()).toBe(0);
    database.close();
  });
});
