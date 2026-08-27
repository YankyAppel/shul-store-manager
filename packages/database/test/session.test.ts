import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreDatabase } from '../src/index.js';
import { ManagerSession } from '../../../apps/manager/electron/session.js';

describe('manager session elevation', () => {
  let store: StoreDatabase;
  beforeEach(() => {
    store = new StoreDatabase(':memory:');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  it('grants one permission for one use only', () => {
    store.createFirstOwner('Owner', '1234');
    const cashier = store.createStaff({
      name: 'Cashier',
      role: 'cashier',
      pin: '5678',
      permissions: ['checkout'],
    });
    const session = new ManagerSession(store);
    session.signIn(cashier.id, '5678');
    expect(() => session.authorize('refunds')).toThrow(
      'PERMISSION_DENIED:refunds',
    );
    session.elevate('refunds', '1234');
    expect(() => session.authorize('refunds')).not.toThrow();
    expect(() => session.authorize('refunds')).toThrow(
      'PERMISSION_DENIED:refunds',
    );
  });

  it('expires an elevation after 90 seconds', () => {
    store.createFirstOwner('Owner', '1234');
    const cashier = store.createStaff({
      name: 'Cashier',
      role: 'cashier',
      pin: '5678',
      permissions: ['checkout'],
    });
    const session = new ManagerSession(store);
    session.signIn(cashier.id, '5678');
    session.elevate('refunds', '1234');
    vi.advanceTimersByTime(90_001);
    expect(() => session.authorize('refunds')).toThrow(
      'PERMISSION_DENIED:refunds',
    );
  });

  it('requires an active owner for elevation', () => {
    store.createFirstOwner('Owner', '1234');
    const cashier = store.createStaff({
      name: 'Cashier',
      role: 'cashier',
      pin: '5678',
      permissions: ['checkout'],
    });
    const session = new ManagerSession(store);
    session.signIn(cashier.id, '5678');
    expect(() => session.elevate('refunds', '9999')).toThrow(
      'INVALID_OWNER_PIN',
    );
  });

  it('counts a bad elevation PIN against every active owner', () => {
    const first = store.createFirstOwner('First owner', '1234');
    const second = store.createStaff({
      name: 'Second owner',
      role: 'owner',
      pin: '5678',
      permissions: [],
    });
    const session = new ManagerSession(store);
    session.signIn(first.id, '1234');
    expect(() => session.elevate('refunds', '9999')).toThrow(
      'INVALID_OWNER_PIN',
    );
    expect(
      store.connection
        .prepare('SELECT failed_attempts FROM staff WHERE id = ?')
        .get(first.id),
    ).toEqual({ failed_attempts: 1 });
    expect(
      store.connection
        .prepare('SELECT failed_attempts FROM staff WHERE id = ?')
        .get(second.id),
    ).toEqual({ failed_attempts: 1 });
  });

  it('locks owners after repeated bad elevation PINs until the window expires', () => {
    const owner = store.createFirstOwner('Owner', '1234');
    const cashier = store.createStaff({
      name: 'Cashier',
      role: 'cashier',
      pin: '5678',
      permissions: ['checkout'],
    });
    const session = new ManagerSession(store);
    session.signIn(cashier.id, '5678');
    for (let attempt = 0; attempt < 5; attempt++)
      expect(() => session.elevate('refunds', '9999')).toThrow(
        'INVALID_OWNER_PIN',
      );
    expect(() => session.elevate('refunds', '1234')).toThrow(
      'INVALID_OWNER_PIN',
    );
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(() => session.elevate('refunds', '1234')).not.toThrow();
    expect(store.verifyStaffPin(owner.id, '1234')).toMatchObject({ ok: true });
  });

  it('locks the session after the configured idle period', () => {
    const owner = store.createFirstOwner('Owner', '1234');
    store.setIdleLockMinutes(1);
    const session = new ManagerSession(store);
    session.signIn(owner.id, '1234');
    vi.advanceTimersByTime(60_001);
    expect(session.checkIdle()).toBe(true);
    expect(session.state.signedInStaff).toBeNull();
  });
});
