import { useEffect, useState } from 'react';
import {
  GRANTABLE_PERMISSIONS,
  permissionLabels,
  type GrantablePermission,
  type StaffAccount,
} from '@shul-store/shared';
import { Keypad } from './AuthScreens';

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
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [resettingPinId, setResettingPinId] = useState<string | null>(null);
  const [resetPinValue, setResetPinValue] = useState('');
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
  function editName(account: StaffAccount) {
    setEditingNameId(account.id);
    setEditingName(account.name);
    setResettingPinId(null);
    setResetPinValue('');
    setError('');
  }
  async function saveName(account: StaffAccount) {
    const next = editingName.trim();
    if (!next || next === account.name) {
      setEditingNameId(null);
      return;
    }
    try {
      await window.storeApi.staff.update(account.id, {
        name: next,
        role: account.role,
        active: account.active,
        permissions: account.permissions,
      });
      setEditingNameId(null);
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not update account.',
      );
    }
  }
  function resetPin(account: StaffAccount) {
    setResettingPinId(account.id);
    setResetPinValue('');
    setEditingNameId(null);
    setError('');
  }
  async function savePin(account: StaffAccount) {
    try {
      await window.storeApi.staff.setPin(account.id, resetPinValue);
      setResettingPinId(null);
      setResetPinValue('');
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
            {editingNameId === account.id ? (
              <div className="staff-inline-form">
                <label>
                  Staff name
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                  />
                </label>
                <div className="staff-inline-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={!editingName.trim()}
                    onClick={() => void saveName(account)}
                  >
                    Save name
                  </button>
                  <button type="button" onClick={() => setEditingNameId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <strong>{account.name}</strong>
                <span>
                  {account.role}
                  {account.active ? '' : ' · inactive'}
                </span>
              </>
            )}
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
            {resettingPinId === account.id && (
              <div className="staff-pin-reset">
                <label>
                  New PIN (4–8 digits)
                  <input
                    value={resetPinValue.replace(/./g, '•')}
                    inputMode="numeric"
                    readOnly
                  />
                </label>
                <Keypad
                  value={resetPinValue}
                  onChange={(value) =>
                    setResetPinValue(value.replace(/\D/g, '').slice(0, 8))
                  }
                />
                <div className="staff-inline-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={resetPinValue.length < 4}
                    onClick={() => void savePin(account)}
                  >
                    Save PIN
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResettingPinId(null);
                      setResetPinValue('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
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
