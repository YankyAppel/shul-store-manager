import { z } from 'zod';

export const cloudEntitlementSchema = z.object({
  tier: z.enum(['standalone']).nullable(),
  active: z.boolean(),
  price: z.number().nullable(),
  status: z.string(),
  current_period_end: z.string().nullable(),
  cached_until: z.string().optional(),
});
export type CloudEntitlement = z.infer<typeof cloudEntitlementSchema>;

export interface CloudAccountState {
  email: string | null;
  signedIn: boolean;
  /** Email + password sign-in works (false for Google-only accounts). */
  hasPassword: boolean;
  entitlement: CloudEntitlement | null;
}

export interface CloudAccountConfig {
  siteUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface BarcodeSuggestion {
  barcode: string;
  name: string;
  confirmations: number;
}

export const emptyCloudAccountState = (): CloudAccountState => ({
  email: null,
  signedIn: false,
  hasPassword: false,
  entitlement: null,
});
