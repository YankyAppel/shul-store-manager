import { useEffect, useMemo, useState } from 'react';
import type {
  BuyingListLine,
  Product,
  PurchaseOrderSummary,
  Vendor,
  VendorSummary,
} from '@shul-store/shared';
import { formatMoney, messageFrom } from '../../utils/formatters';
import { VendorBadge, VendorEditorModal } from './VendorEditorModal';
import {
  OrderModal,
  PurchaseOrderHistory,
  ReceiveModal,
} from './PurchaseOrderModals';

export function VendorsScreen() {
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Vendor | null | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      setVendors(await window.storeApi.vendors.list());
    } catch (e) {
      setError(messageFrom(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  async function refreshCatalog() {
    setRefreshing(true);
    setNotice('');
    try {
      const result = await window.storeApi.vendors.refreshCatalog();
      setNotice(
        `Shared catalog updated: ${result.vendors} vendor${result.vendors === 1 ? '' : 's'}, ${result.products} product${result.products === 1 ? '' : 's'}${result.merged > 0 ? `, ${result.merged} duplicate vendor${result.merged === 1 ? '' : 's'} merged` : ''}.`,
      );
      await refresh();
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setRefreshing(false);
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vendors.filter(
      (v) =>
        !q ||
        `${v.name} ${v.email ?? ''} ${v.phone ?? ''}`.toLowerCase().includes(q),
    );
  }, [vendors, search]);

  const selected = vendors.find((v) => v.id === selectedId) ?? null;
  if (selected)
    return (
      <VendorDetail
        vendor={selected}
        onBack={() => {
          setSelectedId(null);
          void refresh();
        }}
        onEdit={() => setEditing(selected)}
        editing={editing}
        onEditClosed={() => setEditing(undefined)}
        onEdited={async () => {
          setEditing(undefined);
          await refresh();
        }}
        setError={setError}
      />
    );

  return (
    <div className="vendors-screen">
      {error && (
        <div className="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="hint" style={{ marginBottom: 12 }}>
          {notice}
        </div>
      )}
      <section className="toolbar">
        <label className="search">
          ⌕
          <input
            placeholder="Search vendors by name, email, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void refreshCatalog()}
            title="Pull vendors and prices from the shared SUMA catalog (requires internet)"
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh shared catalog'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setEditing(null)}
          >
            + New vendor
          </button>
        </div>
      </section>

      {visible.length === 0 ? (
        <div className="empty">
          <b>No vendors yet</b>
          <p>
            Add a vendor here or from a product, then link products to it.
            Products that fall to their low-stock alert are added to the
            vendor&apos;s buying list automatically.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Contact</th>
                <th style={{ textAlign: 'right' }}>Products</th>
                <th style={{ textAlign: 'right' }}>To order</th>
                <th style={{ textAlign: 'right' }}>Estimated total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((vendor) => (
                <tr key={vendor.id}>
                  <td>
                    <strong>{vendor.name}</strong>{' '}
                    <VendorBadge vendor={vendor} />
                    {vendor.accountNumber && (
                      <small>Acct # {vendor.accountNumber}</small>
                    )}
                  </td>
                  <td>
                    <div>{vendor.email || vendor.phone || '—'}</div>
                    {vendor.email && vendor.phone && (
                      <small>{vendor.phone}</small>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {vendor.linkedProductCount}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                    {vendor.openLineCount > 0
                      ? `${vendor.openLineCount} item${vendor.openLineCount === 1 ? '' : 's'} · ${vendor.openQuantity} units`
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {vendor.openLineCount > 0
                      ? formatMoney(vendor.estimatedTotalCents)
                      : '—'}
                    {vendor.unpricedLineCount > 0 && (
                      <small>{vendor.unpricedLineCount} unpriced</small>
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className={vendor.openLineCount > 0 ? 'primary' : ''}
                        onClick={() => setSelectedId(vendor.id)}
                      >
                        {vendor.openLineCount > 0 ? 'Review order' : 'Open'}
                      </button>
                      <button type="button" onClick={() => setEditing(vendor)}>
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <VendorEditorModal
          vendor={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await refresh();
          }}
          setError={setError}
        />
      )}
    </div>
  );
}

function VendorDetail({
  vendor,
  onBack,
  onEdit,
  editing,
  onEditClosed,
  onEdited,
  setError,
}: {
  vendor: VendorSummary;
  onBack(): void;
  onEdit(): void;
  editing: Vendor | null | undefined;
  onEditClosed(): void;
  onEdited(): Promise<void>;
  setError(value: string): void;
}) {
  const [lines, setLines] = useState<BuyingListLine[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [addProductId, setAddProductId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [orders, setOrders] = useState<PurchaseOrderSummary[]>([]);
  const [storeName, setStoreName] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [receivingId, setReceivingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const [list, catalog, history] = await Promise.all([
        window.storeApi.vendors.buyingList(vendor.id),
        window.storeApi.products.list(false),
        window.storeApi.purchaseOrders.list(vendor.id),
      ]);
      setLines(list);
      setProducts(catalog);
      setOrders(history);
      setDrafts({});
    } catch (e) {
      setError(messageFrom(e));
    }
  };
  useEffect(() => {
    void load();
    window.storeApi.settings
      .get()
      .then((settings) => setStoreName(settings.storeName))
      .catch(() => undefined);
    return window.storeApi.purchaseOrders.subscribe(() => void load());
  }, [vendor.id]);

  const total = lines.reduce(
    (sum, line) => sum + (line.unitCostCents ?? 0) * line.quantity,
    0,
  );
  const unpriced = lines.filter((line) => line.unitCostCents === null).length;
  const addable = products.filter(
    (product) => !lines.some((line) => line.productId === product.id),
  );

  async function commitQuantity(line: BuyingListLine) {
    const raw = drafts[line.id];
    if (raw === undefined) return;
    const value = raw.trim() === '' ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      setError('Quantity must be a whole number of at least 1.');
      return;
    }
    try {
      await window.storeApi.vendors.updateLine(line.id, {
        quantityOverride: value,
      });
      await load();
    } catch (e) {
      setError(messageFrom(e));
    }
  }
  async function dismiss(line: BuyingListLine) {
    try {
      await window.storeApi.vendors.updateLine(line.id, {
        status: 'dismissed',
      });
      await load();
    } catch (e) {
      setError(messageFrom(e));
    }
  }
  async function addLine() {
    if (!addProductId) return;
    try {
      await window.storeApi.vendors.addLine(addProductId, vendor.id, null);
      setAddProductId('');
      await load();
    } catch (e) {
      setError(messageFrom(e));
    }
  }

  return (
    <div className="vendor-detail">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <button type="button" onClick={onBack}>
          ← Vendors
        </button>
        <h2 style={{ margin: 0 }}>
          {vendor.name} <VendorBadge vendor={vendor} />
        </h2>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onEdit}>
          Edit vendor
        </button>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <p>
            {vendor.email ? (
              <>
                ✉ {vendor.email}
                {' · '}
              </>
            ) : null}
            {vendor.phone ? <>☎ {vendor.phone} · </> : null}
            {vendor.website ? <>{vendor.website} · </> : null}
            {vendor.accountNumber ? <>Acct # {vendor.accountNumber}</> : null}
            {!vendor.email && !vendor.phone && !vendor.website
              ? 'No contact details yet.'
              : null}
          </p>
          {vendor.address && <small>{vendor.address}</small>}
        </div>
      </div>

      <section className="toolbar">
        <strong>
          Suggested order: {lines.length} item{lines.length === 1 ? '' : 's'}
          {' · '}
          {formatMoney(total)}
          {unpriced > 0 && <small> (+{unpriced} without a price)</small>}
        </strong>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={addProductId}
            onChange={(e) => setAddProductId(e.target.value)}
          >
            <option value="">Add a product…</option>
            {addable.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!addProductId}
            onClick={() => void addLine()}
          >
            Add
          </button>
          <button
            type="button"
            className="primary"
            disabled={lines.length === 0}
            onClick={() => setOrdering(true)}
          >
            Order…
          </button>
        </div>
      </section>

      {lines.length === 0 ? (
        <div className="empty">
          <b>Nothing to order</b>
          <p>
            Products linked to {vendor.name} as their preferred vendor appear
            here automatically when stock reaches the low-stock alert.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Vendor SKU / barcode</th>
                <th style={{ textAlign: 'right' }}>In stock</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Unit cost</th>
                <th style={{ textAlign: 'right' }}>Line total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <strong>{line.productName}</strong>
                  </td>
                  <td>
                    <code>{line.vendorSku ?? line.barcode ?? '—'}</code>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {line.stockQuantity}
                    <small>alert at {line.lowStockThreshold}</small>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      style={{ width: 80, textAlign: 'right' }}
                      value={drafts[line.id] ?? String(line.quantity)}
                      onChange={(e) =>
                        setDrafts({ ...drafts, [line.id]: e.target.value })
                      }
                      onBlur={() => void commitQuantity(line)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitQuantity(line);
                        }
                      }}
                    />
                    {line.quantityOverride !== null && (
                      <small>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => {
                            setDrafts({ ...drafts, [line.id]: '' });
                            void window.storeApi.vendors
                              .updateLine(line.id, { quantityOverride: null })
                              .then(load)
                              .catch((e) => setError(messageFrom(e)));
                          }}
                        >
                          reset
                        </button>
                      </small>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {line.unitCostCents === null
                      ? '—'
                      : formatMoney(line.unitCostCents)}
                    {line.listPriceCents !== null &&
                      line.unitCostCents !== null &&
                      line.listPriceCents !== line.unitCostCents && (
                        <small>list {formatMoney(line.listPriceCents)}</small>
                      )}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                    {line.unitCostCents === null
                      ? '—'
                      : formatMoney(line.unitCostCents * line.quantity)}
                  </td>
                  <td>
                    <button type="button" onClick={() => void dismiss(line)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PurchaseOrderHistory
        orders={orders}
        onReceive={setReceivingId}
        onChanged={load}
        setError={setError}
      />

      {ordering && (
        <OrderModal
          vendor={vendor}
          lines={lines}
          storeName={storeName}
          onClose={() => {
            setOrdering(false);
            void load();
          }}
          onDone={() => {
            setOrdering(false);
            void load();
          }}
        />
      )}
      {receivingId && (
        <ReceiveModal
          orderId={receivingId}
          onClose={() => setReceivingId(null)}
          onDone={() => {
            setReceivingId(null);
            void load();
          }}
        />
      )}
      {editing !== undefined && (
        <VendorEditorModal
          vendor={editing}
          onClose={onEditClosed}
          onSaved={onEdited}
          setError={setError}
        />
      )}
    </div>
  );
}
