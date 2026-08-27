import { useEffect, useState, type FormEvent } from 'react';
import type { CloudAccountState } from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';
import { Explain } from '../components/Explain';

function subscriptionDescription(
  entitlement: CloudAccountState['entitlement'],
): string {
  if (!entitlement)
    return 'No cloud subscription — $10/month, or $5 if you already use Shul Task Manager';
  const price =
    entitlement.price === null
      ? entitlement.tier === 'linked'
        ? '$5/month'
        : '$10/month'
      : `$${entitlement.price}/month`;
  const description =
    entitlement.tier === 'linked'
      ? `Linked to ${entitlement.linked_shul_name ?? 'Shul Task Manager'}`
      : price;
  const pricedDescription =
    entitlement.tier === 'linked' ? `${description} — ${price}` : description;
  const cacheNote =
    entitlement.active && entitlement.cached_until
      ? ` (cached until ${new Date(entitlement.cached_until).toLocaleDateString()})`
      : '';
  return `${pricedDescription}, ${entitlement.active ? 'active' : 'inactive'}${cacheNote}`;
}

export function CloudAccountSection() {
  const [state, setState] = useState<CloudAccountState>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [linkOffered, setLinkOffered] = useState(false);
  const [linkUsername, setLinkUsername] = useState('');
  const [linkPassword, setLinkPassword] = useState('');

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.storeApi.cloudAccount.subscribe(setState);
    void window.storeApi.cloudAccount.getState().then(async (next) => {
      if (!mounted) return;
      setState(next);
      if (next.signedIn) {
        try {
          setLinkOffered(await window.storeApi.cloudAccount.linkHint());
        } catch {
          setLinkOffered(false);
        }
      }
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
      setLinkOffered(
        next.signedIn ? await window.storeApi.cloudAccount.linkHint() : false,
      );
      setMessage(
        mode === 'signUp' && !next.signedIn
          ? 'Account created — confirm the link in your email, then sign in.'
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

  async function linkAccount(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const next = await window.storeApi.cloudAccount.link(
        linkUsername,
        linkPassword,
      );
      setState(next);
      setLinkPassword('');
      setLinkOffered(false);
      setMessage('Your Shul Task Manager subscription is linked.');
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
      <h3 style={{ margin: '0 0 4px 0' }}>Shul Store cloud account</h3>
      <Explain
        id="cloud-account"
        sentence="Sign in here to sync this store with your other computers."
      >
        Cloud sync is optional and does not stop local selling. Use the same
        Shul Store account on each computer that should share this store.
      </Explain>
      {!state.signedIn ? (
        <form onSubmit={(event) => void submit(event)}>
          <p style={{ margin: '0 0 10px', color: '#66766d', fontSize: '13px' }}>
            Sign in or create a separate Shul Store account. Local checkout
            continues to work offline and does not require a subscription.
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
          {linkOffered && state.entitlement?.tier !== 'linked' && (
            <form onSubmit={(event) => void linkAccount(event)}>
              <p style={{ color: '#66766d', fontSize: '13px' }}>
                Already use Shul Task Manager? Link it for the lower store
                add-on price.
              </p>
              <div className="form-grid">
                <label>
                  Shul Task Manager username
                  <input
                    value={linkUsername}
                    onChange={(event) => setLinkUsername(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Shul Task Manager password
                  <input
                    type="password"
                    value={linkPassword}
                    onChange={(event) => setLinkPassword(event.target.value)}
                    required
                  />
                </label>
              </div>
              <button className="primary" disabled={busy}>
                {busy ? 'Linking…' : 'Link subscription'}
              </button>
            </form>
          )}
        </>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}
