import { readFile, writeFile } from 'node:fs/promises';
import type {
  CloudAccountConfig,
  CloudAccountState,
  CloudEntitlement,
  SecretStore,
} from '@shul-store/shared';
import {
  cloudEntitlementSchema,
  type BarcodeSuggestion,
  type CatalogVendor,
  type CatalogVendorMerge,
  type CatalogVendorProduct,
  type EmbeddedCheckoutPayload,
  type StorePlansResult,
  type Vendor,
  type PurchaseOrder,
} from '@shul-store/shared';

const SITE_URL = 'https://sumasystems.com';
const LEGACY_SITE_URLS = new Set(['https://skvershul.softhere.work']);
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;
type FetchImpl = typeof globalThis.fetch;
interface Stored {
  accountStarted: boolean;
  /** The account can sign in with email + password (not only Google). */
  hasPassword: boolean;
  siteUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  storeId: string | null;
  email: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  entitlement: CloudEntitlement | null;
  entitlementFetchedAt: number | null;
  entitlementOffline: boolean;
}

interface AuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { email?: string; app_metadata?: { providers?: unknown } };
}

/** Supabase lists `email` among the providers once a password is set. */
function hasPasswordProvider(user: AuthResponse['user']): boolean {
  const providers = user?.app_metadata?.providers;
  return Array.isArray(providers) && providers.includes('email');
}

export interface CloudAccountHooks {
  getLocalStoreIdentity?: () => {
    storeId: string | null;
    hasPushedEvents: boolean;
  };
  onStoreIdentity?: (storeId: string) => Promise<void>;
}

function initial(): Stored {
  return {
    accountStarted: false,
    hasPassword: false,
    siteUrl: SITE_URL,
    supabaseUrl: '',
    supabaseAnonKey: '',
    storeId: null,
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
    private readonly hooks: CloudAccountHooks = {},
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(
        await readFile(this.filename, 'utf8'),
      ) as Partial<Stored>;
      this.stored = {
        ...initial(),
        ...raw,
        // Accounts signed in before Google sign-in existed used a password.
        hasPassword: raw.hasPassword ?? Boolean(raw.accessToken),
      };
      if (LEGACY_SITE_URLS.has(this.stored.siteUrl)) {
        this.stored = {
          ...initial(),
          accountStarted: this.stored.accountStarted,
          storeId: this.stored.storeId,
        };
        this.loaded = true;
        await this.save();
        return;
      }
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
      hasPassword: this.stored.hasPassword,
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

  /** Every PC must be signed in to a SUMA account before the platform opens. */
  async shouldShowOnboarding(): Promise<boolean> {
    await this.load();
    return !this.state().signedIn;
  }

  /** Whether an account already exists for this email (`null` when unknown). */
  async lookupEmail(email: string): Promise<boolean | null> {
    await this.load();
    try {
      const response = await this.fetchImpl(
        `${this.stored.siteUrl}/api/store/account-lookup`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        },
      );
      if (!response.ok) return null;
      const value = (await response.json()) as { exists?: unknown };
      return typeof value.exists === 'boolean' ? value.exists : null;
    } catch {
      return null;
    }
  }

  async getSupabaseConfig(): Promise<CloudAccountConfig> {
    await this.load();
    if (this.stored.supabaseUrl && this.stored.supabaseAnonKey)
      return this.stored;
    const response = await this.fetchImpl(
      `${this.stored.siteUrl}/api/store/config`,
    );
    if (!response.ok)
      throw new Error('Could not load Suma Store configuration.');
    const value = (await response.json()) as {
      supabase_url?: string;
      supabase_anon_key?: string;
    };
    if (!value.supabase_url || !value.supabase_anon_key)
      throw new Error('Suma Store configuration is unavailable.');
    this.stored.supabaseUrl = value.supabase_url;
    this.stored.supabaseAnonKey = value.supabase_anon_key;
    await this.save();
    return this.stored;
  }

  getCachedSupabaseConfig(): CloudAccountConfig | null {
    if (!this.stored.supabaseUrl || !this.stored.supabaseAnonKey) return null;
    return this.stored;
  }

  isAccountSyncConfigured(): boolean {
    return Boolean(
      this.stored.accountStarted &&
      this.stored.accessToken &&
      this.stored.storeId,
    );
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    await this.load();
    if (!this.stored.accessToken) throw new Error('Please sign in first.');
    if (forceRefresh || (this.stored.expiresAt ?? 0) - Date.now() < 60_000) {
      try {
        await this.refreshToken();
      } catch {
        await this.signOut();
        throw new Error('Your session expired. Please sign in again.');
      }
    }
    if (!this.stored.accessToken) throw new Error('Please sign in first.');
    return this.stored.accessToken;
  }

  async getStoreId(): Promise<string | null> {
    await this.load();
    return this.stored.storeId;
  }

  private async auth(
    pathname: string,
    body: Record<string, string>,
    isSignUp = false,
    fallbackMessage = 'Sign-in failed. Check your email and password.',
  ): Promise<boolean> {
    const config = await this.getSupabaseConfig();
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
      if (isSignUp || pathname.includes('id_token')) {
        const error = (await response.json().catch(() => null)) as {
          msg?: unknown;
          error_description?: unknown;
        } | null;
        const detail =
          typeof error?.msg === 'string'
            ? error.msg
            : typeof error?.error_description === 'string'
              ? error.error_description
              : fallbackMessage;
        throw new Error(detail);
      }
      throw new Error(fallbackMessage);
    }
    const value = (await response.json()) as AuthResponse;
    if (isSignUp && (!value.access_token || !value.refresh_token)) {
      this.stored.accessToken = null;
      this.stored.refreshToken = null;
      this.stored.expiresAt = null;
      this.stored.email = value.user?.email ?? body.email ?? null;
      this.stored.hasPassword = true;
      this.stored.accountStarted = true;
      await this.save();
      return false;
    }
    if (!value.access_token || !value.refresh_token)
      throw new Error(fallbackMessage);
    this.stored.accessToken = value.access_token;
    this.stored.refreshToken = value.refresh_token;
    this.stored.expiresAt = Date.now() + (value.expires_in ?? 3600) * 1000;
    this.stored.email = value.user?.email ?? this.stored.email;
    this.stored.hasPassword =
      'password' in body || hasPasswordProvider(value.user);
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
    const signedIn = await this.auth(
      'signup',
      { email, password },
      true,
      'Sign-up failed. Please check your details and try again.',
    );
    if (signedIn) await this.afterSignIn();
    return this.publish();
  }
  /**
   * Sign in (or create the account) with a Google ID token obtained through
   * the desktop PKCE flow; `nonce` is the raw value whose hash Google embedded
   * in the token.
   */
  async signInWithGoogle(
    idToken: string,
    nonce: string,
  ): Promise<CloudAccountState> {
    await this.auth(
      'token?grant_type=id_token',
      { provider: 'google', id_token: idToken, nonce },
      false,
      'Google sign-in failed. Please try again.',
    );
    await this.afterSignIn();
    return this.publish();
  }
  /** Set (or change) the password used for email + password sign-in. */
  async setPassword(password: string): Promise<CloudAccountState> {
    const config = await this.getSupabaseConfig();
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(
      `${config.supabaseUrl}/auth/v1/user`,
      {
        method: 'PUT',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      },
    );
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        msg?: unknown;
      } | null;
      throw new Error(
        typeof error?.msg === 'string'
          ? error.msg
          : 'The password could not be saved. Please try again.',
      );
    }
    this.stored.hasPassword = true;
    await this.save();
    return this.publish();
  }
  private async afterSignIn(): Promise<void> {
    const local = this.hooks.getLocalStoreIdentity?.();
    const body =
      local?.storeId && local.hasPushedEvents
        ? { adopt_store_id: local.storeId }
        : {};
    const response = await this.request('/api/store/account', 'POST', body);
    const value = (await response.json()) as {
      account?: { store_id?: unknown };
    };
    const storeId =
      typeof value.account?.store_id === 'string'
        ? value.account.store_id
        : null;
    if (!storeId) throw new Error('The cloud store identity is unavailable.');
    this.stored.storeId = storeId;
    await this.save();
    if (local?.storeId && local.storeId !== storeId && !local.hasPushedEvents)
      throw new Error(
        'This PC is linked to a different cloud store and cannot be merged.',
      );
    if (this.hooks.onStoreIdentity) await this.hooks.onStoreIdentity(storeId);
    await this.fetchEntitlement();
  }
  private async refreshToken(): Promise<void> {
    if (!this.stored.refreshToken)
      throw new Error('Your session expired. Please sign in again.');
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const config = await this.getSupabaseConfig();
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
    await this.getAccessToken();
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
    this.stored.hasPassword = false;
    await this.save();
    return this.publish();
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

  /** Plan catalog + subscription state shown by the onboarding billing step. */
  async listPlans(): Promise<StorePlansResult> {
    const response = await this.request('/api/store/plans', 'GET');
    return (await response.json()) as StorePlansResult;
  }

  /** Stripe embedded-checkout session for the chosen plan. */
  async embeddedCheckout(planId: string): Promise<EmbeddedCheckoutPayload> {
    const response = await this.request(
      '/api/store/checkout-embedded',
      'POST',
      { planId },
    );
    const body = (await response.json()) as
      EmbeddedCheckoutPayload | { error?: string };
    if (!('clientSecret' in body))
      throw new Error(body.error ?? 'Could not start checkout');
    return body;
  }

  async lookupBarcodeSuggestion(
    barcode: string,
  ): Promise<BarcodeSuggestion | null> {
    const response = await this.request(
      `/api/store/barcode-catalog?barcode=${encodeURIComponent(barcode)}`,
      'GET',
    );
    const value = (await response.json()) as {
      suggestion?: BarcodeSuggestion | null;
    };
    return value.suggestion ?? null;
  }

  async shareBarcodeSuggestion(
    barcode: string,
    name: string,
  ): Promise<BarcodeSuggestion | null> {
    const response = await this.request('/api/store/barcode-catalog', 'POST', {
      barcode,
      name,
    });
    const value = (await response.json()) as {
      suggestion?: BarcodeSuggestion | null;
    };
    return value.suggestion ?? null;
  }

  /** Shared vendor directory, optionally only rows changed after `since`. */
  async fetchVendors(
    since: string | null,
  ): Promise<{ vendors: CatalogVendor[]; merges: CatalogVendorMerge[] }> {
    const all: CatalogVendor[] = [];
    const merges = new Map<string, CatalogVendorMerge>();
    let cursor = since;
    for (let page = 0; page < 20; page += 1) {
      const query = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
      const response = await this.request(`/api/store/vendors${query}`, 'GET');
      const value = (await response.json()) as {
        vendors: CatalogVendor[];
        merges?: CatalogVendorMerge[];
        more: boolean;
      };
      all.push(...value.vendors);
      for (const merge of value.merges ?? [])
        merges.set(merge.source_id, merge);
      const last = value.vendors.at(-1);
      if (!value.more || !last || last.updated_at === cursor) break;
      cursor = last.updated_at;
    }
    return {
      vendors: all,
      merges: [...merges.values()].sort((a, b) =>
        a.merged_at.localeCompare(b.merged_at),
      ),
    };
  }

  async fetchVendorProducts(
    vendorId: string,
    since: string | null,
  ): Promise<CatalogVendorProduct[]> {
    const query = new URLSearchParams({ vendor_id: vendorId });
    if (since) query.set('since', since);
    const response = await this.request(
      `/api/store/vendor-products?${query.toString()}`,
      'GET',
    );
    const value = (await response.json()) as {
      products: CatalogVendorProduct[];
    };
    return value.products;
  }

  async fetchVendorProductsForBarcode(
    barcode: string,
  ): Promise<CatalogVendorProduct[]> {
    const response = await this.request(
      `/api/store/vendor-products?barcode=${encodeURIComponent(barcode)}`,
      'GET',
    );
    const value = (await response.json()) as {
      products: CatalogVendorProduct[];
    };
    return value.products;
  }

  /** Publish a locally created vendor to the shared directory (same id). */
  /**
   * Publish a purchase order so the vendor can open it on the vendor portal
   * with the token link. Idempotent on the PO id.
   */
  async publishPurchaseOrder(order: PurchaseOrder): Promise<void> {
    await this.request('/api/store/purchase-orders', 'POST', {
      id: order.id,
      number: order.number,
      vendorId: order.vendorId,
      accessToken: order.accessToken,
      status: order.status,
      subject: order.subject,
      message: order.message,
      sentAt: order.sentAt,
      lines: order.lines.map((line) => ({
        productName: line.productName,
        barcode: line.barcode,
        vendorSku: line.vendorSku,
        quantity: line.quantity,
        unitCostCents: line.unitCostCents,
      })),
    });
  }

  async publishVendor(vendor: Vendor): Promise<CatalogVendor> {
    const response = await this.request('/api/store/vendors', 'POST', {
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      phone: vendor.phone,
      website: vendor.website,
      address: vendor.address,
      notes: vendor.notes,
    });
    const value = (await response.json()) as { vendor: CatalogVendor };
    return value.vendor;
  }
}
