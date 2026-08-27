import { z } from 'zod';

export const cloudEntitlementSchema = z.object({
  tier: z.enum(['linked', 'standalone']).nullable(),
  active: z.boolean(),
  price: z.number().nullable(),
  status: z.string(),
  current_period_end: z.string().nullable(),
  linked_shul_name: z.string().optional(),
});
export type CloudEntitlement = z.infer<typeof cloudEntitlementSchema>;

export interface CloudAccountState {
  email: string | null;
  signedIn: boolean;
  entitlement: CloudEntitlement | null;
}

export interface CloudAccountConfig {
  siteUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const emptyCloudAccountState = (): CloudAccountState => ({
  email: null,
  signedIn: false,
  entitlement: null,
});
