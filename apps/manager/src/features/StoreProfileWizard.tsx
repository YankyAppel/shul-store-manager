import { useRef, useState, type FormEvent } from 'react';
import { BrandPanels } from '@shul-store/brand';
import type { OnboardingProfile } from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';
import { fileToLogoDataUrl } from '../utils/logo';

type WizardStep = 'store' | 'receipt' | 'emails';
const STEP_INDEX: Record<WizardStep, number> = {
  store: 1,
  receipt: 2,
  emails: 3,
};

/**
 * Post-sign-up store profile wizard: identity & contact, receipt details and
 * vendor order-email details. Everything here stays editable afterwards under
 * Settings → General / Order emails.
 */
export function StoreProfileWizard({
  profile,
  onDone,
}: {
  profile: OnboardingProfile;
  onDone(): void;
}) {
  const contact = profile.settings.contactLines;
  const contactEmail = contact.find((line) => line.includes('@')) ?? '';
  const contactPhone =
    contact.find((line) => /\d{3}.*\d{4}/.test(line) && !line.includes('@')) ??
    '';
  const address = contact.filter(
    (line) => line !== contactEmail && line !== contactPhone,
  );

  const [step, setStep] = useState<WizardStep>('store');
  const [storeName, setStoreName] = useState(profile.settings.storeName);
  const [addressLine1, setAddressLine1] = useState(address[0] ?? '');
  const [addressLine2, setAddressLine2] = useState(address[1] ?? '');
  const [phone, setPhone] = useState(contactPhone);
  const [email, setEmail] = useState(contactEmail);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(
    profile.settings.logoDataUrl,
  );
  const [receiptFooter, setReceiptFooter] = useState(
    profile.settings.receiptFooter,
  );
  const [orderFromName, setOrderFromName] = useState(
    profile.orderEmail.fromName ?? profile.settings.storeName,
  );
  const [orderCcSelf, setOrderCcSelf] = useState(profile.orderEmail.ccSelf);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function chooseLogo(file: File | undefined) {
    if (!file) return;
    setMessage('');
    try {
      setLogoDataUrl(await fileToLogoDataUrl(file));
    } catch (error) {
      setMessage(messageFrom(error));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function continueFromStore(event: FormEvent) {
    event.preventDefault();
    if (!storeName.trim()) {
      setMessage('Enter your store name.');
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setMessage('Enter a valid email address, or leave it blank.');
      return;
    }
    setMessage('');
    setStep('receipt');
  }

  async function skip() {
    setBusy(true);
    setMessage('');
    try {
      await window.storeApi.onboarding.skipProfile();
      onDone();
    } catch (error) {
      setMessage(messageFrom(error));
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await window.storeApi.onboarding.saveProfile({
        storeName,
        addressLines: [addressLine1, addressLine2]
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        phone: phone.trim(),
        email: email.trim(),
        receiptFooter,
        logoDataUrl,
        orderFromName: orderFromName.trim(),
        orderCcSelf,
      });
      onDone();
    } catch (error) {
      setMessage(messageFrom(error));
      setBusy(false);
    }
  }

  const stepLabel = (
    <p className="suma-eyebrow">Store profile · step {STEP_INDEX[step]} of 3</p>
  );
  const skipLink = (
    <button
      type="button"
      className="suma-button suma-button--link"
      disabled={busy}
      onClick={() => void skip()}
    >
      Skip — I&apos;ll set this up later
    </button>
  );

  return (
    <BrandPanels panelKey={step}>
      {step === 'store' && (
        <>
          {stepLabel}
          <h1 className="suma-title">Your store</h1>
          <p className="suma-lede">
            This appears on receipts and emails you send to vendors.
          </p>
          <form
            className="suma-form"
            onSubmit={(event) => continueFromStore(event)}
          >
            <div className="suma-logo-picker">
              {logoDataUrl ? (
                <img
                  className="suma-logo-preview"
                  src={logoDataUrl}
                  alt="Store logo"
                />
              ) : (
                <div className="suma-logo-placeholder">Logo</div>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => void chooseLogo(event.target.files?.[0])}
              />
              <div className="suma-inline">
                <button
                  type="button"
                  className="suma-button suma-button--ghost"
                  onClick={() => fileInput.current?.click()}
                >
                  {logoDataUrl ? 'Change logo' : 'Choose a logo'}
                </button>
                {logoDataUrl && (
                  <button
                    type="button"
                    className="suma-button suma-button--link"
                    onClick={() => setLogoDataUrl(null)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <input
              autoFocus
              className="suma-input"
              placeholder="Store name"
              autoComplete="organization"
              value={storeName}
              onChange={(event) => setStoreName(event.target.value)}
            />
            <input
              className="suma-input"
              placeholder="Address line 1"
              autoComplete="address-line1"
              value={addressLine1}
              onChange={(event) => setAddressLine1(event.target.value)}
            />
            <input
              className="suma-input"
              placeholder="Address line 2 (city, state, zip)"
              autoComplete="address-line2"
              value={addressLine2}
              onChange={(event) => setAddressLine2(event.target.value)}
            />
            <input
              className="suma-input"
              type="tel"
              placeholder="Phone number"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <input
              className="suma-input"
              type="email"
              placeholder="Store email (optional)"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            {message && <div className="suma-alert">{message}</div>}
            <button className="suma-button" type="submit" disabled={busy}>
              Continue
            </button>
            {skipLink}
          </form>
        </>
      )}
      {step === 'receipt' && (
        <>
          {stepLabel}
          <h1 className="suma-title">Receipts</h1>
          <p className="suma-lede">
            Your logo, store name and contact details print at the top of every
            receipt. Add a footer line — hours, return policy, thanks.
          </p>
          <form
            className="suma-form"
            onSubmit={(event) => {
              event.preventDefault();
              setStep('emails');
            }}
          >
            <textarea
              autoFocus
              className="suma-input suma-textarea"
              placeholder={
                'Receipt footer — e.g. "Thank you for shopping with us!"'
              }
              rows={3}
              value={receiptFooter}
              onChange={(event) => setReceiptFooter(event.target.value)}
            />
            {message && <div className="suma-alert">{message}</div>}
            <button className="suma-button" type="submit" disabled={busy}>
              Continue
            </button>
            <button
              type="button"
              className="suma-button suma-button--link"
              disabled={busy}
              onClick={() => setStep('store')}
            >
              Back
            </button>
          </form>
        </>
      )}
      {step === 'emails' && (
        <>
          {stepLabel}
          <h1 className="suma-title">Order emails</h1>
          <p className="suma-lede">
            {profile.orderEmail.configured && profile.orderEmail.fromAddress
              ? `Purchase orders are sent from ${profile.orderEmail.fromAddress}.`
              : 'No email account connected yet — you can add one later under Settings → Order emails.'}
          </p>
          <form className="suma-form" onSubmit={(event) => void save(event)}>
            <label className="suma-field">
              <span>Vendor emails come from</span>
              <input
                className="suma-input"
                placeholder="Your store name"
                value={orderFromName}
                onChange={(event) => setOrderFromName(event.target.value)}
              />
            </label>
            <label className="suma-check">
              <input
                type="checkbox"
                checked={orderCcSelf}
                onChange={(event) => setOrderCcSelf(event.target.checked)}
              />
              <span>Send a copy of every purchase order to the store</span>
            </label>
            {message && <div className="suma-alert">{message}</div>}
            <button className="suma-button" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Finish'}
            </button>
            <button
              type="button"
              className="suma-button suma-button--link"
              disabled={busy}
              onClick={() => setStep('receipt')}
            >
              Back
            </button>
            {skipLink}
          </form>
        </>
      )}
    </BrandPanels>
  );
}
