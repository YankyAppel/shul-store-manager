import { useState } from 'react';
import { messageFrom } from '../utils/formatters';

export function CloudAccountOnboarding({ onDone }: { onDone(): void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmationPending, setConfirmationPending] = useState(false);

  async function submit() {
    setBusy(true);
    setMessage('');
    try {
      const state =
        mode === 'signIn'
          ? await window.storeApi.cloudAccount.signIn(email, password)
          : await window.storeApi.cloudAccount.signUp(email, password);
      setPassword('');
      if (mode === 'signUp' && !state.signedIn) {
        setConfirmationPending(true);
        setMessage(
          'Account created — confirm the link in your email, then sign in.',
        );
      } else {
        onDone();
      }
    } catch (error) {
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    try {
      await window.storeApi.cloudAccount.dismissOnboarding();
      onDone();
    } catch (error) {
      setMessage(messageFrom(error));
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Set up cloud sync</h1>
        <p>
          Sign in or create a Shul Store account to enable cloud backup and
          multi-PC sync. Local checkout always works without an account.
        </p>
        {!confirmationPending ? (
          <>
            <label>
              Email
              <input
                autoFocus
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {message && <div className="alert">{message}</div>}
            <button
              className="primary"
              disabled={busy || !email || !password}
              onClick={() => void submit()}
            >
              {busy
                ? 'Working…'
                : mode === 'signIn'
                  ? 'Sign in'
                  : 'Create account'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMode(mode === 'signIn' ? 'signUp' : 'signIn');
                setMessage('');
              }}
            >
              {mode === 'signIn' ? 'Create an account' : 'Use existing account'}
            </button>
          </>
        ) : (
          <>
            <div className="success">{message}</div>
            <button className="primary" onClick={onDone}>
              Continue to Shul Store
            </button>
          </>
        )}
        <button type="button" disabled={busy} onClick={() => void skip()}>
          Not now — use this PC only
        </button>
      </div>
    </div>
  );
}
