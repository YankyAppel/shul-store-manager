import { useRef, useState, type FormEvent } from 'react';
import { BrandPanels } from '@shul-store/brand';
import type {
  CardProcessorChoice,
  OnboardingProfile,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';
import { fileToLogoDataUrl } from '../utils/logo';
import { OnboardingBilling } from './OnboardingBilling';

type WizardStep = 'store' | 'receipt' | 'emails' | 'processor' | 'billing';
const STEP_INDEX: Record<WizardStep, number> = {
  store: 1,
  receipt: 2,
  emails: 3,
  processor: 4,
  billing: 5,
};

const PROCESSOR_OPTIONS: {
  id: CardProcessorChoice;
  name: string;
  blurb: string;
  hardware: string;
}[] = [
  {
    id: 'cardknox-bbpos',
    name: 'Sola / Cardknox — BBPOS reader',
    blurb: 'Chip & tap on a reader plugged into this PC.',
    hardware:
      'A BBPOS reader (e.g. Chipper 2X BT, WisePOS E) ordered through your Sola/Cardknox merchant account.',
  },
  {
    id: 'usaepay-payment-engine',
    name: 'USAePay — Payment Engine',
    blurb: 'A standalone Wi-Fi terminal the app pairs to with a code.',
    hardware:
      'A standalone terminal (e.g. Castles MP200) loaded with USAePay Payment Engine, from your merchant provider.',
  },
  {
    id: 'simulated',
    name: 'Simulated — training mode',
    blurb: 'Fake approvals for staff training. No real charges.',
    hardware: 'No hardware needed.',
  },
];

/**
 * Post-sign-up store profile wizard: identity & contact, receipt details,
 * vendor order-email details and the card-processor choice. Everything here
 * stays editable afterwards under Settings.
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
  const [cardProcessorId, setCardProcessorId] =
    useState<CardProcessorChoice | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [reqName, setReqName] = useState(profile.settings.storeName);
  const [reqEmail, setReqEmail] = useState(profile.accountEmail ?? '');
  const [reqProcessor, setReqProcessor] = useState('');
  const [reqNotes, setReqNotes] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [reqStatus, setReqStatus] = useState<'sent' | 'manual' | null>(null);
  const [reqMessage, setReqMessage] = useState('');
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

  async function save() {
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
        cardProcessorId,
      });
      onDone();
    } catch (error) {
      setMessage(messageFrom(error));
      setBusy(false);
    }
  }

  async function sendRequest(event: FormEvent) {
    event.preventDefault();
    setReqBusy(true);
    setReqMessage('');
    setReqStatus(null);
    try {
      const result = await window.storeApi.onboarding.requestIntegration({
        name: reqName.trim(),
        contactEmail: reqEmail.trim(),
        processor: reqProcessor.trim(),
        notes: reqNotes.trim(),
      });
      setReqStatus(result.queued ? 'sent' : 'manual');
    } catch (error) {
      setReqMessage(messageFrom(error));
    } finally {
      setReqBusy(false);
    }
  }

  const stepLabel = (
    <p className="suma-eyebrow">Store profile · step {STEP_INDEX[step]} of 5</p>
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
          <form
            className="suma-form"
            onSubmit={(event) => {
              event.preventDefault();
              setStep('processor');
            }}
          >
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
              Continue
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
      {step === 'processor' && (
        <>
          {stepLabel}
          <h1 className="suma-title">Card processing</h1>
          <p className="suma-lede">
            Choose how customers pay by card. Everything syncs to your other
            devices and stays editable under Settings.
          </p>
          <div className="suma-options">
            {PROCESSOR_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`suma-option${
                  cardProcessorId === option.id ? ' suma-option--selected' : ''
                }`}
                onClick={() => setCardProcessorId(option.id)}
              >
                <strong>{option.name}</strong>
                <span>{option.blurb}</span>
                <small>Hardware: {option.hardware}</small>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="suma-button suma-button--link"
            onClick={() => setRequestOpen((open) => !open)}
          >
            Use a different processor — request an integration
          </button>
          {requestOpen && (
            <form
              className="suma-form"
              onSubmit={(event) => void sendRequest(event)}
            >
              <input
                className="suma-input"
                placeholder="Your name"
                autoComplete="name"
                value={reqName}
                onChange={(event) => setReqName(event.target.value)}
              />
              <input
                className="suma-input"
                type="email"
                placeholder="Contact email"
                autoComplete="email"
                value={reqEmail}
                onChange={(event) => setReqEmail(event.target.value)}
              />
              <input
                className="suma-input"
                placeholder="Processor you use (e.g. Authorize.Net)"
                value={reqProcessor}
                onChange={(event) => setReqProcessor(event.target.value)}
              />
              <textarea
                className="suma-input suma-textarea"
                placeholder="Anything else we should know (optional)"
                rows={2}
                value={reqNotes}
                onChange={(event) => setReqNotes(event.target.value)}
              />
              {reqMessage && <div className="suma-alert">{reqMessage}</div>}
              {reqStatus === 'sent' && (
                <div className="suma-notice">
                  Request sent — we&apos;ll reply at your contact email.
                </div>
              )}
              {reqStatus === 'manual' && (
                <div className="suma-notice">
                  No email account is connected on this PC yet, so we
                  couldn&apos;t send the request. Email your processor details
                  to support@sumasystems.com once you&apos;re set up.
                </div>
              )}
              {reqStatus !== 'sent' && (
                <button
                  className="suma-button suma-button--ghost"
                  type="submit"
                  disabled={
                    reqBusy ||
                    !reqName.trim() ||
                    !reqEmail.trim() ||
                    !reqProcessor.trim()
                  }
                >
                  {reqBusy ? 'Sending…' : 'Send request'}
                </button>
              )}
            </form>
          )}
          {message && <div className="suma-alert">{message}</div>}
          <button
            className="suma-button"
            type="button"
            disabled={busy}
            onClick={() => setStep('billing')}
          >
            Continue
          </button>
          <button
            type="button"
            className="suma-button suma-button--link"
            disabled={busy}
            onClick={() => setStep('emails')}
          >
            Back
          </button>
          {skipLink}
        </>
      )}
      {step === 'billing' && (
        <>
          {stepLabel}
          <h1 className="suma-title">Your plan</h1>
          <p className="suma-lede">
            Pick a plan and add a card — it stays on file with Stripe for your
            subscription. You can finish now and set this up later.
          </p>
          <OnboardingBilling />
          {message && <div className="suma-alert">{message}</div>}
          <button
            className="suma-button"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Finish'}
          </button>
          <button
            type="button"
            className="suma-button suma-button--link"
            disabled={busy}
            onClick={() => setStep('processor')}
          >
            Back
          </button>
        </>
      )}
    </BrandPanels>
  );
}
