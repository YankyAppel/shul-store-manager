import type { CustomerLedgerEntry } from '@shul-store/shared';
import { formatMoney } from '../../utils/formatters';

const entryTypeLabels: Record<
  CustomerLedgerEntry['entryType'],
  { label: string; className: string }
> = {
  sale_charge: { label: 'Sale charge', className: 'badge-charge' },
  payment: { label: 'Payment', className: 'badge-payment' },
  manual_debit_adjustment: {
    label: 'Debit adjustment',
    className: 'badge-charge',
  },
  manual_credit_adjustment: {
    label: 'Credit adjustment',
    className: 'badge-payment',
  },
};

export function CustomerLedgerTable({
  entries,
  onViewSale,
  onViewPayment,
}: {
  entries: CustomerLedgerEntry[];
  onViewSale?: ((saleId: string) => void) | undefined;
  onViewPayment?: ((paymentId: string) => void) | undefined;
}) {
  if (entries.length === 0) {
    return (
      <div className="empty" style={{ padding: '30px' }}>
        <b>No ledger history</b>
        <p>This customer has no recorded sales or payments yet.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date & Time</th>
            <th>Type</th>
            <th>Description</th>
            <th>Reference</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th style={{ textAlign: 'right' }}>Resulting balance</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const isCharge = entry.amountCents > 0;
            const badge = entryTypeLabels[entry.entryType] || {
              label: entry.entryType,
              className: '',
            };

            return (
              <tr key={entry.id}>
                <td>{new Date(entry.occurredAt).toLocaleString()}</td>
                <td>
                  <span className={`badge ${badge.className}`}>
                    {badge.label}
                  </span>
                </td>
                <td>{entry.notes}</td>
                <td>
                  {entry.relatedSaleReceiptNumber && entry.relatedSaleId ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => onViewSale?.(entry.relatedSaleId!)}
                    >
                      Sale #{entry.relatedSaleReceiptNumber}
                    </button>
                  ) : entry.relatedPaymentReceiptNumber &&
                    entry.relatedAccountPaymentId ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() =>
                        onViewPayment?.(entry.relatedAccountPaymentId!)
                      }
                    >
                      Payment #{entry.relatedPaymentReceiptNumber}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    fontWeight: 'bold',
                    color: isCharge ? '#87352a' : '#1e684a',
                  }}
                >
                  {isCharge ? '+' : ''}
                  {formatMoney(entry.amountCents)}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                  {entry.resultingBalanceCents > 0
                    ? `Owed: ${formatMoney(entry.resultingBalanceCents)}`
                    : entry.resultingBalanceCents < 0
                      ? `Credit: ${formatMoney(Math.abs(entry.resultingBalanceCents))}`
                      : '$0.00'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
