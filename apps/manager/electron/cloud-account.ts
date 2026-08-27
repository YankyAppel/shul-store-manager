import { readFile, writeFile } from 'node:fs/promises';
import type {
  CloudAccountConfig,
  CloudAccountState,
  CloudEntitlement,
  SecretStore,
} from '@shul-store/shared';
import { cloudEntitlementSchema } from '@shul-store/shared';

const SITE_URL = 'https://skvershul.softhere.work';
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;
type FetchImpl = typeof globalThis.fetch;
interface Stored {
  accountStarted: boolean;
  onboardingDismissed: boolean;
  siteUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  email: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  entitlement: CloudEntitlement | null;
  entitlementFetchedAt: number | null;
  entitlementOffline: boolean;
}

function initial(): Stored {
  return {
    accountStarted: false,
    onboardingDismissed: false,
    siteUrl: SITE_URL,
    supabaseUrl: '',
    supabaseAnonKey: '',
    email: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    entitlement: null,
    entitlementFetchedAt: null,
    entitlementOffline: false,
  };
}

export class CloudAccountManager {
  private stored: Stored = initial();
  private readonly listeners = new Set<(state: CloudAccountState) => void>();
  private loaded = false;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly filename: string,
    private readonly secretStore: SecretStore,
    private readonly fetchImpl: FetchImpl = globalThis.fetch,
    private readonly openExternal?: (url: string) => Promise<void>,
    private readonly hasLegacySync?: () => boolean,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(
        await readFile(this.filename, 'utf8'),
      ) as Partial<Stored>;
      this.stored = { ...initial(), ...raw };
      if (this.stored.accessToken)
        this.stored.accessToken = this.secretStore.decrypt(
          this.stored.accessToken,
        );
      if (this.stored.refreshToken)
        this.stored.refreshToken = this.secretStore.decrypt(
          this.stored.refreshToken,
        );
    } catch {
      /* first launch */
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const output = {
      ...this.stored,
      accessToken: this.stored.accessToken
        ? this.secretStore.encrypt(this.stored.accessToken)
        : null,
      refreshToken: this.stored.refreshToken
        ? this.secretStore.encrypt(this.stored.refreshToken)
        : null,
    };
    await writeFile(this.filename, JSON.stringify(output), { mode: 0o600 });
  }

  private state(): CloudAccountState {
    const active =
      this.stored.entitlement?.active &&
      this.stored.entitlementFetchedAt !== null &&
      Date.now() - this.stored.entitlementFetchedAt <= GRACE_MS;
    const cachedUntil =
      this.stored.entitlementOffline &&
      this.stored.entitlementFetchedAt !== null
        ? new Date(this.stored.entitlementFetchedAt + GRACE_MS).toISOString()
        : undefined;
    return {
      email: this.stored.email,
      signedIn: Boolean(this.stored.accessToken && this.stored.refreshToken),
      entitlement: this.stored.entitlement
        ? {
            ...this.stored.entitlement,
            active: Boolean(active),
            ...(cachedUntil ? { cached_until: cachedUntil } : {}),
          }
        : null,
    };
  }

  isSyncAllowed(): boolean {
    if (!this.stored.accountStarted) return true;
    return Boolean(
      this.stored.accessToken &&
      this.stored.entitlement?.active &&
      this.stored.entitlementFetchedAt !== null &&
      Date.now() - this.stored.entitlementFetchedAt <= GRACE_MS,
    );
  }

  private publish(): CloudAccountState {
    const value = this.state();
    for (const listener of this.listeners) listener(value);
    return value;
  }

  subscribe(listener: (state: CloudAccountState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<CloudAccountState> {
    await this.load();
    return this.state();
  }

  async shouldShowOnboarding(): Promise<boolean> {
    await this.load();
    if (this.stored.accountStarted || this.stored.onboardingDismissed)
      return false;
    if (this.hasLegacySync?.()) {
      this.stored.onboardingDismissed = true;
      await this.save();
      return false;
    }
    return true;
  }

  async dismissOnboarding(): Promise<void> {
    await this.load();
    this.stored.onboardingDismissed = true;
    await this.save();
  }

  private async config(): Promise<CloudAccountConfig> {
    await this.load();
    if (this.stored.supabaseUrl && this.stored.supabaseAnonKey)
      return this.stored;
    const response = await this.fetchImpl(
      `${this.stored.siteUrl}/api/store/config`,
    );
    if (!response.ok)
      throw new Error('Could not load Store Manager configuration.');
    const value = (await response.json()) as {
      supabase_url?: string;
      supabase_anon_key?: string;
    };
    if (!value.supabase_url || !value.supabase_anon_key)
      throw new Error('Store Manager configuration is unavailable.');
    this.stored.supabaseUrl = value.supabase_url;
    this.stored.supabaseAnonKey = value.supabase_anon_key;
    await this.save();
    return this.stored;
  }

  private async auth(
    pathname: string,
    body: Record<string, string>,
    isSignUp = false,
  ): Promise<boolean> {
    const config = await this.config();
    const response = await this.fetchImpl(
      `${config.supabaseUrl}/auth/v1/${pathname}`,
      {
        method: 'POST',
        headers: {
          apikey: config.supabaseAnonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      if (isSignUp) {
        const error = (await response.json().catch(() => null)) as {
          msg?: unknown;
          error_description?: unknown;
        } | null;
        const detail =
          typeof error?.msg === 'string'
            ? error.msg
            : typeof error?.error_description === 'string'
              ? error.error_description
              : 'Sign-up failed. Please check your details and try again.';
        throw new Error(detail);
      }
      throw new Error('Sign-in failed. Check your email and password.');
    }
    const value = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      user?: { email?: string };
    };
    if (isSignUp && (!value.access_token || !value.refresh_token)) {
      this.stored.accessToken = null;
      this.stored.refreshToken = null;
      this.stored.expiresAt = null;
      this.stored.email = value.user?.email ?? body.email ?? null;
      this.stored.accountStarted = true;
      await this.save();
      return false;
    }
    if (!value.access_token || !value.refresh_token)
      throw new Error('Sign-in failed. Check your email and password.');
    this.stored.accessToken = value.access_token;
    this.stored.refreshToken = value.refresh_token;
    this.stored.expiresAt = Date.now() + (value.expires_in ?? 3600) * 1000;
    this.stored.email = value.user?.email ?? this.stored.email;
    this.stored.accountStarted = true;
    await this.save();
    return true;
  }

  async signIn(email: string, password: string): Promise<CloudAccountState> {
    await this.auth('token?grant_type=password', { email, password });
    await this.afterSignIn();
    return this.publish();
  }
  async signUp(email: string, password: string): Promise<CloudAccountState> {
    const signedIn = await this.auth('signup', { email, password }, true);
    if (signedIn) await this.afterSignIn();
    return this.publish();
  }
  private async afterSignIn(): Promise<void> {
    await this.request('/api/store/account', 'POST', {});
    await this.fetchEntitlement();
  }
  private async refreshToken(): Promise<void> {
    if (!this.stored.refreshToken)
      throw new Error('Your session expired. Please sign in again.');
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const config = await this.config();
      const response = await this.fetchImpl(
        `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
        {
          method: 'POST',
          headers: {
            apikey: config.supabaseAnonKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refresh_token: this.stored.refreshToken }),
        },
      );
      if (!response.ok)
        throw new Error('Your session expired. Please sign in again.');
      const value = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };
      this.stored.accessToken = value.access_token;
      this.stored.refreshToken =
        value.refresh_token ?? this.stored.refreshToken;
      this.stored.expiresAt = Date.now() + (value.expires_in ?? 3600) * 1000;
      await this.save();
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
  private async request(
    endpoint: string,
    method: string,
    body?: unknown,
  ): Promise<Response> {
    await this.load();
    if (!this.stored.accessToken) throw new Error('Please sign in first.');
    if ((this.stored.expiresAt ?? 0) - Date.now() < 60_000) {
      try {
        await this.refreshToken();
      } catch {
        await this.signOut();
        throw new Error('Your session expired. Please sign in again.');
      }
    }
    const send = () =>
      this.fetchImpl(`${this.stored.siteUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.stored.accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let response = await send();
    if (response.status === 401) {
      try {
        await this.refreshToken();
      } catch {
        await this.signOut();
        throw new Error('Your session expired. Please sign in again.');
      }
      response = await send();
      if (response.status === 401) {
        await this.signOut();
        throw new Error('Your session expired. Please sign in again.');
      }
    }
    if (!response.ok) throw new Error('Store account request failed.');
    return response;
  }
  private async fetchEntitlement(): Promise<void> {
    const response = await this.request('/api/store/entitlement', 'GET');
    const parsed = cloudEntitlementSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new Error('Could not read the cloud subscription status.');
    this.stored.entitlement = parsed.data;
    this.stored.entitlementFetchedAt = Date.now();
    this.stored.entitlementOffline = false;
    await this.save();
  }
  async refresh(force = false): Promise<CloudAccountState> {
    await this.load();
    if (!this.stored.accessToken) return this.state();
    if (
      !force &&
      this.stored.entitlementFetchedAt !== null &&
      Date.now() - this.stored.entitlementFetchedAt < REFRESH_THROTTLE_MS
    )
      return this.state();
    try {
      await this.fetchEntitlement();
    } catch {
      this.stored.entitlementOffline = this.stored.entitlement !== null;
      await this.save();
      return this.publish();
    }
    return this.publish();
  }
  async signOut(): Promise<CloudAccountState> {
    await this.load();
    this.stored.accessToken = null;
    this.stored.refreshToken = null;
    this.stored.expiresAt = null;
    this.stored.email = null;
    this.stored.accountStarted = true;
    await this.save();
    return this.publish();
  }
  async link(username: string, password: string): Promise<CloudAccountState> {
    await this.request('/api/store/link', 'POST', { username, password });
    await this.fetchEntitlement();
    return this.publish();
  }
  async linkHint(): Promise<boolean> {
    const response = await this.request('/api/store/link-hint', 'GET');
    const value = (await response.json()) as {
      matches_existing_shames?: boolean;
    };
    return value.matches_existing_shames === true;
  }
  async checkout(): Promise<void> {
    const value = await this.request('/api/store/checkout', 'POST', {});
    const body = (await value.json()) as { url?: string };
    if (body.url && this.openExternal) await this.openExternal(body.url);
    await this.refresh(true);
  }
  async portal(): Promise<void> {
    const value = await this.request('/api/store/portal', 'POST', {});
    const body = (await value.json()) as { url?: string };
    if (body.url && this.openExternal) await this.openExternal(body.url);
    await this.refresh(true);
  }
}
