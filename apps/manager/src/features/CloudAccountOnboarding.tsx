import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowIcon,
  BrandPanels,
  BrandShell,
  GoogleIcon,
} from '@shul-store/brand';
import { messageFrom } from '../utils/formatters';

type Step = 'email' | 'account' | 'confirm';
type Mode = 'signIn' | 'signUp';

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
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mode, setMode] = useState<Mode>('signIn');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [googleAvailable, setGoogleAvailable] = useState(false);

  useEffect(() => {
    void window.storeApi.cloudAccount
      .googleSignInAvailable()
      .then(setGoogleAvailable)
      .catch(() => setGoogleAvailable(false));
  }, []);

  async function continueWithEmail(event: FormEvent) {
    event.preventDefault();
    if (!email) return;
    setBusy(true);
    setMessage('');
    try {
      const exists = await window.storeApi.cloudAccount.lookupEmail(email);
      setMode(exists === false ? 'signUp' : 'signIn');
      setStep('account');
    } catch (error) {
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'signUp' && password !== confirmPassword) {
      setMessage('The passwords do not match.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const state =
        mode === 'signIn'
          ? await window.storeApi.cloudAccount.signIn(email, password)
          : await window.storeApi.cloudAccount.signUp(email, password);
      setPassword('');
      setConfirmPassword('');
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

  async function continueWithGoogle() {
    setBusy(true);
    setMessage('Finish signing in with Google in your browser…');
    try {
      await window.storeApi.cloudAccount.signInWithGoogle(email);
      onDone();
    } catch (error) {
      setMessage(messageFrom(error));
      setBusy(false);
    }
  }

  const googleButton = googleAvailable && (
    <button
      type="button"
      className="suma-button suma-button--google"
      disabled={busy}
      onClick={() => void continueWithGoogle()}
    >
      <GoogleIcon />
      {mode === 'signIn' ? 'Sign in with Google' : 'Sign up with Google'}
    </button>
  );

  return (
    <BrandShell intro={intro}>
      <BrandPanels panelKey={step}>
        {step === 'email' && (
          <>
            <p className="suma-eyebrow">SUMA Systems</p>
            <h1 className="suma-title">Welcome to SUMA</h1>
            <p className="suma-lede">
              Checkout, inventory and ordering for your store — offline-first on
              this PC, backed by your SUMA account in the cloud.
            </p>
            <form
              className="suma-form"
              onSubmit={(event) => void continueWithEmail(event)}
            >
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
                  disabled={!email || busy}
                  aria-label="Continue"
                >
                  <ArrowIcon />
                </button>
              </div>
              {message && <div className="suma-alert">{message}</div>}
            </form>
          </>
        )}
        {step === 'account' && (
          <>
            <p className="suma-eyebrow suma-eyebrow--plain">{email}</p>
            <h1 className="suma-title">
              {mode === 'signIn' ? 'Welcome back' : 'Create your account'}
            </h1>
            {mode === 'signUp' && googleAvailable && (
              <p className="suma-note">
                Signing up with Google also lets SUMA send purchase orders to
                your vendors from your Gmail address.
              </p>
            )}
            <form
              className="suma-form"
              onSubmit={(event) => void submit(event)}
            >
              {googleButton}
              {googleAvailable && <div className="suma-divider">or</div>}
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
              {mode === 'signUp' && (
                <input
                  className="suma-input"
                  type="password"
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              )}
              {message && <div className="suma-alert">{message}</div>}
              <button
                className="suma-button"
                type="submit"
                disabled={
                  busy || !password || (mode === 'signUp' && !confirmPassword)
                }
              >
                {busy ? 'Working…' : mode === 'signIn' ? 'Sign in' : 'Continue'}
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
          </>
        )}
      </BrandPanels>
    </BrandShell>
  );
}
