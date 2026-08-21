import { useEffect, useState } from 'react';
import type { Sale } from '@shul-store/shared';
import { formatMoney } from '../utils/formatters';

export function SalesHistory({
  onViewCustomer,
}: {
  onViewCustomer?: ((customerId: string) => void) | undefined;
}) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [selected, setSelected] = useState<Sale>();
  const [message, setMessage] = useState('');

  useEffect(() => {
    void window.storeApi.sales.list().then(setSales);
  }, []);

  async function print(sale: Sale) {
    const result = await window.storeApi.sales.print(sale.id);
    setMessage(
      result.success
        ? 'Receipt sent to the printer.'
        : `Printing failed; the sale is unchanged. ${result.error ?? ''}`,
    );
  }

  return (
    <div className="sales-history">
      {message && <div className="alert">{message}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Date</th>
              <th>Customer</th>
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
