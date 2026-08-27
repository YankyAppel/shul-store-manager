import type {
  AuthState,
  GrantablePermission,
  SignedInStaff,
} from '@shul-store/shared';
import type { StoreDatabase } from '@shul-store/database';

export type IpcRequirement = 'public' | 'owner' | GrantablePermission;

const denied = (requirement: IpcRequirement): Error =>
  new Error(`PERMISSION_DENIED:${requirement}`);

export class ManagerSession {
  private current: SignedInStaff | null = null;
  private elevation: {
    permission: GrantablePermission;
    expiresAt: number;
  } | null = null;
  private lastActivity = Date.now();

  constructor(
    private database: StoreDatabase,
    private readonly onChange: () => void = () => undefined,
  ) {}

  get state(): AuthState {
    const settings = this.database.getDeviceSettings();
    return {
      staffModeEnabled: settings.staffModeEnabled,
      signedInStaff: this.current,
      permissions: this.current?.permissions ?? [],
    };
  }

  authorize(requirement: IpcRequirement): void {
    if (
      requirement === 'public' ||
      !this.database.getDeviceSettings().staffModeEnabled
    )
      return;
    this.expireIfIdle();
    if (!this.current) {
      this.database.recordStaffAudit('auth.permission_denied', 'system', {
        permission: requirement,
      });
      throw denied(requirement);
    }
    if (this.current.role === 'owner') return;
    if (this.current.permissions.includes(requirement as GrantablePermission))
      return;
    if (
      this.elevation &&
      this.elevation.permission === requirement &&
      this.elevation.expiresAt > Date.now()
    ) {
      this.elevation = null;
      return;
    }
    this.database.recordStaffAudit('auth.permission_denied', this.current.id, {
      permission: requirement,
    });
    throw denied(requirement);
  }

  signIn(staffId: string, pin: string): SignedInStaff {
    const result = this.database.verifyStaffPin(staffId, pin);
    if (!result.ok) {
      this.database.recordStaffAudit('auth.sign_in_failed', staffId, {
        reason: result.reason,
      });
      if (result.reason === 'locked')
        throw new Error(`ACCOUNT_LOCKED:${result.lockedUntil}`);
      throw new Error('INVALID_PIN');
    }
    this.current = {
      id: result.account.id,
      name: result.account.name,
      role: result.account.role,
      permissions: this.database.staffPermissions(result.account.id),
    };
    this.lastActivity = Date.now();
    this.elevation = null;
    this.database.recordStaffAudit('auth.sign_in', this.current.id, {});
    this.onChange();
    return this.current;
  }

  signOut(): void {
    if (this.current) {
      this.database.recordStaffAudit('auth.sign_out', this.current.id, {});
      this.current = null;
    }
    this.elevation = null;
    this.onChange();
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  replaceDatabase(database: StoreDatabase): void {
    this.database = database;
    this.current = null;
    this.elevation = null;
    this.lastActivity = Date.now();
    this.onChange();
  }

  checkIdle(): boolean {
    const before = this.current;
    this.expireIfIdle();
    return before !== this.current;
  }

  elevate(permission: GrantablePermission, pin: string): void {
    const owner = this.database.verifyActiveOwnerPin(pin);
    if (owner) {
      this.elevation = {
        permission,
        expiresAt: Date.now() + 90_000,
      };
      this.database.recordStaffAudit('auth.elevation_granted', owner.id, {
        permission,
      });
      return;
    }
    const actor = this.current?.id ?? 'system';
    this.database.recordStaffAudit('auth.elevation_denied', actor, {
      permission,
    });
    throw new Error('INVALID_OWNER_PIN');
  }

  private expireIfIdle(): void {
    if (!this.current) return;
    const minutes = this.database.getDeviceSettings().idleLockMinutes;
    if (minutes > 0 && Date.now() - this.lastActivity >= minutes * 60_000) {
      const id = this.current.id;
      this.current = null;
      this.elevation = null;
      this.database.recordStaffAudit('auth.idle_lock', id, {});
      this.onChange();
    }
    if (this.elevation && this.elevation.expiresAt <= Date.now())
      this.elevation = null;
  }
}
