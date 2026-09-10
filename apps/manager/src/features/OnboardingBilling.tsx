import { useEffect, useRef, useState } from 'react';
import { loadStripe, type StripeEmbeddedCheckout } from '@stripe/stripe-js';
import type {
  EmbeddedCheckoutPayload,
  StorePlan,
  StorePlansResult,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';

/**
 * Onboarding billing step: plan catalog from the site's /api/store/plans
 * (env-configured), then a Stripe embedded-checkout session mounted inline —
 * the card never leaves the Stripe iframe and lands on file with the
 * customer's subscription once checkout completes.
 */
export function OnboardingBilling() {
  const [catalog, setCatalog] = useState<StorePlansResult | null>(null);
  const [session, setSession] = useState<EmbeddedCheckoutPayload | null>(null);
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [message, setMessage] = useState('');
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void window.storeApi.cloudAccount
      .listPlans()
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((error) => {
        if (!cancelled) setMessage(messageFrom(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const node = mountRef.current;
    if (!session || !node) return;
    let cancelled = false;
    let checkout: StripeEmbeddedCheckout | null = null;
    void (async () => {
      try {
        const stripe = await loadStripe(session.publishableKey);
        if (!stripe) throw new Error('Stripe failed to load.');
        const created = await stripe.createEmbeddedCheckoutPage({
          clientSecret: session.clientSecret,
          onComplete: () => {
            setCompleted(true);
            void window.storeApi.cloudAccount.refresh();
          },
        });
        if (cancelled) {
          created.destroy();
          return;
        }
        checkout = created;
        checkout.mount(node);
      } catch (error) {
        if (!cancelled) setMessage(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
      checkout?.destroy();
    };
  }, [session]);

  async function choosePlan(plan: StorePlan) {
    if (loadingPlan || completed) return;
    setLoadingPlan(plan.id);
    setMessage('');
    try {
      setSession(await window.storeApi.cloudAccount.embeddedCheckout(plan.id));
    } catch (error) {
      setMessage(messageFrom(error));
    } finally {
      setLoadingPlan(null);
    }
  }

  if (!catalog) {
    return message ? (
      <div className="suma-notice">
        Billing isn&apos;t available right now ({message}) — you can set it up
        later under Settings.
      </div>
    ) : (
      <p className="suma-note">Loading plans…</p>
    );
  }
  if (catalog.active)
    return (
      <div className="suma-success">
        Your subscription is already active on this account.
      </div>
    );
  if (!catalog.billingConfigured || catalog.plans.length === 0)
    return (
      <div className="suma-notice">
        Billing isn&apos;t configured yet — you can pick a plan later under
        Settings.
      </div>
    );

  return (
    <>
      <div className="suma-options">
        {catalog.plans.map((plan) => (
          <button
            key={plan.id}
            type="button"
            className={`suma-option${
              session?.plan.id === plan.id ? ' suma-option--selected' : ''
            }`}
            disabled={completed || loadingPlan !== null}
            onClick={() => void choosePlan(plan)}
          >
            <strong>
              {plan.name} — ${(plan.priceCents / 100).toFixed(2)}/
              {plan.interval === 'year' ? 'yr' : 'mo'}
            </strong>
            {plan.description && <span>{plan.description}</span>}
            <small>
              {loadingPlan === plan.id
                ? 'Starting secure checkout…'
                : 'Billed by Stripe — card stored on file.'}
            </small>
          </button>
        ))}
      </div>
      {session && <div ref={mountRef} className="suma-stripe-mount" />}
      {completed && (
        <div className="suma-success">
          Plan started — your card is on file with Stripe.
        </div>
      )}
      {message && <div className="suma-alert">{message}</div>}
    </>
  );
}
