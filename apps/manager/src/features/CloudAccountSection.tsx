import { useEffect, useState, type FormEvent } from 'react';
import type { CloudAccountState } from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';
import { Explain } from '../components/Explain';

function subscriptionDescription(
  entitlement: CloudAccountState['entitlement'],
): string {
  if (!entitlement) return 'No cloud subscription — $10/month per store';
  const price = `$${entitlement.price ?? 10}/month`;
  const cacheNote =
    entitlement.active && entitlement.cached_until
      ? ` (cached until ${new Date(entitlement.cached_until).toLocaleDateString()})`
      : '';
  return `${price}, ${entitlement.active ? 'active' : 'inactive'}${cacheNote}`;
}

export function CloudAccountSection() {
  const [state, setState] = useState<CloudAccountState>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [editingPassword, setEditingPassword] = useState(false);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.storeApi.cloudAccount.subscribe(setState);
    void window.storeApi.cloudAccount.getState().then((next) => {
      if (mounted) setState(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!state) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const next =
        mode === 'signIn'
          ? await window.storeApi.cloudAccount.signIn(email, password)
          : await window.storeApi.cloudAccount.signUp(email, password);
      setState(next);
      setPassword('');
      if (mode === 'signUp' && next.signedIn && !next.entitlement?.active) {
        await window.storeApi.cloudAccount.checkout();
        setMessage(
          'Account created — finish your subscription in the browser.',
        );
        return;
      }
      setMessage(
        mode === 'signUp' && !next.signedIn
          ? 'Account created — confirm the link in your email, then sign in to start your subscription.'
          : mode === 'signUp'
            ? 'Account created.'
            : 'Signed in.',
      );
    } catch (error) {
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage('The passwords do not match.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      setState(await window.storeApi.cloudAccount.setPassword(newPassword));
      setNewPassword('');
      setConfirmPassword('');
      setEditingPassword(false);
      setMessage(
        'Password saved. You can now sign in with email and password.',
      );
    } catch (error) {
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function openBilling(action: 'checkout' | 'portal') {
    setBusy(true);
    setMessage('');
    try {
      await window.storeApi.cloudAccount[action]();
      setMessage('Opened in your browser.');
    } catch (error) {
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-form">
      <h3 style={{ margin: '0 0 4px 0' }}>Suma Store cloud account</h3>
      <Explain
        id="cloud-account"
        sentence="Sign in here to sync this store with your other computers."
      >
        Cloud sync is optional and does not stop local selling. Use the same
        Suma Store account on each computer that should share this store.
      </Explain>
      {!state.signedIn ? (
        <form onSubmit={(event) => void submit(event)}>
          <p style={{ margin: '0 0 10px', color: '#5f6d65', fontSize: '13px' }}>
            Sign in or create a Suma Store account. Creating an account starts
            the $10/month cloud subscription; local checkout continues to work
            offline and does not require one.
          </p>
          <div className="form-grid">
            <label>
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </div>
          <button className="primary" disabled={busy}>
            {busy
              ? 'Working…'
              : mode === 'signIn'
                ? 'Sign in'
                : 'Create account'}
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}
          >
            {mode === 'signIn' ? 'Create an account' : 'Use existing account'}
          </button>
        </form>
      ) : (
        <>
          <p>
            Signed in as <strong>{state.email}</strong>
          </p>
          <p>
            <strong>{subscriptionDescription(state.entitlement)}</strong>
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void openBilling(
                  state.entitlement?.active ? 'portal' : 'checkout',
                )
              }
            >
              {state.entitlement?.active ? 'Manage subscription' : 'Subscribe'}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void window.storeApi.cloudAccount.signOut().then(setState)
              }
            >
              Sign out
            </button>
          </div>
          <h4 style={{ margin: '18px 0 4px' }}>Password</h4>
          {editingPassword ? (
            <form onSubmit={(event) => void savePassword(event)}>
              <div className="form-grid">
                <label>
                  New password
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <label>
                  Confirm password
                  <input
                    type="password"
                    required
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </label>
              </div>
              <button className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save password'}
              </button>{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditingPassword(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <p style={{ margin: '0 0 10px', color: '#5f6d65', fontSize: 13 }}>
                {state.hasPassword
                  ? 'You can sign in with your email and password, or with Google using the same email.'
                  : 'You signed up with Google. Set a password to also sign in with email and password.'}
              </p>
              <button disabled={busy} onClick={() => setEditingPassword(true)}>
                {state.hasPassword ? 'Change password' : 'Set a password'}
              </button>
            </>
          )}
        </>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}
