import { useEffect, useState } from 'react';
import {
  GRANTABLE_PERMISSIONS,
  permissionLabels,
  type GrantablePermission,
  type StaffAccount,
} from '@shul-store/shared';

const defaults: GrantablePermission[] = [
  'checkout',
  'account_payments',
  'sales.history',
];

export function StaffSection() {
  const [staff, setStaff] = useState<StaffAccount[]>([]);
  const [minutes, setMinutes] = useState(5);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<'owner' | 'cashier'>('cashier');
  const [permissions, setPermissions] =
    useState<GrantablePermission[]>(defaults);
  const [error, setError] = useState('');
  const refresh = async () => {
    const [accounts, device] = await Promise.all([
      window.storeApi.staff.list(),
      window.storeApi.settings.getDevice(),
    ]);
    setStaff(accounts);
    setMinutes(device.idleLockMinutes);
  };
  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
  }, []);
  async function addStaff() {
    try {
      await window.storeApi.staff.create({ name, role, pin, permissions });
      setName('');
      setPin('');
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not add staff account.',
      );
    }
  }
  async function editName(account: StaffAccount) {
    const next = window.prompt('Staff name', account.name)?.trim();
    if (!next || next === account.name) return;
    try {
      await window.storeApi.staff.update(account.id, {
        name: next,
        role: account.role,
        active: account.active,
        permissions: account.permissions,
      });
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not update account.',
      );
    }
  }
  async function resetPin(account: StaffAccount) {
    const next = window.prompt('New PIN (4-8 digits)') ?? '';
    if (!next) return;
    try {
      await window.storeApi.staff.setPin(account.id, next);
      setError('');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not reset PIN.',
      );
    }
  }
  async function togglePermission(
    account: StaffAccount,
    permission: GrantablePermission,
  ) {
    const next = account.permissions.includes(permission)
      ? account.permissions.filter((value) => value !== permission)
      : [...account.permissions, permission];
    try {
      await window.storeApi.staff.update(account.id, {
        name: account.name,
        role: account.role,
        active: account.active,
        permissions: next,
      });
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not update permissions.',
      );
    }
  }
  async function toggle(account: StaffAccount) {
    try {
      await window.storeApi.staff.update(account.id, {
        name: account.name,
        role: account.role,
        active: !account.active,
        permissions: account.permissions,
      });
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not update account.',
      );
    }
  }
  return (
    <section>
      <h2>Staff</h2>
      <p>
        Choose what each cashier can do. Owners always have all permissions.
      </p>
      {error && <div className="alert">{error}</div>}
      <div className="staff-list">
        {staff.map((account) => (
          <div className="staff-row" key={account.id}>
            <strong>{account.name}</strong>
            <span>
              {account.role}
              {account.active ? '' : ' · inactive'}
            </span>
            <button type="button" onClick={() => void editName(account)}>
              Edit
            </button>
            <button type="button" onClick={() => void resetPin(account)}>
              Reset PIN
            </button>
            <button type="button" onClick={() => void toggle(account)}>
              {account.active ? 'Deactivate' : 'Activate'}
            </button>
            {account.role === 'cashier' && (
              <div className="staff-permissions">
                {GRANTABLE_PERMISSIONS.map((permission) => (
                  <label className="check" key={permission}>
                    <input
                      type="checkbox"
                      checked={account.permissions.includes(permission)}
                      onChange={() =>
                        void togglePermission(account, permission)
                      }
                    />{' '}
                    {permissionLabels[permission]}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <h3>Add staff account</h3>
      <div className="staff-form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          PIN (4–8 digits)
          <input
            value={pin}
            inputMode="numeric"
            onChange={(e) =>
              setPin(e.target.value.replace(/\D/g, '').slice(0, 8))
            }
          />
        </label>
        <label>
          Role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'owner' | 'cashier')}
          >
            <option value="cashier">Cashier</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <fieldset>
          <legend>Cashier permissions</legend>
          {GRANTABLE_PERMISSIONS.map((permission) => (
            <label className="check" key={permission}>
              <input
                type="checkbox"
                checked={permissions.includes(permission)}
                onChange={(e) =>
                  setPermissions((current) =>
                    e.target.checked
                      ? [...current, permission]
                      : current.filter((value) => value !== permission),
                  )
                }
              />{' '}
              {permissionLabels[permission]}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="primary"
          disabled={!name.trim() || pin.length < 4}
          onClick={() => void addStaff()}
        >
          Add staff account
        </button>
      </div>
      <label>
        Lock the manager after inactivity (minutes)
        <input
          type="number"
          min="0"
          max="1440"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          onBlur={() => void window.storeApi.staff.setIdleLock(minutes)}
        />
      </label>
    </section>
  );
}
