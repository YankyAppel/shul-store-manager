import { useEffect, useState } from 'react';
import type { Sale } from '@shul-store/shared';
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export function SalesHistory() {
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
              <th>Total</th>
              <th>Payment</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sales.map((sale) => (
              <tr key={sale.id}>
                <td>#{sale.receiptNumber}</td>
                <td>
                  {new Date(
                    sale.completedAt ?? sale.createdAt,
                  ).toLocaleString()}
                </td>
                <td>{money(sale.totalCents)}</td>
                <td>
                  {sale.payment.method === 'cash'
                    ? 'Cash'
                    : 'External terminal'}
                </td>
                <td>{sale.status}</td>
                <td>
                  <button onClick={() => setSelected(sale)}>Details</button>{' '}
                  <button onClick={() => void print(sale)}>Reprint</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <div className="sale-details">
          <button onClick={() => setSelected(undefined)}>×</button>
          <h3>Sale #{selected.receiptNumber}</h3>
          {selected.items.map((item) => (
            <p key={item.id}>
              <span>
                {item.productName} × {item.quantity}
              </span>
              <b>{money(item.lineTotalCents)}</b>
            </p>
          ))}
          <hr />
          <p>
            <span>Total</span>
            <b>{money(selected.totalCents)}</b>
          </p>
          <small>
            Completed records are immutable. Refunds are not available in this
            milestone.
          </small>
        </div>
      )}
    </div>
  );
}
