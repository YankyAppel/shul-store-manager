import { useEffect, useState } from 'react';
import {
  describeAttentionReason,
  describePrintResult,
  type NeedsAttentionCharge,
  type Product,
  type Sale,
} from '@shul-store/shared';
import { formatMoney, messageFrom } from '../utils/formatters';

export function SalesHistory({
  onViewCustomer,
}: {
  onViewCustomer?: ((customerId: string) => void) | undefined;
}) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [needsAttention, setNeedsAttention] = useState<NeedsAttentionCharge[]>(
    [],
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [kioskNames, setKioskNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Sale>();
  const [message, setMessage] = useState('');
  const [busyReference, setBusyReference] = useState('');
  const [checking, setChecking] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function refreshData() {
    try {
      const [nextSales, nextAttention, pending, products, kioskSettings] =
        await Promise.all([
          window.storeApi.sales.list(),
          window.storeApi.payments.listNeedsAttention(),
          window.storeApi.payments.getPendingTransactions(),
          window.storeApi.products.list(true),
          window.storeApi.kiosk.getSettings(),
        ]);
      setSales(nextSales);
      setNeedsAttention(nextAttention);
      setPendingCount(pending.length);
      setProductNames(
        Object.fromEntries(
          (products as Product[]).map((product) => [product.id, product.name]),
        ),
      );
      setKioskNames(
        Object.fromEntries(
          kioskSettings.kiosks.map((kiosk) => [kiosk.id, kiosk.name]),
        ),
      );
    } catch (reason) {
      setMessage(messageFrom(reason));
    }
  }

  useEffect(() => {
    void refreshData();
  }, []);

  async function print(sale: Sale) {
    try {
      const result = await window.storeApi.sales.print(sale.id);
      setMessage(
        result.success
          ? describePrintResult(result, 'Receipt')
          : `Printing failed; the sale is unchanged. ${result.error ?? ''}`,
      );
    } catch (reason) {
      setMessage(messageFrom(reason));
    }
  }

  async function resolveAttention(
    charge: NeedsAttentionCharge,
    action: 'retry' | 'void',
  ) {
    const note = notes[charge.chargeReference]?.trim() || undefined;
    if (
      action === 'void' &&
      !window.confirm(
        'Void this charge? This releases the held stock but does not refund the customer’s card. Any refund must be handled by a person at the payment terminal.',
      )
    )
      return;
    setMessage('');
    setBusyReference(charge.chargeReference);
    try {
      await window.storeApi.payments.resolveNeedsAttention(
        charge.chargeReference,
        action,
        note,
      );
      await refreshData();
    } catch (reason) {
      setMessage(messageFrom(reason));
    } finally {
      setBusyReference('');
    }
  }

  async function checkPending() {
    setChecking(true);
    setMessage('');
    try {
      await window.storeApi.payments.reconcileTransactions();
      await refreshData();
    } catch (reason) {
      setMessage(messageFrom(reason));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="sales-history">
      {message && <div className="alert">{message}</div>}
      {(needsAttention.length > 0 || pendingCount > 0) && (
        <section className="attention-panel">
          <div className="attention-header">
            <div>
              <h2>Card charges needing attention</h2>
              <p>
                Held stock stays reserved until each charge is retried or
                voided.
              </p>
            </div>
            {pendingCount > 0 && (
              <div className="pending-status">
                <strong>{pendingCount}</strong> pending charge
                {pendingCount === 1 ? '' : 's'}
                <button
                  type="button"
                  disabled={checking}
                  onClick={() => void checkPending()}
                >
                  {checking ? 'Checking…' : 'Check now'}
                </button>
              </div>
            )}
          </div>
          {needsAttention.map((charge) => {
            const origin =
              charge.originChannel === 'kiosk'
                ? `Kiosk: ${charge.kioskName ?? charge.kioskId ?? 'Unknown kiosk'}`
                : 'Manager';
            const heldItems = charge.reservations.filter(
              (reservation) => reservation.status === 'held',
            );
            return (
              <article
                className="attention-charge"
                key={charge.chargeReference}
              >
                <div className="attention-charge-header">
                  <div>
                    <strong>{formatMoney(charge.totalCents)}</strong>
                    <span>
                      {new Date(charge.createdAt).toLocaleString()} · {origin}
                    </span>
                  </div>
                  <span className="badge badge-charge">Needs attention</span>
                </div>
                <p>{describeAttentionReason(charge.attentionReason)}</p>
                <div className="held-items">
                  <strong>Held inventory:</strong>
                  {heldItems.length > 0 ? (
                    <ul>
                      {heldItems.map((reservation) => (
                        <li key={reservation.productId}>
                          {productNames[reservation.productId] ??
                            reservation.productId}{' '}
                          × {reservation.quantity}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span> No held item rows reported.</span>
                  )}
                </div>
                <label>
                  Operator note (optional)
                  <textarea
                    rows={2}
                    maxLength={400}
                    value={notes[charge.chargeReference] ?? ''}
                    onChange={(event) =>
                      setNotes({
                        ...notes,
                        [charge.chargeReference]: event.target.value,
                      })
                    }
                  />
                </label>
                <div className="attention-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busyReference !== ''}
                    onClick={() => void resolveAttention(charge, 'retry')}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    disabled={busyReference !== ''}
                    onClick={() => void resolveAttention(charge, 'void')}
                  >
                    Void and release held stock
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Channel</th>
              <th>Total</th>
              <th>Payment Tender</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sales.map((sale) => {
              const isAccount = sale.payment.method === 'account';
              return (
                <tr key={sale.id}>
                  <td>#{sale.receiptNumber}</td>
                  <td>
                    {new Date(
                      sale.completedAt ?? sale.createdAt,
                    ).toLocaleString()}
                  </td>
                  <td>
                    {sale.channel === 'kiosk'
                      ? `Kiosk: ${
                          (sale.kioskId && kioskNames[sale.kioskId]) ??
                          sale.kioskId ??
                          'Unknown kiosk'
                        }`
                      : 'Manager'}
                  </td>
                  <td>
                    {isAccount ? (
                      <div>
                        <strong>{sale.payment.customerName}</strong>
                        <small>Acct #{sale.payment.accountNumber}</small>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{formatMoney(sale.totalCents)}</td>
                  <td>
                    {sale.payment.method === 'cash'
                      ? 'Cash'
                      : sale.payment.method === 'external_terminal'
                        ? 'External terminal'
                        : 'Charged to Account'}
                  </td>
                  <td>
                    <span className="badge badge-active">{sale.status}</span>
                  </td>
                  <td>
                    <button type="button" onClick={() => setSelected(sale)}>
                      Details
                    </button>{' '}
                    <button type="button" onClick={() => void print(sale)}>
                      Reprint
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="sale-details">
          <button type="button" onClick={() => setSelected(undefined)}>
            ×
          </button>
          <h3>Sale #{selected.receiptNumber}</h3>
          <p style={{ fontSize: '12px', color: '#666' }}>
            {new Date(
              selected.completedAt ?? selected.createdAt,
            ).toLocaleString()}
          </p>

          {selected.payment.method === 'account' && (
            <div
              style={{
                background: '#f8f9fa',
                padding: '10px',
                borderRadius: '6px',
                margin: '10px 0',
              }}
            >
              <div>
                <strong>Customer:</strong> {selected.payment.customerName}
              </div>
              <div>
                <strong>Account #:</strong> {selected.payment.accountNumber}
              </div>
              {selected.payment.customerId && onViewCustomer && (
                <button
                  type="button"
                  style={{
                    marginTop: '6px',
                    fontSize: '12px',
                    padding: '4px 8px',
                  }}
                  onClick={() => onViewCustomer(selected.payment.customerId!)}
                >
                  View customer account →
                </button>
              )}
            </div>
          )}

          <div style={{ margin: '10px 0' }}>
            {selected.items.map((item) => (
              <p key={item.id} style={{ margin: '4px 0' }}>
                <span>
                  {item.productName} × {item.quantity}
                </span>
                <b>{formatMoney(item.lineTotalCents)}</b>
              </p>
            ))}
          </div>

          <hr />
          <p>
            <span>Subtotal</span>
            <b>{formatMoney(selected.subtotalCents)}</b>
          </p>
          <p>
            <span>Tax</span>
            <b>{formatMoney(selected.taxCents)}</b>
          </p>
          <p style={{ fontSize: '16px', fontWeight: 'bold' }}>
            <span>Total</span>
            <b>{formatMoney(selected.totalCents)}</b>
          </p>

          <div
            style={{
              borderTop: '1px dashed #ccc',
              paddingTop: '8px',
              marginTop: '8px',
              fontSize: '13px',
            }}
          >
            {selected.payment.method === 'cash' ? (
              <div>
                Cash:{' '}
                {formatMoney(
                  selected.payment.cashReceivedCents ?? selected.totalCents,
                )}{' '}
                (Change: {formatMoney(selected.payment.changeDueCents ?? 0)})
              </div>
            ) : selected.payment.method === 'external_terminal' ? (
              <div>
                External terminal{' '}
                {selected.payment.terminalReference
                  ? `(Ref: ${selected.payment.terminalReference})`
                  : ''}
              </div>
            ) : (
              <div>
                <div>
                  <strong>Charged to Account</strong>
                </div>
                <div>
                  Previous balance:{' '}
                  {formatMoney(selected.payment.previousBalanceCents ?? 0)}
                </div>
                <div>
                  New balance:{' '}
                  {formatMoney(
                    selected.payment.newBalanceCents ??
                      (selected.payment.previousBalanceCents ?? 0) +
                        selected.totalCents,
                  )}
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: '14px', display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="primary"
              style={{ flex: 1 }}
              onClick={() => void print(selected)}
            >
              Reprint receipt
            </button>
          </div>
          <small style={{ display: 'block', marginTop: '10px', color: '#777' }}>
            Completed records are immutable.
          </small>
        </div>
      )}
    </div>
  );
}
