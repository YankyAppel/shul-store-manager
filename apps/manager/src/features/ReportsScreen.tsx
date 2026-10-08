import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CashMovement,
  DailyClose,
  DailyReport,
  ExpiringBatch,
  MarginReport,
  ProductMarginLine,
} from '@shul-store/shared';
import { parseUsdToCents } from '@shul-store/shared';
import {
  formatMoney,
  formatQuantity,
  formatStock,
  messageFrom,
} from '../utils/formatters';

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

const COST_SOURCE_LABEL: Record<ProductMarginLine['costSource'], string> = {
  negotiated: 'your price',
  catalog: 'vendor list',
  product: 'product cost',
  none: 'no cost',
};

function formatPercent(ratio: number | null): string {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

function MarginSection() {
  const [report, setReport] = useState<MarginReport>();
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'lowest' | 'name'>('lowest');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.storeApi.reports
      .margins()
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageFrom(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const lines = useMemo(() => {
    if (!report) return [];
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? report.lines.filter((line) =>
          [line.productName, line.categoryName, line.vendorName ?? '']
            .join(' ')
            .toLowerCase()
            .includes(needle),
        )
      : report.lines;
    if (sort === 'name') return matched;
    return [...matched].sort((a, b) => {
      if (a.marginRatio === null) return b.marginRatio === null ? 0 : 1;
      if (b.marginRatio === null) return -1;
      return a.marginRatio - b.marginRatio;
    });
  }, [report, filter, sort]);

  if (!open) {
    return (
      <section className="report-card reports-recent">
        <h2>Margins</h2>
        <p>
          Selling price against what you pay the preferred vendor for every
          active product.
        </p>
        <button type="button" onClick={() => setOpen(true)}>
          Show margin report
        </button>
      </section>
    );
  }

  const shelfMargin =
    report && report.retailValueCents > 0
      ? (report.retailValueCents - report.costValueCents) /
        report.retailValueCents
      : null;

  return (
    <section className="report-card reports-recent">
      <h2>Margins</h2>
      {error && <div className="alert">{error}</div>}
      {!report && !error && <p>Loading…</p>}
      {report && (
        <>
          <p>
            Stock on hand would sell for {formatMoney(report.retailValueCents)}{' '}
            and cost {formatMoney(report.costValueCents)} (
            {formatPercent(shelfMargin)} margin).
            {report.missingCostCount > 0 &&
              ` ${report.missingCostCount} product${report.missingCostCount === 1 ? '' : 's'} have no cost yet.`}
          </p>
          <div className="reports-controls">
            <label>
              Search
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Product, category or vendor"
              />
            </label>
            <label>
              Sort
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as 'lowest' | 'name')
                }
              >
                <option value="lowest">Lowest margin first</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Vendor</th>
                <th>Price</th>
                <th>Cost</th>
                <th>Margin</th>
                <th>%</th>
                <th>Stock</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.productId}>
                  <td>
                    {line.productName}
                    <div className="muted">{line.categoryName}</div>
                  </td>
                  <td>{line.vendorName ?? '—'}</td>
                  <td>{formatMoney(line.sellingPriceCents)}</td>
                  <td>
                    {line.costCents === null
                      ? '—'
                      : formatMoney(line.costCents)}
                    <div className="muted">
                      {COST_SOURCE_LABEL[line.costSource]}
                    </div>
                  </td>
                  <td
                    className={
                      line.marginCents !== null && line.marginCents < 0
                        ? 'short-text'
                        : undefined
                    }
                  >
                    {line.marginCents === null
                      ? '—'
                      : formatMoney(line.marginCents)}
                  </td>
                  <td>{formatPercent(line.marginRatio)}</td>
                  <td>
                    {formatStock(line.stockQuantity, line.soldBy, line.unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
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
              {item.productName}:{' '}
              {formatQuantity(item.quantity, item.soldBy, item.unit)} (
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
        <CashDrawerCard businessDate={businessDate} onChanged={refresh} />
        <ExpiringStockCard />
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

      <MarginSection />
    </div>
  );
}

function CashDrawerCard({
  businessDate,
  onChanged,
}: {
  businessDate: string;
  onChanged(): Promise<void>;
}) {
  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [kind, setKind] = useState<'pay_in' | 'pay_out' | 'drop'>('pay_in');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    window.storeApi.cashDrawer
      .list()
      .then((all) =>
        setMovements(
          all.filter((m) => m.createdAt.slice(0, 10) === businessDate),
        ),
      )
      .catch(() => {});
  }, [businessDate]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const totals = useMemo(() => {
    const sum = (k: string) =>
      movements
        .filter((m) => m.kind === k)
        .reduce((total, m) => total + m.amountCents, 0);
    return { in: sum('pay_in'), out: sum('pay_out') + sum('drop') };
  }, [movements]);

  async function record(e: React.FormEvent) {
    e.preventDefault();
    const cents = centsFromInput(amount);
    if (cents <= 0) {
      setError('Enter an amount above $0.');
      return;
    }
    try {
      await window.storeApi.cashDrawer.record({
        kind,
        amountCents: cents,
        reason: reason.trim() || kind.replace('_', ' '),
      });
      setAmount('');
      setReason('');
      setError('');
      refresh();
      await onChanged();
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  return (
    <section className="report-card">
      <h2>Cash drawer movements</h2>
      <p>
        In: {formatMoney(totals.in)} · Out (incl. drops):{' '}
        {formatMoney(totals.out)} — feeds expected cash for {businessDate}
      </p>
      {movements.map((movement) => (
        <p key={movement.id} style={{ fontSize: 13 }}>
          {new Date(movement.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}{' '}
          {movement.kind === 'pay_in'
            ? 'Pay-in'
            : movement.kind === 'pay_out'
              ? 'Pay-out'
              : 'Drop'}
          : {formatMoney(movement.amountCents)}
          {movement.reason ? ` — ${movement.reason}` : ''}
        </p>
      ))}
      <form
        onSubmit={(e) => void record(e)}
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}
      >
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="pay_in">Pay-in</option>
          <option value="pay_out">Pay-out</option>
          <option value="drop">Drop (to safe)</option>
        </select>
        <input
          inputMode="decimal"
          placeholder="$0.00"
          style={{ width: 90 }}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          placeholder="Reason (optional)"
          style={{ flex: 1, minWidth: 120 }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="submit">Record</button>
      </form>
      {error && <div className="alert">{error}</div>}
    </section>
  );
}

function ExpiringStockCard() {
  const [withinDays, setWithinDays] = useState(14);
  const [batches, setBatches] = useState<ExpiringBatch[]>([]);

  useEffect(() => {
    window.storeApi.reports
      .expiringStock(withinDays)
      .then(setBatches)
      .catch(() => {});
  }, [withinDays]);

  return (
    <section className="report-card">
      <h2>Soon-expiring stock (FEFO)</h2>
      <label style={{ fontSize: 13 }}>
        Within{' '}
        <select
          value={withinDays}
          onChange={(e) => setWithinDays(Number(e.target.value))}
        >
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
        </select>
      </label>
      {batches.length === 0 ? (
        <p>No batches expiring in this window.</p>
      ) : (
        batches.map((batch, index) => (
          <p key={`${batch.productId}-${index}`} style={{ fontSize: 13 }}>
            <b>{batch.productName}</b>:{' '}
            {formatStock(batch.remainingUnits, batch.soldBy, batch.unit)} —
            expires {batch.expiresOn}
          </p>
        ))
      )}
      <p style={{ fontSize: 12, color: '#5f6d65' }}>
        Recorded on incoming movements (Inventory → Receive stock → Expiry
        date). Sell soonest-expiring batches first.
      </p>
    </section>
  );
}
