import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreDatabase, listAllOutboxEvents } from '../src/index.js';

describe('staff accounts', () => {
  let store: StoreDatabase;
  beforeEach(() => {
    store = new StoreDatabase(':memory:');
  });
  afterEach(() => store.close());

  it('creates the first owner and enables staff mode', () => {
    const owner = store.createFirstOwner('Shames', '1234');
    expect(owner).toMatchObject({
      name: 'Shames',
      role: 'owner',
      active: true,
    });
    expect(store.getDeviceSettings().staffModeEnabled).toBe(true);
    expect(store.listStaffAccounts()).toHaveLength(1);
    expect(
      store.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staff'",
        )
        .get(),
    ).toBeTruthy();
    const columns = store.connection
      .prepare('PRAGMA table_info(device_settings)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['idle_lock_minutes', 'staff_mode_enabled']),
    );
    expect(
      store.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'staff_name_idx'",
        )
        .get(),
    ).toEqual({ name: 'staff_name_idx' });
  });

  it('keeps staff records out of the sync outbox', () => {
    store.createFirstOwner('Shames', '1234');
    expect(
      listAllOutboxEvents(store.connection).some(
        (event) => event.entityType === 'staff',
      ),
    ).toBe(false);
  });

  it('verifies PINs and locks an account after five failures', () => {
    vi.useFakeTimers();
    const owner = store.createFirstOwner('Shames', '1234');
    for (let i = 0; i < 4; i++)
      expect(store.verifyStaffPin(owner.id, '0000')).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    const fifth = store.verifyStaffPin(owner.id, '0000');
    expect(fifth).toMatchObject({ ok: false, reason: 'locked' });
    expect(store.verifyStaffPin(owner.id, '1234')).toMatchObject({
      ok: false,
      reason: 'locked',
    });
    vi.setSystemTime(new Date(Date.parse(fifth.lockedUntil!) + 1));
    expect(store.verifyStaffPin(owner.id, '1234')).toMatchObject({ ok: true });
    vi.useRealTimers();
  });

  it('protects the last active owner from deactivation and demotion', () => {
    const owner = store.createFirstOwner('Shames', '1234');
    expect(() =>
      store.updateStaff(owner.id, {
        name: owner.name,
        role: 'cashier',
        active: true,
        permissions: [],
      }),
    ).toThrow(/last active owner/);
    expect(() =>
      store.updateStaff(owner.id, {
        name: owner.name,
        role: 'owner',
        active: false,
        permissions: [],
      }),
    ).toThrow(/last active owner/);
  });

  it('resolves every permission for owners and only configured permissions for cashiers', () => {
    const owner = store.createFirstOwner('Shames', '1234');
    const cashier = store.createStaff({
      name: 'Cashier',
      role: 'cashier',
      pin: '5678',
      permissions: ['checkout', 'refunds'],
    });
    expect(store.staffPermissions(owner.id)).toContain('reports.close');
    expect(store.staffPermissions(cashier.id)).toEqual(['checkout', 'refunds']);
  });

  it('preserves staff-mode-off compatibility', () => {
    expect(store.getDeviceSettings().staffModeEnabled).toBe(false);
    expect(store.staffCount()).toBe(0);
  });
});
