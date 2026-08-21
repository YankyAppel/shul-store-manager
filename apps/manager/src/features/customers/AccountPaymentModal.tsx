import { useState, type FormEvent } from 'react';
import type {
  AccountPayment,
  Customer,
  StoreSettings,
} from '@shul-store/shared';
import { calculateCashChange, parseUsdToCents } from '@shul-store/shared';
import { formatMoney, messageFrom } from '../../utils/formatters';

export function AccountPaymentModal({
  customer,
  settings,
  onClose,
  onPaymentCompleted,
  setError,
}: {
  customer: Customer;
  settings: StoreSettings;
  onClose(): void;
  onPaymentCompleted(payment: AccountPayment): void;
  setError(value: string): void;
}) {
  const [method, setMethod] = useState<'cash' | 'external_terminal'>('cash');
  const [amountStr, setAmountStr] = useState(
    customer.currentBalanceCents > 0
      ? (customer.currentBalanceCents / 100).toFixed(2)
      : '0.00',
  );
  const [cashReceivedStr, setCashReceivedStr] = useState(
    customer.currentBalanceCents > 0
      ? (customer.currentBalanceCents / 100).toFixed(2)
      : '0.00',
  );
  const [approved, setApproved] = useState(false);
  const [terminalRef, setTerminalRef] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  let parsedAmountCents: number | null = null;
  let parsedCashReceivedCents: number | null = null;
  try {
    parsedAmountCents = parseUsdToCents(amountStr);
  } catch {
    parsedAmountCents = null;
  }
  try {
    parsedCashReceivedCents = parseUsdToCents(cashReceivedStr);
  } catch {
    parsedCashReceivedCents = null;
  }

  const changeDueCents =
    parsedAmountCents !== null &&
    parsedCashReceivedCents !== null &&
    parsedCashReceivedCents >= parsedAmountCents
      ? calculateCashChange(parsedAmountCents, parsedCashReceivedCents)
      : 0;

  const willResultInCredit =
    parsedAmountCents !== null &&
    parsedAmountCents > customer.currentBalanceCents;

  const overpaymentBlocked =
    willResultInCredit && !settings.allowCustomerCredit;

  const valid =
    parsedAmountCents !== null &&
    parsedAmountCents > 0 &&
    !overpaymentBlocked &&
    (method === 'cash'
      ? parsedCashReceivedCents !== null &&
        parsedCashReceivedCents >= parsedAmountCents
      : approved);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || parsedAmountCents === null) return;
    setSaving(true);
    try {
      const input = {
        operationId: crypto.randomUUID(),
        customerId: customer.id,
        amountCents: parsedAmountCents,
        payment:
          method === 'cash'
            ? {
                method: 'cash' as const,
                cashReceivedCents: parsedCashReceivedCents!,
              }
            : {
                method: 'external_terminal' as const,
                approved: true as const,
                terminalReference: terminalRef.trim() || null,
              },
        notes: notes.trim() || null,
      };

      const result = await window.storeApi.accountPayments.record(input);
      onPaymentCompleted(result);
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
          <h2>Record account payment</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="stock-summary">
            <div>
              <small>Customer</small>
              <b>{customer.name}</b>
              <span style={{ fontSize: '12px', color: '#666' }}>
                Account #{customer.accountNumber}
              </span>
            </div>
            <div>
              <small>Current amount owed</small>
              <b
                style={{
                  color:
                    customer.currentBalanceCents > 0 ? '#87352a' : '#1e684a',
                }}
              >
                {customer.currentBalanceCents > 0
                  ? formatMoney(customer.currentBalanceCents)
                  : customer.currentBalanceCents < 0
                    ? `Credit: ${formatMoney(Math.abs(customer.currentBalanceCents))}`
                    : '$0.00'}
              </b>
            </div>
          </div>

          <label>
            Payment method
            <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
              <button
                type="button"
                className={method === 'cash' ? 'primary' : ''}
                style={{ flex: 1 }}
                onClick={() => setMethod('cash')}
              >
                Cash
              </button>
              <button
                type="button"
                className={method === 'external_terminal' ? 'primary' : ''}
                style={{ flex: 1 }}
                onClick={() => setMethod('external_terminal')}
              >
                External terminal
              </button>
            </div>
          </label>

          <label>
            Payment amount ($)
            <input
              autoFocus
              type="number"
              min="0.01"
              step="0.01"
              required
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
            />
          </label>

          {overpaymentBlocked && (
            <div className="alert" style={{ margin: '0' }}>
              Payment exceeds current amount owed, and customer credit is
              disabled in settings.
            </div>
          )}

          {method === 'cash' ? (
            <div
              className="pay-box"
              style={{
                margin: 0,
                padding: '12px',
                background: '#fafafa',
                borderRadius: '8px',
              }}
            >
              <label>
                Cash received ($)
                <input
                  type="number"
                  min={parsedAmountCents ? parsedAmountCents / 100 : 0.01}
                  step="0.01"
                  required
                  value={cashReceivedStr}
                  onChange={(e) => setCashReceivedStr(e.target.value)}
                />
              </label>
              <p
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  margin: '8px 0 0 0',
                }}
              >
                <span>Change due:</span>
                <b>{formatMoney(changeDueCents)}</b>
              </p>
            </div>
          ) : (
            <div
              className="pay-box"
              style={{
                margin: 0,
                padding: '12px',
                background: '#fafafa',
                borderRadius: '8px',
              }}
            >
              <p style={{ margin: '0 0 10px 0', fontSize: '13px' }}>
                Process exactly <b>{formatMoney(parsedAmountCents ?? 0)}</b> on
                the separate card terminal.
              </p>
              <label>
                Terminal reference <em>Optional</em>
                <input
                  value={terminalRef}
                  onChange={(e) => setTerminalRef(e.target.value)}
                  placeholder="e.g. Approval code or receipt ID"
                />
              </label>
              <label className="toggle" style={{ marginTop: '8px' }}>
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />{' '}
                I confirm the terminal approved this payment
              </label>
            </div>
          )}

          <label>
            Payment notes <em>Optional</em>
            <input
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Paid in office / check details"
            />
          </label>

          {parsedAmountCents !== null && (
            <div className="new-total">
              Resulting balance after payment:{' '}
              <b>
                {customer.currentBalanceCents - parsedAmountCents > 0
                  ? `Amount owed: ${formatMoney(customer.currentBalanceCents - parsedAmountCents)}`
                  : customer.currentBalanceCents - parsedAmountCents < 0
                    ? `Customer credit: ${formatMoney(Math.abs(customer.currentBalanceCents - parsedAmountCents))}`
                    : 'Settled ($0.00)'}
              </b>
            </div>
          )}

          <footer>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={saving || !valid}>
              {saving ? 'Processing…' : 'Record payment'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
