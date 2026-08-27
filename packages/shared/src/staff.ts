import { z } from 'zod';

export const GRANTABLE_PERMISSIONS = [
  'checkout',
  'account_payments',
  'sales.history',
  'refunds',
  'products.edit',
  'inventory.adjust',
  'customers.manage',
  'reports.view',
  'reports.close',
  'create_product_during_sale',
  'create_category',
] as const;

export type GrantablePermission = (typeof GRANTABLE_PERMISSIONS)[number];
export const DEFAULT_CASHIER_PERMISSIONS: GrantablePermission[] = [
  'checkout',
  'account_payments',
  'sales.history',
];

export const grantablePermissionSchema = z.enum(GRANTABLE_PERMISSIONS);
export const staffPinSchema = z
  .string()
  .regex(/^\d{4,8}$/, 'PIN must be 4-8 digits');
export const staffNameSchema = z.string().trim().min(1).max(200);
export const staffPermissionsSchema = z
  .array(grantablePermissionSchema)
  .max(GRANTABLE_PERMISSIONS.length);
export const staffRoleSchema = z.enum(['owner', 'cashier']);

export const staffCreateInputSchema = z.object({
  name: staffNameSchema,
  role: staffRoleSchema,
  pin: staffPinSchema,
  permissions: staffPermissionsSchema.default(DEFAULT_CASHIER_PERMISSIONS),
});
export type StaffCreateInput = z.infer<typeof staffCreateInputSchema>;

export const staffUpdateInputSchema = z.object({
  name: staffNameSchema,
  role: staffRoleSchema,
  active: z.boolean(),
  permissions: staffPermissionsSchema,
});
export type StaffUpdateInput = z.infer<typeof staffUpdateInputSchema>;

export const staffPinInputSchema = z.object({ pin: staffPinSchema });
export type StaffPinInput = z.infer<typeof staffPinInputSchema>;

export const idleLockMinutesSchema = z.number().int().min(0).max(1440);

export interface StaffAccount {
  id: string;
  name: string;
  role: 'owner' | 'cashier';
  active: boolean;
  permissions: GrantablePermission[];
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffPickerAccount {
  id: string;
  name: string;
  role: 'owner' | 'cashier';
  lockedUntil: string | null;
}

export interface SignedInStaff {
  id: string;
  name: string;
  role: 'owner' | 'cashier';
  permissions: GrantablePermission[];
}

export interface AuthState {
  staffModeEnabled: boolean;
  signedInStaff: SignedInStaff | null;
  permissions: GrantablePermission[];
}

export const permissionLabels: Record<GrantablePermission, string> = {
  checkout: 'Ring up sales',
  account_payments: 'Take customer account payments',
  'sales.history': 'View sales history and reprint receipts',
  refunds: 'Refund a sale',
  'products.edit': 'Change prices and products',
  'inventory.adjust': 'Adjust inventory',
  'customers.manage': 'Manage customers and account limits',
  'reports.view': 'View daily reports',
  'reports.close': 'Close the business day',
  create_product_during_sale: 'Create a product during checkout',
  create_category: 'Create a category from a product form',
};
