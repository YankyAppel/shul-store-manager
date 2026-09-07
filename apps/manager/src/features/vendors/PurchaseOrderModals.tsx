import { useEffect, useState } from 'react';
import type {
  BuyingListLine,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  VendorSummary,
} from '@shul-store/shared';
import { formatMoney, messageFrom } from '../../utils/formatters';

export const PO_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  sent: 'Ordered',
  partially_received: 'Partially received',
  received: 'Received',
  cancelled: 'Cancelled',
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Review the suggested lines → create a draft PO → preview the email → send
 * through the seller's own mail account (queued if offline) or mark as
 * ordered when the order is placed by phone / vendor website.
 */
export function OrderModal({
  vendor,
  lines,
  storeName,
  onClose,
  onDone,
}: {
  vendor: VendorSummary;
  lines: BuyingListLine[];
  storeName: string;
  onClose(): void;
  onDone(): void;
}) {
  const [subject, setSubject] = useState(
    `Purchase order from ${storeName || 'our store'}`,
  );
  const [message, setMessage] = useState(
    'Hello,\n\nPlease find our order below. Let us know if anything is out of stock or if prices have changed.\n\nThank you.',
  );
  const [notes, setNotes] = useState('');
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [preview, setPreview] = useState<{
    html: string;
    text: string;
    to: string | null;
  } | null>(null);
  const [emailReady, setEmailReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    window.storeApi.email
      .status()
      .then((status) => setEmailReady(status.configured))
      .catch(() => setEmailReady(false));
  }, []);

  const total = lines.reduce(
    (sum, line) => sum + (line.unitCostCents ?? 0) * line.quantity,
    0,
  );

  async function createDraft() {
    setBusy(true);
    setError('');
    try {
      const created = await window.storeApi.purchaseOrders.create({
        vendorId: vendor.id,
        subject,
        message,
        notes,
        lines: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unitCostCents: line.unitCostCents,
        })),
      });
      setOrder(created);
      setPreview(await window.storeApi.purchaseOrders.preview(created.id));
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setBusy(false);
    }
  }

  async function send(via: 'email' | 'manual') {
    if (!order) return;
    setBusy(true);
    setError('');
    try {
      await window.storeApi.purchaseOrders.send(order.id, via);
      onDone();
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setBusy(false);
    }
  }

  async function discardDraft() {
    if (order) {
      try {
        await window.storeApi.purchaseOrders.cancel(order.id);
      } catch (e) {
        setError(messageFrom(e));
        return;
      }
    }
    onClose();
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && void discardDraft()}
    >
      <div className="modal modal-wide">
        <div className="modal-title">
          <h2>
            {order ? `Order ${order.number}` : 'New order'} · {vendor.name}
          </h2>
          <button type="button" onClick={() => void discardDraft()}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="alert">
              <span>{error}</span>
            </div>
          )}
          {!order ? (
            <>
              <p className="hint">
                {lines.length} item{lines.length === 1 ? '' : 's'} ·{' '}
                {formatMoney(total)} estimated. Adjust quantities in the list
                before ordering.
              </p>
              <div className="form-grid">
                <label>
                  Email subject
                  <input
                    maxLength={200}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  Message to the vendor
                  <textarea
                    rows={5}
                    maxLength={5000}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  Internal notes <em>Not sent to the vendor</em>
                  <input
                    maxLength={2000}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || lines.length === 0 || !subject.trim()}
                  onClick={() => void createDraft()}
                >
                  {busy ? 'Preparing…' : 'Preview order →'}
                </button>
              </div>
            </>
          ) : (
            <>
              {preview && (
                <div className="email-preview">
                  <div className="email-preview-header">
                    <span>
                      <b>To:</b> {preview.to ?? <em>no vendor email</em>}
                    </span>
                    <span>
                      <b>Subject:</b> {order.subject}
                    </span>
                  </div>
                  <iframe
                    title="Email preview"
                    sandbox=""
                    srcDoc={preview.html}
                    style={{
                      width: '100%',
                      height: 420,
                      border: '1px solid var(--border, #ddd)',
                      background: '#fff',
                    }}
                  />
                </div>
              )}
              {emailReady === false && (
                <p className="hint">
                  No email account is set up yet. Add your SMTP account under
                  Settings → Email to send orders from the app, or mark the
                  order as placed if you order by phone or on the vendor's
                  website.
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => void discardDraft()}
                  disabled={busy}
                >
                  Discard draft
                </button>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send('manual')}
                  title="Use this when you order by phone, text, or on the vendor's site"
                >
                  Mark as ordered (sent elsewhere)
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !preview?.to || emailReady !== true}
                  onClick={() => void send('email')}
                >
                  {busy ? 'Sending…' : 'Send email'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Enter what actually arrived; partial deliveries keep the PO open. */
export function ReceiveModal({
  orderId,
  onClose,
  onDone,
}: {
  orderId: string;
  onClose(): void;
  onDone(): void;
}) {
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    window.storeApi.purchaseOrders
      .get(orderId)
      .then((value) => {
        setOrder(value);
        setQuantities(
          Object.fromEntries(
            value.lines.map((line) => [
              line.id,
              String(line.quantity - line.receivedQuantity),
            ]),
          ),
        );
      })
      .catch((e) => setError(messageFrom(e)));
  }, [orderId]);

  async function submit() {
    if (!order) return;
    const lines: { lineId: string; quantity: number }[] = [];
    for (const line of order.lines) {
      const raw = quantities[line.id]?.trim() ?? '';
      const value = raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        setError(`Enter a whole number for ${line.productName}.`);
        return;
      }
      if (value > 0) lines.push({ lineId: line.id, quantity: value });
    }
    if (lines.length === 0) {
      setError('Enter the quantity received for at least one item.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await window.storeApi.purchaseOrders.receive(order.id, {
        lines,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onDone();
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal modal-wide">
        <div className="modal-title">
          <h2>Receive {order?.number ?? ''}</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="alert">
              <span>{error}</span>
            </div>
          )}
          {order && (
            <>
              <p className="hint">
                Received quantities are added to stock right away. Leave a line
                at 0 if it hasn't arrived yet — the order stays open until
                everything is in.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th style={{ textAlign: 'right' }}>Ordered</th>
                      <th style={{ textAlign: 'right' }}>Already received</th>
                      <th style={{ textAlign: 'right' }}>Receiving now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.lines.map((line) => {
                      const remaining = line.quantity - line.receivedQuantity;
                      return (
                        <tr key={line.id}>
                          <td>
                            <strong>{line.productName}</strong>
                            <small>
                              {line.vendorSku ?? line.barcode ?? ''}
                            </small>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {line.quantity}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {line.receivedQuantity}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              style={{ width: 90, textAlign: 'right' }}
                              value={quantities[line.id] ?? String(remaining)}
                              onChange={(e) =>
                                setQuantities({
                                  ...quantities,
                                  [line.id]: e.target.value,
                                })
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <label style={{ display: 'block', marginTop: 12 }}>
                Note <em>Optional, e.g. damaged box, backorder</em>
                <input
                  maxLength={1000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  {busy ? 'Saving…' : 'Add to stock'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function PurchaseOrderHistory({
  orders,
  onReceive,
  onChanged,
  setError,
}: {
  orders: PurchaseOrderSummary[];
  onReceive(orderId: string): void;
  onChanged(): Promise<void>;
  setError(value: string): void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrder | null>(null);

  useEffect(() => {
    if (!expanded) {
      setDetail(null);
      return;
    }
    window.storeApi.purchaseOrders
      .get(expanded)
      .then(setDetail)
      .catch((e) => setError(messageFrom(e)));
  }, [expanded, orders]);

  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setBusyId(null);
    }
  }

  if (orders.length === 0) return null;
  return (
    <section style={{ marginTop: 24 }}>
      <h3>Orders</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Status</th>
              <th>Placed</th>
              <th style={{ textAlign: 'right' }}>Items</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const open =
                order.status === 'sent' ||
                order.status === 'partially_received';
              const isExpanded = expanded === order.id;
              return (
                <>
                  <tr key={order.id}>
                    <td>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() =>
                          setExpanded(isExpanded ? null : order.id)
                        }
                      >
                        <strong>{order.number}</strong>
                      </button>
                    </td>
                    <td>
                      <span className={`po-status po-status-${order.status}`}>
                        {PO_STATUS_LABEL[order.status]}
                      </span>
                      {order.emailStatus === 'pending' && (
                        <small>Email waiting to send (offline?)</small>
                      )}
                      {order.emailStatus === 'sent' && <small>Emailed</small>}
                      {order.emailStatus === 'failed' && (
                        <small style={{ color: 'var(--danger, #b00020)' }}>
                          Email failed: {order.emailError}
                        </small>
                      )}
                    </td>
                    <td>{formatDateTime(order.sentAt ?? order.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {order.unitCount}
                      {order.receivedUnitCount > 0 &&
                        order.status !== 'received' && (
                          <small>{order.receivedUnitCount} received</small>
                        )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(order.totalCents)}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {open && (
                          <button
                            type="button"
                            className="primary"
                            disabled={busyId === order.id}
                            onClick={() => onReceive(order.id)}
                          >
                            Receive…
                          </button>
                        )}
                        {order.emailStatus === 'failed' && (
                          <button
                            type="button"
                            disabled={busyId === order.id}
                            onClick={() =>
                              void act(order.id, () =>
                                window.storeApi.purchaseOrders.retryEmail(
                                  order.id,
                                ),
                              )
                            }
                          >
                            Retry email
                          </button>
                        )}
                        {(order.status === 'draft' ||
                          order.status === 'sent') && (
                          <button
                            type="button"
                            disabled={busyId === order.id}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Cancel order ${order.number}? Its items go back to the suggested list.`,
                                )
                              )
                                void act(order.id, () =>
                                  window.storeApi.purchaseOrders.cancel(
                                    order.id,
                                  ),
                                );
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {isExpanded && detail && (
                    <tr key={`${order.id}-detail`} className="po-detail-row">
                      <td colSpan={6}>
                        <table className="po-detail">
                          <tbody>
                            {detail.lines.map((line) => (
                              <tr key={line.id}>
                                <td>{line.productName}</td>
                                <td>
                                  <code>
                                    {line.vendorSku ?? line.barcode ?? ''}
                                  </code>
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  {line.receivedQuantity}/{line.quantity}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  {line.unitCostCents === null
                                    ? '—'
                                    : formatMoney(line.unitCostCents)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {detail.notes && <small>Notes: {detail.notes}</small>}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
