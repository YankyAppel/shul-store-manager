import { useState } from 'react';
import type { AccountPayment } from '@shul-store/shared';
import { formatMoney } from '../../utils/formatters';

export function AccountPaymentReceiptModal({
  payment,
  onClose,
}: {
  payment: AccountPayment;
  onClose(): void;
}) {
  const [printMessage, setPrintMessage] = useState('');
  const [printing, setPrinting] = useState(false);

  async function handlePrint() {
    setPrinting(true);
    setPrintMessage('');
    try {
      const result = await window.storeApi.accountPayments.print(payment.id);
      if (result.success) {
        setPrintMessage('Receipt sent to printer.');
      } else {
        setPrintMessage(
          `Printing failed: ${result.error ?? 'Unknown printer error'}`,
        );
      }
    } catch (e) {
      setPrintMessage(e instanceof Error ? e.message : 'Printing failed');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ maxWidth: '460px' }}>
        <div className="modal-title">
          <h2>Payment Receipt #{payment.receiptNumber}</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div style={{ padding: '22px' }}>
          <div className="success">
            ✓ Payment of {formatMoney(payment.amountCents)} recorded
            successfully
          </div>

          {printMessage && (
            <div
              className={printMessage.includes('failed') ? 'alert' : 'success'}
            >
              {printMessage}
            </div>
          )}

          <div className="receipt">
            <h3 style={{ textAlign: 'center', margin: '0 0 4px 0' }}>
              Payment Receipt #{payment.receiptNumber}
            </h3>
            <p
              style={{
                textAlign: 'center',
                color: '#666',
                fontSize: '12px',
                margin: '0 0 14px 0',
              }}
            >
              {new Date(payment.createdAt).toLocaleString()}
            </p>

            <div
              style={{
                background: '#f8f9fa',
                padding: '10px',
                borderRadius: '6px',
                marginBottom: '12px',
              }}
            >
              <div>
                <strong>Customer:</strong> {payment.customerName}
              </div>
              <div>
                <strong>Account #:</strong> {payment.accountNumber}
              </div>
              {payment.notes && (
                <div>
                  <strong>Notes:</strong> {payment.notes}
                </div>
              )}
            </div>

            <p>
              <span>Previous balance</span>
              <b>{formatMoney(payment.previousBalanceCents)}</b>
            </p>
            <p style={{ color: '#1e684a', fontWeight: 'bold' }}>
              <span>Payment applied</span>
              <b>-{formatMoney(payment.amountCents)}</b>
            </p>
            <p>
              <span>Payment method</span>
              <span>
                {payment.method === 'cash'
                  ? `Cash (${formatMoney(payment.cashReceivedCents ?? payment.amountCents)}, change ${formatMoney(payment.changeDueCents ?? 0)})`
                  : `External terminal${payment.terminalReference ? ` (Ref: ${payment.terminalReference})` : ''}`}
              </span>
            </p>
            <hr />
            <p style={{ fontSize: '16px' }}>
              <span>New balance</span>
              <b>
                {payment.newBalanceCents > 0
                  ? `Amount owed: ${formatMoney(payment.newBalanceCents)}`
                  : payment.newBalanceCents < 0
                    ? `Customer credit: ${formatMoney(Math.abs(payment.newBalanceCents))}`
                    : 'Settled ($0.00)'}
              </b>
            </p>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
            <button
              type="button"
              className="primary"
              style={{ flex: 1 }}
              disabled={printing}
              onClick={() => void handlePrint()}
            >
              {printing ? 'Printing…' : 'Print receipt'}
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
