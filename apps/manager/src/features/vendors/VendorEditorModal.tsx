import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Vendor, VendorInput } from '@shul-store/shared';
import { messageFrom } from '../../utils/formatters';

export function VendorBadge({
  vendor,
}: {
  vendor: Pick<Vendor, 'status' | 'hasAccount'>;
}) {
  if (vendor.status === 'verified')
    return (
      <span className="badge badge-active" title="Verified SUMA vendor">
        ✓ Verified
      </span>
    );
  if (vendor.hasAccount)
    return (
      <span
        className="badge badge-inactive"
        title="Has a SUMA vendor portal account, verification pending"
      >
        ◌ On portal
      </span>
    );
  return null;
}

export function VendorEditorModal({
  vendor,
  initialName = '',
  onClose,
  onSaved,
  setError,
}: {
  vendor: Vendor | null;
  initialName?: string;
  onClose(): void;
  onSaved(vendor: Vendor): Promise<void> | void;
  setError(value: string): void;
}) {
  const [name, setName] = useState(vendor?.name ?? initialName);
  const [email, setEmail] = useState(vendor?.email ?? '');
  const [phone, setPhone] = useState(vendor?.phone ?? '');
  const [website, setWebsite] = useState(vendor?.website ?? '');
  const [address, setAddress] = useState(vendor?.address ?? '');
  const [notes, setNotes] = useState(vendor?.notes ?? '');
  const [accountNumber, setAccountNumber] = useState(
    vendor?.accountNumber ?? '',
  );
  const [defaultReorderQty, setDefaultReorderQty] = useState(
    vendor?.defaultReorderQty ? String(vendor.defaultReorderQty) : '',
  );
  const [hideListPrice, setHideListPrice] = useState(
    vendor?.hideListPrice ?? false,
  );
  const [similar, setSimilar] = useState<Vendor[]>([]);
  const [saving, setSaving] = useState(false);
  const contactLocked = Boolean(vendor?.shared && vendor.hasAccount);

  useEffect(() => {
    if (vendor || name.trim().length < 3) {
      setSimilar([]);
      return;
    }
    const handle = setTimeout(() => {
      void window.storeApi.vendors
        .findSimilar(name, email.trim() || null)
        .then(setSimilar)
        .catch(() => setSimilar([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [name, email, vendor]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const input: VendorInput = {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        website: website.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
        accountNumber: accountNumber.trim() || null,
        defaultReorderQty: defaultReorderQty.trim()
          ? Number(defaultReorderQty)
          : null,
        hideListPrice,
      };
      const saved = vendor
        ? await window.storeApi.vendors.update(vendor.id, input)
        : await window.storeApi.vendors.create(input);
      await onSaved(saved);
    } catch (e) {
      setError(messageFrom(e));
      setSaving(false);
    }
  }

  // Portalled so it can open from inside the product form without nesting forms.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-title">
          <h2>{vendor ? 'Edit vendor' : 'New vendor'}</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          {contactLocked && (
            <p className="hint">
              This vendor manages its own contact details on the SUMA vendor
              portal; only your store settings below can be changed.
            </p>
          )}
          <div className="form-grid">
            <label>
              Vendor name
              <input
                autoFocus
                required
                maxLength={200}
                disabled={contactLocked}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Order email <em>Optional</em>
              <input
                type="email"
                maxLength={200}
                disabled={contactLocked}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Phone <em>Optional</em>
              <input
                maxLength={50}
                disabled={contactLocked}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <label>
              Website <em>Optional</em>
              <input
                maxLength={200}
                disabled={contactLocked}
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </label>
          </div>
          {similar.length > 0 && (
            <div className="alert" style={{ marginTop: 8 }}>
              <span>
                Similar vendor{similar.length > 1 ? 's' : ''} already exist:{' '}
                {similar.map((v) => v.name).join(', ')}. Pick the existing one
                instead of creating a duplicate if it is the same company.
              </span>
            </div>
          )}
          <label>
            Address <em>Optional</em>
            <textarea
              rows={2}
              maxLength={500}
              disabled={contactLocked}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <h3 style={{ margin: '16px 0 4px' }}>Your store settings</h3>
          <div className="form-grid">
            <label>
              Your account # with this vendor <em>Optional</em>
              <input
                maxLength={100}
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
              />
            </label>
            <label>
              Default reorder quantity{' '}
              <em>Used when a product has no case size or override</em>
              <input
                type="number"
                min="1"
                step="1"
                value={defaultReorderQty}
                onChange={(e) => setDefaultReorderQty(e.target.value)}
              />
            </label>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={hideListPrice}
              onChange={(e) => setHideListPrice(e.target.checked)}
            />{' '}
            Hide this vendor&apos;s list prices; only use my negotiated costs
          </label>
          <label>
            Notes <em>Private to your store</em>
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
            <button className="primary" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save vendor'}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
