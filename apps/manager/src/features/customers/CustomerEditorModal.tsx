import { useState, type FormEvent } from 'react';
import type { Customer, CustomerInput } from '@shul-store/shared';
import { messageFrom } from '../../utils/formatters';

export function CustomerEditorModal({
  customer,
  onClose,
  onSaved,
  setError,
}: {
  customer: Customer | null;
  onClose(): void;
  onSaved(customer: Customer): Promise<void>;
  setError(value: string): void;
}) {
  const [accountNumber, setAccountNumber] = useState(
    customer?.accountNumber ?? '',
  );
  const [accountBarcode, setAccountBarcode] = useState(
    customer?.accountBarcode ?? '',
  );
  const [name, setName] = useState(customer?.name ?? '');
  const [secondaryName, setSecondaryName] = useState(
    customer?.secondaryName ?? '',
  );
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [address, setAddress] = useState(customer?.address ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [creditLimitDollars, setCreditLimitDollars] = useState(
    customer?.creditLimitCents !== null &&
      customer?.creditLimitCents !== undefined
      ? (customer.creditLimitCents / 100).toFixed(2)
      : '',
  );
  const [saving, setSaving] = useState(false);

  async function handleAutoGenerateAccountNumber() {
    try {
      const generated = await window.storeApi.customers.generateAccountNumber();
      setAccountNumber(generated);
    } catch (e) {
      setError(messageFrom(e));
    }
  }

  async function handleGenerateBarcode() {
    try {
      const generated = await window.storeApi.customers.generateBarcode();
      setAccountBarcode(generated);
    } catch (e) {
      setError(messageFrom(e));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const parsedLimit =
        creditLimitDollars.trim() !== ''
          ? Math.round(Number(creditLimitDollars) * 100)
          : null;

      const input: CustomerInput = {
        accountNumber: accountNumber.trim(),
        accountBarcode: accountBarcode.trim() || null,
        name: name.trim(),
        secondaryName: secondaryName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
        creditLimitCents: parsedLimit,
      };

      let saved: Customer;
      if (customer) {
        saved = await window.storeApi.customers.update(customer.id, input);
      } else {
        saved = await window.storeApi.customers.create(input);
      }
      await onSaved(saved);
    } catch (e) {
      setError(messageFrom(e));
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-title">
          <h2>{customer ? 'Edit customer' : 'New customer'}</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label>
              Full name
              <input
                autoFocus
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Secondary name <em>Optional</em>
              <input
                maxLength={200}
                value={secondaryName}
                onChange={(e) => setSecondaryName(e.target.value)}
              />
            </label>
          </div>

          <div className="form-grid">
            <label>
              Account number
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                <input
                  required
                  maxLength={50}
                  style={{ margin: 0 }}
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
                <button
                  type="button"
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => void handleAutoGenerateAccountNumber()}
                >
                  Auto-generate
                </button>
              </div>
            </label>
            <label>
              Account barcode <em>Optional</em>
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                <input
                  maxLength={100}
                  style={{ margin: 0 }}
                  value={accountBarcode}
                  onChange={(e) => setAccountBarcode(e.target.value)}
                />
                <button
                  type="button"
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => void handleGenerateBarcode()}
                >
                  Generate Code 128
                </button>
              </div>
            </label>
          </div>

          <div className="form-grid">
            <label>
              Phone number <em>Optional</em>
              <input
                type="tel"
                maxLength={50}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <label>
              Email address <em>Optional</em>
              <input
                type="email"
                maxLength={200}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          </div>

          <label>
            Mailing / Street address <em>Optional</em>
            <input
              maxLength={500}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>

          <label>
            Customer-specific credit limit ($){' '}
            <em>Leave blank to use store default</em>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Store default"
              value={creditLimitDollars}
              onChange={(e) => setCreditLimitDollars(e.target.value)}
            />
          </label>

          <label>
            Notes <em>Optional</em>
            <textarea
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          <footer>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={saving || !name || !accountNumber}
            >
              {saving ? 'Saving…' : 'Save customer'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
