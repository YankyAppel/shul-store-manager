import { useEffect, useState } from 'react';
import type { StaffPickerAccount } from '@shul-store/shared';

export function Keypad({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const press = (key: string) => {
    if (key === 'clear') return onChange('');
    if (key === 'back') return onChange(value.slice(0, -1));
    if (value.length < 8) onChange(value + key);
  };
  return (
    <div className="pin-keypad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].map(
        (key) => (
          <button type="button" key={key} onClick={() => press(key)}>
            {key === 'clear' ? 'Clear' : key === 'back' ? '⌫' : key}
          </button>
        ),
      )}
    </div>
  );
}

export function FirstOwnerSetup({
  onComplete,
  onSkip,
}: {
  onComplete(): void;
  onSkip(): void;
}) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  async function submit() {
    try {
      await window.storeApi.auth.createFirstOwner(name, pin);
      onComplete();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not create owner.',
      );
    }
  }
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Set up staff sign-in</h1>
        <p>
          Staff mode protects the manager app with individual accounts. Create
          the first owner account to get started.
        </p>
        <label>
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Owner PIN (4–8 digits)
          <input value={pin.replace(/./g, '•')} readOnly />
        </label>
        <Keypad value={pin} onChange={setPin} />
        {error && <div className="alert">{error}</div>}
        <button
          className="primary"
          disabled={!name.trim() || pin.length < 4}
          onClick={() => void submit()}
        >
          Create owner account
        </button>
        <button type="button" onClick={onSkip}>
          Continue without staff sign-in
        </button>
      </div>
    </div>
  );
}

export function LockScreen({ onSignedIn }: { onSignedIn(): void }) {
  const [accounts, setAccounts] = useState<StaffPickerAccount[]>([]);
  const [selected, setSelected] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void window.storeApi.auth.listAccounts().then((value) => {
      setAccounts(value);
      setSelected(value[0]?.id ?? '');
    });
  }, []);
  async function signIn() {
    try {
      await window.storeApi.auth.signIn(selected, pin);
      setPin('');
      setError('');
      onSignedIn();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
              .replace(/^Error invoking remote method '[^']+': /, '')
              .replace(
                /^ACCOUNT_LOCKED:.*/,
                'This account is temporarily locked. Try again in a few minutes.',
              )
              .replace('INVALID_PIN', 'That PIN is incorrect.')
          : 'Sign-in failed.',
      );
    }
  }
  const selectedAccount = accounts.find((account) => account.id === selected);
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Manager locked</h1>
        <p>Select your name and enter your PIN to continue.</p>
        <label>
          Account
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setPin('');
              setError('');
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.role})
              </option>
            ))}
          </select>
        </label>
        <label>
          PIN
          <input value={pin.replace(/./g, '•')} readOnly />
        </label>
        <Keypad value={pin} onChange={setPin} />
        {selectedAccount?.lockedUntil &&
          Date.parse(selectedAccount.lockedUntil) > Date.now() && (
            <div className="alert">
              This account is temporarily locked. Try again in a few minutes.
            </div>
          )}
        {error && <div className="alert">{error}</div>}
        <button
          className="primary"
          disabled={!selected || pin.length < 4}
          onClick={() => void signIn()}
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
