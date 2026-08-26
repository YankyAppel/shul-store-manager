import { useCallback, useEffect, useState } from 'react';
import type { DailyClose, DailyReport } from '@shul-store/shared';
import { parseUsdToCents } from '@shul-store/shared';
import { formatMoney, messageFrom } from '../utils/formatters';

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function centsFromInput(value: string): number {
  try {
    return parseUsdToCents(value || '0');
  } catch {
    return 0;
  }
}

function cashPayments(report: DailyReport): number {
  return report.accountPayments
    .filter((payment) => payment.method === 'cash')
    .reduce((total, payment) => total + payment.amountCents, 0);
}

export function ReportsScreen() {
  const [businessDate, setBusinessDate] = useState(today);
  const [openingFloat, setOpeningFloat] = useState('0.00');
  const [countedCash, setCountedCash] = useState('0.00');
  const [report, setReport] = useState<DailyReport>();
  const [closes, setCloses] = useState<DailyClose[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [nextReport, nextCloses] = await Promise.all([
        window.storeApi.reports.daily(
          businessDate,
          centsFromInput(openingFloat),
        ),
        window.storeApi.reports.listCloses(20),
      ]);
      setReport(nextReport);
      setCloses(nextCloses);
      const close = nextCloses.find(
        (item) => item.businessDate === businessDate,
      );
      if (close) setCountedCash((close.countedCashCents / 100).toFixed(2));
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }, [businessDate, openingFloat]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const close = closes.find((item) => item.businessDate === businessDate);

  async function closeDay() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await window.storeApi.reports.close(
        businessDate,
        centsFromInput(openingFloat),
        centsFromInput(countedCash),
      );
      setCloses((current) => [
        saved,
        ...current.filter((item) => item.businessDate !== businessDate),
      ]);
      setMessage('Day closed and saved.');
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  async function print() {
    if (!displayReport) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.storeApi.reports.print(
        businessDate,
        displayReport,
      );
      if (!result.success) setError(result.error ?? 'Printing failed.');
      else setMessage('Report sent to the printer.');
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!report && !error) return <p>Loading…</p>;
  if (!report) return <div className="alert">{error}</div>;

  const displayReport = close?.report ?? report;
  const overShort = close
    ? close.overShortCents
    : centsFromInput(countedCash) - report.expectedCashCents;
  const overShortLabel =
    overShort < 0
      ? `Short ${formatMoney(Math.abs(overShort))}`
      : overShort > 0
        ? `Over ${formatMoney(overShort)}`
        : 'Even';

  return (
    <div className="reports-screen">
      {error && <div className="alert">{error}</div>}
      {message && <div className="reports-success">{message}</div>}
      <section className="reports-controls">
        <label>
          Business date
          <input
            type="date"
            value={businessDate}
            onChange={(event) => setBusinessDate(event.target.value)}
          />
        </label>
        <label>
          Opening float
          <input
            inputMode="decimal"
            value={openingFloat}
            onChange={(event) => setOpeningFloat(event.target.value)}
            disabled={Boolean(close)}
          />
        </label>
        <label>
          Counted cash
          <input
            inputMode="decimal"
            value={countedCash}
            onChange={(event) => setCountedCash(event.target.value)}
            disabled={Boolean(close)}
          />
        </label>
        <div className="reports-actions">
          <button type="button" onClick={() => void print()} disabled={busy}>
            Print
          </button>
          {!close && (
            <button
              className="primary"
              type="button"
              onClick={() => void closeDay()}
              disabled={busy}
            >
              Close day
            </button>
          )}
        </div>
      </section>

      {displayReport.unresolvedCard.count > 0 && (
        <div className="reports-warning">
          <strong>Unresolved card charges:</strong>{' '}
          {displayReport.unresolvedCard.count} charge(s),{' '}
          {formatMoney(displayReport.unresolvedCard.amountCents)}. Closing the
          day does not resolve them.
        </div>
      )}

      {close && (
        <div className="reports-closed">
          <strong>Day closed</strong> on{' '}
          {new Date(close.closedAt).toLocaleString()}. This close is immutable.
        </div>
      )}

      <div className="reports-grid">
        <section className="report-card">
          <h2>Sales</h2>
          <p>Sales: {displayReport.sales.saleCount}</p>
          <p>Subtotal: {formatMoney(displayReport.sales.subtotalCents)}</p>
          <p>Tax: {formatMoney(displayReport.sales.taxCents)}</p>
          <p className="report-total">
            Total: {formatMoney(displayReport.sales.totalCents)}
          </p>
        </section>
        <section className="report-card">
          <h2>Tenders</h2>
          {displayReport.tenders.map((item) => (
            <p key={item.tender}>
              {item.tender}: {formatMoney(item.totalCents)} ({item.saleCount})
            </p>
          ))}
        </section>
        <section className="report-card">
          <h2>Cash reconciliation</h2>
          <p>Opening float: {formatMoney(displayReport.openingFloatCents)}</p>
          <p>Cash sales: {formatMoney(displayReport.cash.salesCents)}</p>
          <p>
            Cash account payments: {formatMoney(cashPayments(displayReport))}
          </p>
          <p>Expected cash: {formatMoney(displayReport.expectedCashCents)}</p>
          <p>Cash received: {formatMoney(displayReport.cash.receivedCents)}</p>
          <p>
            Change given: {formatMoney(displayReport.cash.changeGivenCents)}
          </p>
          <div
            className={`reports-over-short ${overShort < 0 ? 'short' : overShort > 0 ? 'over' : ''}`}
          >
            {close ? 'Saved result: ' : 'Current result: '}
            {overShortLabel}
          </div>
        </section>
        <section className="report-card">
          <h2>Refunds and voids</h2>
          <p>
            Refunded: {displayReport.refunded.count} (
            {formatMoney(displayReport.refunded.totalCents)})
          </p>
          <p>
            Voided: {displayReport.voided.count} (
            {formatMoney(displayReport.voided.totalCents)})
          </p>
        </section>
        <section className="report-card">
          <h2>Gross profit</h2>
          <p>Net sales: {formatMoney(displayReport.profit.netSalesCents)}</p>
          <p>Cost: {formatMoney(displayReport.profit.costCents)}</p>
          <p className="report-total">
            Gross profit: {formatMoney(displayReport.profit.grossProfitCents)}
          </p>
        </section>
        <section className="report-card">
          <h2>Top items</h2>
          {displayReport.topItems.map((item) => (
            <p key={`${item.productId}-${item.productName}`}>
              {item.productName}: {item.quantity} (
              {formatMoney(item.totalCents)})
            </p>
          ))}
        </section>
        <section className="report-card">
          <h2>Account payments</h2>
          {displayReport.accountPayments.length === 0 ? (
            <p>None</p>
          ) : (
            displayReport.accountPayments.map((item) => (
              <p key={item.method}>
                {item.method}: {formatMoney(item.amountCents)} (
                {item.paymentCount})
              </p>
            ))
          )}
        </section>
        <section className="report-card">
          <h2>Receivables</h2>
          <p>Debits: {formatMoney(displayReport.receivables.debitsCents)}</p>
          <p>Credits: {formatMoney(displayReport.receivables.creditsCents)}</p>
        </section>
        <section className="report-card">
          <h2>Card transactions</h2>
          {displayReport.cardTransactions.length === 0 ? (
            <p>None</p>
          ) : (
            displayReport.cardTransactions.map((item) => (
              <p key={item.status}>
                {item.status}: {formatMoney(item.amountCents)} (
                {item.transactionCount})
              </p>
            ))
          )}
        </section>
        <section className="report-card">
          <h2>Channels</h2>
          {displayReport.channels.length === 0 ? (
            <p>None</p>
          ) : (
            displayReport.channels.map((item) => (
              <p key={item.channel}>
                {item.channel}: {formatMoney(item.totalCents)} ({item.saleCount}
                )
              </p>
            ))
          )}
        </section>
        <section className="report-card">
          <h2>Other inventory movements</h2>
          {displayReport.inventoryMovements.length === 0 ? (
            <p>None</p>
          ) : (
            displayReport.inventoryMovements.map((item) => (
              <p key={item.reason}>
                {item.reason}: {item.quantityChange} ({item.movementCount})
              </p>
            ))
          )}
        </section>
      </div>

      <section className="report-card reports-recent">
        <h2>Recent closes</h2>
        {closes.length === 0 ? (
          <p>No daily closes recorded yet.</p>
        ) : (
          <div className="reports-close-list">
            {closes.map((item) => (
              <div key={item.id}>
                <strong>{item.businessDate}</strong>
                <span>Expected {formatMoney(item.expectedCashCents)}</span>
                <span>Counted {formatMoney(item.countedCashCents)}</span>
                <span
                  className={
                    item.overShortCents < 0 ? 'short-text' : 'over-text'
                  }
                >
                  {item.overShortCents < 0 ? 'Short' : 'Over/even'}{' '}
                  {formatMoney(Math.abs(item.overShortCents))}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
