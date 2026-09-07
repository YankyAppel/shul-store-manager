import { useEffect, useState } from 'react';
import type {
  ProductVendorLinkInput,
  Vendor,
  VendorProduct,
} from '@shul-store/shared';
import { formatMoney, messageFrom } from '../../utils/formatters';
import { VendorBadge, VendorEditorModal } from './VendorEditorModal';

export interface VendorLinkDraft {
  vendorId: string;
  preferred: boolean;
  cost: string;
  reorderQty: string;
  vendorSku: string;
}

export function draftsToLinks(
  drafts: VendorLinkDraft[],
): ProductVendorLinkInput[] {
  return drafts.map((draft) => ({
    vendorId: draft.vendorId,
    preferred: draft.preferred,
    costCents: draft.cost.trim() ? Math.round(Number(draft.cost) * 100) : null,
    reorderQty: draft.reorderQty.trim() ? Number(draft.reorderQty) : null,
    vendorSku: draft.vendorSku.trim() || null,
  }));
}

export function ProductVendorsField({
  drafts,
  onChange,
  barcodes,
  setError,
}: {
  drafts: VendorLinkDraft[];
  onChange(drafts: VendorLinkDraft[]): void;
  barcodes: string[];
  setError(value: string): void;
}) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [pick, setPick] = useState('');
  const [creating, setCreating] = useState(false);
  const [offers, setOffers] = useState<VendorProduct[]>([]);
  const [checkingOffers, setCheckingOffers] = useState(false);

  const loadVendors = () =>
    window.storeApi.vendors
      .list()
      .then(setVendors)
      .catch((e) => setError(messageFrom(e)));
  useEffect(() => {
    void loadVendors();
  }, []);

  function add(vendorId: string) {
    if (!vendorId || drafts.some((d) => d.vendorId === vendorId)) return;
    onChange([
      ...drafts,
      {
        vendorId,
        preferred: drafts.length === 0,
        cost: '',
        reorderQty: '',
        vendorSku: '',
      },
    ]);
    setPick('');
  }
  function update(vendorId: string, patch: Partial<VendorLinkDraft>) {
    onChange(
      drafts.map((d) => (d.vendorId === vendorId ? { ...d, ...patch } : d)),
    );
  }
  function remove(vendorId: string) {
    const next = drafts.filter((d) => d.vendorId !== vendorId);
    if (next.length > 0 && !next.some((d) => d.preferred))
      next[0] = { ...next[0]!, preferred: true };
    onChange(next);
  }
  function prefer(vendorId: string) {
    onChange(drafts.map((d) => ({ ...d, preferred: d.vendorId === vendorId })));
  }
  async function findOffers() {
    setCheckingOffers(true);
    try {
      setOffers(await window.storeApi.vendors.catalogOffers(barcodes));
      await loadVendors();
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setCheckingOffers(false);
    }
  }
  function useOffer(offer: VendorProduct) {
    if (!drafts.some((d) => d.vendorId === offer.vendorId)) add(offer.vendorId);
    onChange(
      (drafts.some((d) => d.vendorId === offer.vendorId)
        ? drafts
        : [
            ...drafts,
            {
              vendorId: offer.vendorId,
              preferred: drafts.length === 0,
              cost: '',
              reorderQty: '',
              vendorSku: '',
            },
          ]
      ).map((d) =>
        d.vendorId === offer.vendorId
          ? { ...d, vendorSku: d.vendorSku || (offer.sku ?? '') }
          : d,
      ),
    );
    setOffers(offers.filter((o) => o.id !== offer.id));
  }

  const available = vendors.filter(
    (v) => !drafts.some((d) => d.vendorId === v.id),
  );
  const nameOf = (id: string) => vendors.find((v) => v.id === id);

  return (
    <div className="barcode-box">
      <label>
        Vendors{' '}
        <em>
          Who you buy this from; the preferred vendor gets reorder suggestions
        </em>
        <div className="barcode-entry">
          <select value={pick} onChange={(e) => add(e.target.value)}>
            <option value="">Add a vendor…</option>
            {available.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setCreating(true)}>
            + New vendor
          </button>
          {barcodes.length > 0 && (
            <button
              type="button"
              disabled={checkingOffers}
              onClick={() => void findOffers()}
              title="Look up which SUMA vendors sell these barcodes"
            >
              {checkingOffers ? 'Checking…' : 'Find in shared catalog'}
            </button>
          )}
        </div>
      </label>
      {offers.length > 0 && (
        <div className="chips">
          {offers.map((offer) => (
            <button
              type="button"
              key={offer.id}
              onClick={() => useOffer(offer)}
              title="Link this vendor"
            >
              {nameOf(offer.vendorId)?.name ?? 'Vendor'}
              {offer.priceCents !== null &&
                ` · ${formatMoney(offer.priceCents)}`}
              {offer.caseSize && ` · case of ${offer.caseSize}`} +
            </button>
          ))}
        </div>
      )}
      {drafts.length > 0 && (
        <table className="vendor-links">
          <thead>
            <tr>
              <th>Preferred</th>
              <th>Vendor</th>
              <th>Your cost ($)</th>
              <th>Reorder qty</th>
              <th>Vendor SKU</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((draft) => {
              const vendor = nameOf(draft.vendorId);
              return (
                <tr key={draft.vendorId}>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="radio"
                      name="preferred-vendor"
                      checked={draft.preferred}
                      onChange={() => prefer(draft.vendorId)}
                    />
                  </td>
                  <td>
                    {vendor?.name ?? '…'}{' '}
                    {vendor && <VendorBadge vendor={vendor} />}
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="list price"
                      value={draft.cost}
                      onChange={(e) =>
                        update(draft.vendorId, { cost: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="case size"
                      value={draft.reorderQty}
                      onChange={(e) =>
                        update(draft.vendorId, { reorderQty: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <input
                      maxLength={100}
                      value={draft.vendorSku}
                      onChange={(e) =>
                        update(draft.vendorId, { vendorSku: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => remove(draft.vendorId)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {creating && (
        <VendorEditorModal
          vendor={null}
          onClose={() => setCreating(false)}
          onSaved={async (vendor) => {
            setCreating(false);
            await loadVendors();
            add(vendor.id);
          }}
          setError={setError}
        />
      )}
    </div>
  );
}
