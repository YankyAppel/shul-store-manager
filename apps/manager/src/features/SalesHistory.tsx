import { useEffect, useState } from 'react';
import {
  calculateRefund,
  describeAttentionReason,
  describePrintResult,
  extractAttentionDetail,
  type NeedsAttentionCharge,
  type RefundIntentAttention,
  type RefundableSale,
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
  const [refundAttention, setRefundAttention] = useState<
    RefundIntentAttention[]
  >([]);
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [kioskNames, setKioskNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Sale>();
  const [message, setMessage] = useState('');
  const [scanValue, setScanValue] = useState('');
  const [accountPaymentCustomer, setAccountPaymentCustomer] = useState<{
    customerId: string;
    customerName: string;
    receiptNumber: number;
  } | null>(null);
  const [busyReference, setBusyReference] = useState('');
  const [checking, setChecking] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [refundable, setRefundable] = useState<RefundableSale>();
  const [refundQuantities, setRefundQuantities] = useState<
    Record<string, number>
  >({});
  const [refundRestocked, setRefundRestocked] = useState<
    Record<string, boolean>
  >({});
  const [refundReason, setRefundReason] = useState('');
  const [refundTerminalReference, setRefundTerminalReference] = useState('');
  const [refundFallback, setRefundFallback] = useState(false);
  const [refundError, setRefundError] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);

  async function loadRefundable(sale: Sale) {
    try {
      const value = await window.storeApi.refunds.refundable(sale.id);
      setRefundable(value);
      setRefundQuantities({});
      setRefundRestocked(
        Object.fromEntries(value.items.map((item) => [item.id, true])),
      );
      setRefundReason('');
      setRefundTerminalReference('');
      setRefundFallback(false);
      setRefundError('');
    } catch (reason) {
      setRefundError(messageFrom(reason));
    }
  }

  function refundCalculation() {
    if (!refundable) return null;
    const lines = refundable.items
      .filter((item) => (refundQuantities[item.id] ?? 0) > 0)
      .map((item) => ({
        saleItemId: item.id,
        productName: item.productName,
        soldQuantity: item.quantity,
        saleLineSubtotalCents: item.lineSubtotalCents,
        saleLineTaxCents: item.taxCents,
        saleLineTotalCents: item.lineTotalCents,
        refundedQuantity: item.refundedQuantity,
        subtotalAlreadyRefundedCents: item.subtotalRefundedCents,
        taxAlreadyRefundedCents: item.taxRefundedCents,
        quantity: refundQuantities[item.id] ?? 0,
        restocked: refundRestocked[item.id] ?? true,
      }));
    return lines.length > 0 ? calculateRefund(lines) : null;
  }

  async function recordRefund() {
    if (!refundable) return;
    const calculation = refundCalculation();
    if (!calculation) {
      setRefundError('Select at least one item to return.');
      return;
    }
    if (!refundReason.trim()) {
      setRefundError('A reason is required for every refund.');
      return;
    }
    const needsTerminal =
      refundable.method === 'external_terminal' ||
      (refundable.method === 'integrated_card' && refundFallback);
    if (needsTerminal && !refundTerminalReference.trim()) {
      setRefundError('Enter the physical terminal reference.');
      return;
    }
    if (
      !window.confirm(
        `Refund ${formatMoney(calculation.amountCents)} via ${
          refundFallback ? 'external terminal' : refundable.method
        }?`,
      )
    )
      return;
    setRefundBusy(true);
    setRefundError('');
    try {
      await window.storeApi.refunds.record({
        operationId: crypto.randomUUID(),
        saleId: refundable.sale.id,
        items: refundable.items
          .filter((item) => (refundQuantities[item.id] ?? 0) > 0)
          .map((item) => ({
            saleItemId: item.id,
            quantity: refundQuantities[item.id] ?? 0,
            restocked: refundRestocked[item.id] ?? true,
          })),
        reason: refundReason.trim(),
        terminalReference: refundTerminalReference.trim() || null,
        manualExternalTerminal: refundFallback,
      });
      setMessage('Refund recorded successfully.');
      await refreshData();
      const updated = await window.storeApi.sales.get(refundable.sale.id);
      setSelected(updated);
      await loadRefundable(updated);
    } catch (reason) {
      const detail = messageFrom(reason);
      setRefundError(detail);
      setMessage(detail);
      if (
        refundable.method === 'integrated_card' &&
        !refundFallback &&
        /physical terminal|refund failed|processor/i.test(detail)
      )
        setRefundFallback(true);
    } finally {
      setRefundBusy(false);
    }
  }

  async function refreshData() {
    try {
      const [
        nextSales,
        nextAttention,
        pending,
        nextRefundAttention,
        products,
        kioskSettings,
      ] = await Promise.all([
        window.storeApi.sales.list(),
        window.storeApi.payments.listNeedsAttention(),
        window.storeApi.payments.getPendingTransactions(),
        window.storeApi.refunds.listAttention(),
        window.storeApi.products.list(true),
        window.storeApi.kiosk.getSettings(),
      ]);
      setSales(nextSales);
      setNeedsAttention(nextAttention);
      setPendingCount(pending.length);
      setRefundAttention(nextRefundAttention);
      setProductNames(
        Object.fromEntries(
          products.map((product) => [product.id, product.name]),
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

  async function scanReceipt() {
    const scanned = scanValue.trim();
    if (!scanned) return;
    setScanValue('');
    setAccountPaymentCustomer(null);
    try {
      const result = await window.storeApi.sales.lookupReceiptBarcode(scanned);
      if (!result) {
        setMessage(`No receipt found for ${scanned}`);
        return;
      }
      if (result.kind === 'sale') {
        setMessage('');
        setSelected(result.sale);
        await loadRefundable(result.sale);
        return;
      }
      if (result.kind === 'refund') {
        setSelected(result.sale);
        await loadRefundable(result.sale);
        setMessage(`Refund #${result.refund.receiptNumber} of this sale`);
        return;
      }
      setSelected(undefined);
      setRefundable(undefined);
      setMessage(
        `Account payment #${result.payment.receiptNumber} for ${result.payment.customerName}`,
      );
      setAccountPaymentCustomer({
        customerId: result.customerId,
        customerName: result.payment.customerName,
        receiptNumber: result.payment.receiptNumber,
      });
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

  async function printRefund(refundId: string) {
    try {
      const result = await window.storeApi.refunds.print(refundId);
      setMessage(
        result.success
          ? describePrintResult(result, 'Refund receipt')
          : `Printing failed; the refund is unchanged. ${result.error ?? ''}`,
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

  async function resolveRefundAttention(operationId: string) {
    try {
      await window.storeApi.refunds.resolveAttention(operationId);
      setMessage('Refund attention refreshed.');
      await refreshData();
    } catch (reason) {
      setMessage(messageFrom(reason));
    }
  }

  return (
    <div className="sales-history">
      <div className="receipt-scan">
        <label htmlFor="receipt-scan-input">Scan receipt</label>
        <input
          id="receipt-scan-input"
          value={scanValue}
          autoFocus
          placeholder="Scan or type receipt barcode"
          onChange={(event) => setScanValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void scanReceipt();
          }}
        />
        {accountPaymentCustomer && onViewCustomer && (
          <button
            type="button"
            onClick={() => onViewCustomer(accountPaymentCustomer.customerId)}
          >
            Open {accountPaymentCustomer.customerName}
          </button>
        )}
      </div>
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
                {extractAttentionDetail(charge.attentionReason) && (
                  <small className="muted">
                    {extractAttentionDetail(charge.attentionReason)}
                  </small>
                )}
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
      {refundAttention.length > 0 && (
        <section className="attention-panel refund-attention-panel">
          <div className="attention-header">
            <div>
              <h2>Card refunds needing attention</h2>
              <p>
                A sent refund is never resent. Resolve it by checking the
                processor result.
              </p>
            </div>
          </div>
          {refundAttention.map((intent) => (
            <article className="attention-charge" key={intent.operationId}>
              <div className="attention-charge-header">
                <div>
                  <strong>{formatMoney(intent.amountCents)}</strong>
                  <span>
                    Updated {new Date(intent.updatedAt).toLocaleString()}
                  </span>
                </div>
                <span className="badge badge-charge">Needs attention</span>
              </div>
              <p>
                refund sent, result unknown — operation {intent.operationId}
              </p>
              {intent.attentionReason && (
                <small className="muted">{intent.attentionReason}</small>
              )}
              <div className="attention-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    void resolveRefundAttention(intent.operationId)
                  }
                >
                  Resolve status
                </button>
              </div>
            </article>
          ))}
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
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(sale);
                        void loadRefundable(sale);
                      }}
                    >
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
          <p className="sale-detail-date">
            {new Date(
              selected.completedAt ?? selected.createdAt,
            ).toLocaleString()}
          </p>

          {selected.payment.method === 'account' && (
            <div className="sale-customer-card">
              <div>
                <strong>Customer:</strong> {selected.payment.customerName}
              </div>
              <div>
                <strong>Account #:</strong> {selected.payment.accountNumber}
              </div>
              {selected.payment.customerId && onViewCustomer && (
                <button
                  type="button"
                  className="sale-customer-link"
                  onClick={() => onViewCustomer(selected.payment.customerId!)}
                >
                  View customer account →
                </button>
              )}
            </div>
          )}

          <div className="sale-detail-lines">
            {selected.items.map((item) => (
              <p key={item.id} className="sale-detail-line">
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
          <p className="sale-detail-total">
            <span>Total</span>
            <b>{formatMoney(selected.totalCents)}</b>
          </p>

          <div className="sale-payment-summary">
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

          {refundable && refundable.sale.id === selected.id && (
            <section className="refund-panel">
              <h4>Returns and refunds</h4>
              <p>
                Refund method:{' '}
                <strong>
                  {refundFallback ? 'external terminal' : refundable.method}
                </strong>
                {refundable.chargeReference && (
                  <> · Original charge: {refundable.chargeReference}</>
                )}
              </p>
              {refundError && <div className="alert">{refundError}</div>}
              {refundable.items.map((item) => (
                <div className="refund-line" key={item.id}>
                  <div className="refund-line-description">
                    <strong>{item.productName}</strong>
                    <small>
                      Sold {item.quantity} · Refunded {item.refundedQuantity} ·
                      Remaining {item.remainingQuantity}
                    </small>
                  </div>
                  <label>
                    Return quantity
                    <input
                      type="number"
                      min={0}
                      max={item.remainingQuantity}
                      value={refundQuantities[item.id] ?? 0}
                      onChange={(event) =>
                        setRefundQuantities({
                          ...refundQuantities,
                          [item.id]: Math.min(
                            item.remainingQuantity,
                            Math.max(0, Number(event.target.value) || 0),
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="refund-checkbox">
                    <input
                      type="checkbox"
                      checked={refundRestocked[item.id] ?? true}
                      onChange={(event) =>
                        setRefundRestocked({
                          ...refundRestocked,
                          [item.id]: event.target.checked,
                        })
                      }
                    />
                    Back to stock
                  </label>
                </div>
              ))}
              <label>
                Reason
                <textarea
                  rows={2}
                  value={refundReason}
                  onChange={(event) => setRefundReason(event.target.value)}
                  maxLength={1000}
                />
              </label>
              {(refundable.method === 'external_terminal' ||
                refundFallback) && (
                <label>
                  Physical terminal reference
                  <input
                    value={refundTerminalReference}
                    onChange={(event) =>
                      setRefundTerminalReference(event.target.value)
                    }
                    maxLength={100}
                  />
                </label>
              )}
              {refundFallback && (
                <p className="warning">
                  The processor refund did not complete. Confirm the physical
                  terminal refund before recording it here.
                </p>
              )}
              <div className="refund-total">
                Refund total:{' '}
                <strong>
                  {formatMoney(refundCalculation()?.amountCents ?? 0)}
                </strong>
              </div>
              <button
                type="button"
                className="primary"
                disabled={refundBusy}
                onClick={() => void recordRefund()}
              >
                {refundBusy ? 'Recording…' : 'Record refund'}
              </button>
              {refundable.refunds.length > 0 && (
                <div className="refund-history">
                  <h5>Previous refunds</h5>
                  {refundable.refunds.map((refund) => (
                    <div className="refund-history-row" key={refund.id}>
                      <span>
                        Refund #{refund.receiptNumber} ·{' '}
                        {new Date(refund.createdAt).toLocaleString()}
                      </span>
                      <span className="refund-history-amount">
                        <strong>{formatMoney(refund.amountCents)}</strong>
                        <button
                          type="button"
                          onClick={() => void printRefund(refund.id)}
                        >
                          Print
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <div className="sale-detail-actions">
            <button
              type="button"
              className="primary sale-detail-print"
              onClick={() => void print(selected)}
            >
              Reprint receipt
            </button>
          </div>
          <small className="sale-detail-note">
            Completed records are immutable.
          </small>
        </div>
      )}
    </div>
  );
}
