import { useEffect, useRef, useState } from 'react';
import type {
  Customer,
  CustomerStatementData,
  StatementDateRange,
  StatementOptions,
} from '@shul-store/shared';
import { formatMoney, messageFrom } from '../../utils/formatters';

export function CustomerStatementModal({
  customer,
  onClose,
  setError,
}: {
  customer: Customer;
  onClose(): void;
  setError(value: string): void;
}) {
  const [range, setRange] = useState<StatementDateRange>('last_30_days');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [statement, setStatement] = useState<CustomerStatementData | null>(
    null,
  );
  const [customError, setCustomError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printMessage, setPrintMessage] = useState('');

  const reqIdRef = useRef(0);

  useEffect(() => {
    const currentReqId = ++reqIdRef.current;
    setCustomError(null);

    let options: StatementOptions;

    if (range === 'custom') {
      if (!customStart && !customEnd) {
        setStatement(null);
        setLoading(false);
        return;
      }
      if (!customStart || !customEnd) {
        setCustomError('Please select both a start date and an end date.');
        setStatement(null);
        setLoading(false);
        return;
      }

      const startParts = customStart.split('-').map(Number);
      const endParts = customEnd.split('-').map(Number);

      if (startParts.length !== 3 || endParts.length !== 3) {
        setCustomError('Please enter valid calendar dates.');
        setStatement(null);
        setLoading(false);
        return;
      }

      const [sy, sm, sd] = startParts as [number, number, number];
      const [ey, em, ed] = endParts as [number, number, number];

      const startDateObj = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0));
      const endDateExclusiveObj = new Date(
        Date.UTC(ey, em - 1, ed + 1, 0, 0, 0, 0),
      );

      if (
        Number.isNaN(startDateObj.getTime()) ||
        Number.isNaN(endDateExclusiveObj.getTime())
      ) {
        setCustomError('Please enter valid calendar dates.');
        setStatement(null);
        setLoading(false);
        return;
      }

      if (customStart > customEnd) {
        setCustomError('Start date cannot be after end date.');
        setStatement(null);
        setLoading(false);
        return;
      }

      options = {
        range: 'custom',
        startDate: startDateObj.toISOString(),
        endDate: endDateExclusiveObj.toISOString(),
      };
    } else {
      options = { range };
    }

    async function loadStatement(fetchOptions: StatementOptions) {
      setLoading(true);
      setStatement(null);
      try {
        const data = await window.storeApi.customers.getStatement(
          customer.id,
          fetchOptions,
        );
        if (reqIdRef.current === currentReqId) {
          setStatement(data);
        }
      } catch (e) {
        if (reqIdRef.current === currentReqId) {
          setError(messageFrom(e));
        }
      } finally {
        if (reqIdRef.current === currentReqId) {
          setLoading(false);
        }
      }
    }

    void loadStatement(options);
  }, [customer.id, range, customStart, customEnd, setError]);

  async function handlePrint() {
    if (!statement) return;
    setPrinting(true);
    setPrintMessage('');
    try {
      const result = await window.storeApi.customers.printStatement(statement);
      if (result.success) {
        setPrintMessage('Statement sent to printer.');
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
      <div className="modal" style={{ width: '800px', maxWidth: '96vw' }}>
        <div className="modal-title">
          <h2>Customer statement: {customer.name}</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>

        <div style={{ padding: '22px' }}>
          <div
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
              marginBottom: '16px',
              flexWrap: 'wrap',
            }}
          >
            <label style={{ margin: 0 }}>
              Period:
              <select
                value={range}
                onChange={(e) => setRange(e.target.value as StatementDateRange)}
                style={{
                  width: 'auto',
                  display: 'inline-block',
                  marginLeft: '8px',
                }}
              >
                <option value="last_30_days">Last 30 days</option>
                <option value="last_90_days">Last 90 days</option>
                <option value="all_activity">All activity</option>
                <option value="custom">Custom date range</option>
              </select>
            </label>

            {range === 'custom' && (
              <div
                style={{ display: 'flex', gap: '8px', alignItems: 'center' }}
              >
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  style={{ margin: 0, padding: '6px' }}
                />
                <span>to</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  style={{ margin: 0, padding: '6px' }}
                />
              </div>
            )}

            <button
              type="button"
              className="primary"
              style={{ marginLeft: 'auto' }}
              disabled={loading || printing || !statement}
              onClick={() => void handlePrint()}
            >
              {printing ? 'Printing…' : 'Print statement'}
            </button>
          </div>

          {customError && (
            <div className="alert" style={{ marginBottom: '12px' }}>
              {customError}
            </div>
          )}

          {printMessage && (
            <div
              className={printMessage.includes('failed') ? 'alert' : 'success'}
              style={{ marginBottom: '12px' }}
            >
              {printMessage}
            </div>
          )}

          {loading ? (
            <p>Loading statement…</p>
          ) : !statement ? (
            <p style={{ color: '#666' }}>
              {range === 'custom' && (!customStart || !customEnd)
                ? 'Please select both start and end dates to generate a statement.'
                : 'No statement data available.'}
            </p>
          ) : (
            <div
              style={{
                border: '1px solid #e0e5e2',
                borderRadius: '8px',
                padding: '16px',
                background: '#fff',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid #eee',
                  paddingBottom: '12px',
                  marginBottom: '14px',
                }}
              >
                <div>
                  <h3 style={{ margin: 0 }}>{statement.settings.storeName}</h3>
                  <small style={{ color: '#666' }}>
                    Statement period: {statement.period.label}
                  </small>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <strong>{statement.customer.name}</strong>
                  <div style={{ fontSize: '12px', color: '#666' }}>
                    Account #{statement.customer.accountNumber}
                  </div>
                </div>
              </div>

              <div
                className="table-wrap"
                style={{ maxHeight: '320px', overflowY: 'auto' }}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Ref</th>
                      <th style={{ textAlign: 'right' }}>Charges</th>
                      <th style={{ textAlign: 'right' }}>Payments</th>
                      <th style={{ textAlign: 'right' }}>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ background: '#fafbfa', fontWeight: 'bold' }}>
                      <td colSpan={5}>Opening balance</td>
                      <td style={{ textAlign: 'right' }}>
                        {formatMoney(statement.openingBalanceCents)}
                      </td>
                    </tr>
                    {statement.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          {new Date(entry.occurredAt).toLocaleDateString()}
                        </td>
                        <td>{entry.notes}</td>
                        <td>
                          {entry.relatedSaleReceiptNumber
                            ? `#${entry.relatedSaleReceiptNumber}`
                            : entry.relatedPaymentReceiptNumber
                              ? `#P${entry.relatedPaymentReceiptNumber}`
                              : '—'}
                        </td>
                        <td
                          style={{
                            textAlign: 'right',
                            color: entry.chargeCents ? '#87352a' : 'inherit',
                          }}
                        >
                          {entry.chargeCents
                            ? formatMoney(entry.chargeCents)
                            : ''}
                        </td>
                        <td
                          style={{
                            textAlign: 'right',
                            color: entry.paymentCents ? '#1e684a' : 'inherit',
                          }}
                        >
                          {entry.paymentCents
                            ? formatMoney(entry.paymentCents)
                            : ''}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                          {formatMoney(entry.runningBalanceCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  marginTop: '16px',
                }}
              >
                <div
                  style={{
                    width: '280px',
                    background: '#f8f9fa',
                    padding: '12px',
                    borderRadius: '6px',
                    border: '1px solid #e0e5e2',
                    lineHeight: '1.6',
                  }}
                >
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between' }}
                  >
                    <span>Opening balance:</span>
                    <span>{formatMoney(statement.openingBalanceCents)}</span>
                  </div>
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between' }}
                  >
                    <span>Total charges:</span>
                    <span style={{ color: '#87352a' }}>
                      +{formatMoney(statement.totalChargesCents)}
                    </span>
                  </div>
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between' }}
                  >
                    <span>Total payments:</span>
                    <span style={{ color: '#1e684a' }}>
                      -{formatMoney(statement.totalPaymentsCents)}
                    </span>
                  </div>
                  <hr
                    style={{
                      margin: '6px 0',
                      border: 'none',
                      borderTop: '1px solid #ccc',
                    }}
                  />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontWeight: 'bold',
                      fontSize: '14px',
                    }}
                  >
                    <span>Closing balance:</span>
                    <span>
                      {statement.closingBalanceCents > 0
                        ? `Owed: ${formatMoney(statement.closingBalanceCents)}`
                        : statement.closingBalanceCents < 0
                          ? `Credit: ${formatMoney(Math.abs(statement.closingBalanceCents))}`
                          : '$0.00'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: '18px',
            }}
          >
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
