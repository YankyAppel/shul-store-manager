import { useState, type FormEvent } from 'react';
import { ArrowIcon, BrandPanels, BrandShell } from '@shul-store/brand';
import { messageFrom } from '../utils/formatters';

type Step = 'email' | 'account' | 'confirm';

export function CloudAccountOnboarding({
  intro,
  onDone,
}: {
  /** Play the coin boot animation before the welcome panel. */
  intro: boolean;
  onDone(): void;
}) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function continueWithEmail(event: FormEvent) {
    event.preventDefault();
    if (!email) return;
    setMessage('');
    setStep('account');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const state =
        mode === 'signIn'
          ? await window.storeApi.cloudAccount.signIn(email, password)
          : await window.storeApi.cloudAccount.signUp(email, password);
      setPassword('');
      if (mode === 'signUp' && !state.signedIn) {
        setMessage(
          'Account created — confirm the link in your email, then sign in.',
        );
        setStep('confirm');
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
    <BrandShell intro={intro}>
      <BrandPanels panelKey={step}>
        {step === 'email' && (
          <>
            <p className="suma-eyebrow">SUMA Systems</p>
            <h1 className="suma-title">Welcome to SUMA</h1>
            <p className="suma-lede">
              Checkout, inventory and ordering for your store — offline-first on
              this PC, synced to the SUMA cloud when you want it.
            </p>
            <form className="suma-form" onSubmit={continueWithEmail}>
              <div className="suma-inline">
                <input
                  autoFocus
                  className="suma-input"
                  type="email"
                  placeholder="Email address"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <button
                  className="suma-button"
                  type="submit"
                  disabled={!email}
                  aria-label="Continue"
                >
                  <ArrowIcon />
                </button>
              </div>
            </form>
            <button
              type="button"
              className="suma-button suma-button--link"
              disabled={busy}
              onClick={() => void skip()}
            >
              Not now — use this PC only
            </button>
          </>
        )}
        {step === 'account' && (
          <>
            <p className="suma-eyebrow suma-eyebrow--plain">{email}</p>
            <h1 className="suma-title">
              {mode === 'signIn' ? 'Sign in' : 'Create your account'}
            </h1>
            <form
              className="suma-form"
              onSubmit={(event) => void submit(event)}
            >
              <input
                autoFocus
                className="suma-input"
                type="password"
                placeholder={
                  mode === 'signIn' ? 'Password' : 'Choose a password'
                }
                autoComplete={
                  mode === 'signIn' ? 'current-password' : 'new-password'
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {message && <div className="suma-alert">{message}</div>}
              <button
                className="suma-button"
                type="submit"
                disabled={busy || !password}
              >
                {busy
                  ? 'Working…'
                  : mode === 'signIn'
                    ? 'Sign in'
                    : 'Create account'}
              </button>
              <button
                type="button"
                className="suma-button suma-button--link"
                disabled={busy}
                onClick={() => {
                  setMode(mode === 'signIn' ? 'signUp' : 'signIn');
                  setMessage('');
                }}
              >
                {mode === 'signIn'
                  ? 'New to SUMA? Create an account'
                  : 'Already have an account? Sign in'}
              </button>
              <button
                type="button"
                className="suma-button suma-button--link"
                disabled={busy}
                onClick={() => {
                  setStep('email');
                  setMessage('');
                }}
              >
                Use a different email
              </button>
            </form>
          </>
        )}
        {step === 'confirm' && (
          <>
            <p className="suma-eyebrow suma-eyebrow--plain">{email}</p>
            <h1 className="suma-title">Check your inbox</h1>
            <div className="suma-success">{message}</div>
            <button
              type="button"
              className="suma-button"
              onClick={() => {
                setMode('signIn');
                setStep('account');
                setMessage('');
              }}
            >
              I confirmed — sign in
            </button>
            <button
              type="button"
              className="suma-button suma-button--link"
              onClick={onDone}
            >
              Continue to SUMA Manager
            </button>
          </>
        )}
      </BrandPanels>
    </BrandShell>
  );
}
