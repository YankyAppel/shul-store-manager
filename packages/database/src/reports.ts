import type {
  DailyAccountPaymentTotal,
  DailyCardTransactionTotal,
  DailyChannelTotal,
  DailyInventoryMovementTotal,
  DailyReport,
  DailyReportInput,
  DailyTenderTotal,
  DailyTopItem,
} from '@shul-store/shared';
import type { SqliteDatabase } from './sqlite.js';

interface SalesTotalsRow {
  sale_count: number;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
}

interface RefundedRow {
  refunded_count: number;
  refunded_total_cents: number;
}

interface VoidedRow {
  voided_count: number;
  voided_total_cents: number;
}

interface TenderRow {
  tender: string;
  sale_count: number;
  total_cents: number;
}

interface CashRow {
  cash_sales_cents: number;
  cash_received_cents: number;
  change_given_cents: number;
}

interface AccountPaymentRow {
  method: string;
  payment_count: number;
  amount_cents: number;
}

interface ReceivablesRow {
  debits_cents: number;
  credits_cents: number;
}

interface CardTransactionRow {
  status: string;
  transaction_count: number;
  amount_cents: number;
}

interface UnresolvedCardRow {
  unresolved_count: number;
  amount_cents: number;
}

interface ChannelRow {
  channel: string;
  sale_count: number;
  total_cents: number;
}

interface ProfitRow {
  cost_cents: number;
  net_sales_cents: number;
}

interface TopItemRow {
  product_id: string;
  product_name: string;
  quantity: number;
  total_cents: number;
}

interface InventoryMovementRow {
  reason: string;
  movement_count: number;
  quantity_change: number;
}

function row<T>(value: unknown): T {
  return value as T;
}

function integer(value: number | bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error(`${label} exceeds the supported safe integer range.`);
  return result;
}

function allRows<T>(
  connection: SqliteDatabase,
  sql: string,
  from: string,
  to: string,
): T[] {
  return connection.prepare(sql).all(from, to) as T[];
}

export function dailyReport(
  connection: SqliteDatabase,
  input: DailyReportInput,
): DailyReport {
  const sales = row<SalesTotalsRow>(
    connection
      .prepare(
        `SELECT COUNT(*) AS sale_count,
                COALESCE(SUM(subtotal_cents), 0) AS subtotal_cents,
                COALESCE(SUM(tax_cents), 0) AS tax_cents,
                COALESCE(SUM(total_cents), 0) AS total_cents
         FROM sales
         WHERE status IN ('completed','refunded')
           AND completed_at >= ? AND completed_at < ?;`,
      )
      .get(input.from, input.to),
  );
  const refunded = row<RefundedRow>(
    connection
      .prepare(
        `SELECT COUNT(*) AS refunded_count,
                COALESCE(SUM(total_cents), 0) AS refunded_total_cents
         FROM sales
         WHERE status = 'refunded'
           AND completed_at >= ? AND completed_at < ?;`,
      )
      .get(input.from, input.to),
  );
  const voided = row<VoidedRow>(
    connection
      .prepare(
        `SELECT COUNT(*) AS voided_count,
                COALESCE(SUM(total_cents), 0) AS voided_total_cents
         FROM sales
         WHERE status = 'voided'
           AND created_at >= ? AND created_at < ?;`,
      )
      .get(input.from, input.to),
  );
  const tenders = allRows<TenderRow>(
    connection,
    `SELECT COALESCE(NULLIF(s.tender_type, 'immediate_payment'), p.method, 'unknown')
              AS tender,
            COUNT(*) AS sale_count,
            COALESCE(SUM(s.total_cents), 0) AS total_cents
     FROM sales s
     LEFT JOIN payments p ON p.sale_id = s.id
     WHERE s.status IN ('completed', 'refunded')
       AND s.completed_at >= ? AND s.completed_at < ?
     GROUP BY tender;`,
    input.from,
    input.to,
  );
  const cash = row<CashRow>(
    connection
      .prepare(
        `SELECT COALESCE(SUM(p.amount_cents), 0) AS cash_sales_cents,
                COALESCE(SUM(p.cash_received_cents), 0) AS cash_received_cents,
                COALESCE(SUM(p.change_due_cents), 0) AS change_given_cents
         FROM payments p
         JOIN sales s ON s.id = p.sale_id
         WHERE p.method = 'cash'
           AND s.status IN ('completed', 'refunded')
           AND s.completed_at >= ? AND s.completed_at < ?;`,
      )
      .get(input.from, input.to),
  );
  const accountPayments = allRows<AccountPaymentRow>(
    connection,
    `SELECT method,
            COUNT(*) AS payment_count,
            COALESCE(SUM(amount_cents), 0) AS amount_cents
     FROM account_payments
     WHERE created_at >= ? AND created_at < ?
     GROUP BY method;`,
    input.from,
    input.to,
  );
  const receivables = row<ReceivablesRow>(
    connection
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0)
                  AS debits_cents,
                COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0)
                  AS credits_cents
         FROM customer_ledger
         WHERE occurred_at >= ? AND occurred_at < ?;`,
      )
      .get(input.from, input.to),
  );
  const cardTransactions = allRows<CardTransactionRow>(
    connection,
    `SELECT status,
            COUNT(*) AS transaction_count,
            COALESCE(SUM(amount_cents), 0) AS amount_cents
     FROM payment_transactions
     WHERE created_at >= ? AND created_at < ?
     GROUP BY status;`,
    input.from,
    input.to,
  );
  const unresolvedCard = row<UnresolvedCardRow>(
    connection
      .prepare(
        `SELECT COUNT(*) AS unresolved_count,
                COALESCE(SUM(amount_cents), 0) AS amount_cents
         FROM payment_transactions
         WHERE status IN ('initiated', 'unknown', 'needs-attention');`,
      )
      .get(),
  );
  const channels = allRows<ChannelRow>(
    connection,
    `SELECT channel,
            COUNT(*) AS sale_count,
            COALESCE(SUM(total_cents), 0) AS total_cents
     FROM sales
     WHERE status IN ('completed', 'refunded')
       AND completed_at >= ? AND completed_at < ?
     GROUP BY channel;`,
    input.from,
    input.to,
  );
  const profit = row<ProfitRow>(
    connection
      .prepare(
        `SELECT COALESCE(SUM(i.quantity * i.unit_purchase_cost_cents), 0) AS cost_cents,
                COALESCE(SUM(i.line_subtotal_cents), 0) AS net_sales_cents
         FROM sale_items i
         JOIN sales s ON s.id = i.sale_id
         WHERE s.status IN ('completed', 'refunded')
           AND s.completed_at >= ? AND s.completed_at < ?;`,
      )
      .get(input.from, input.to),
  );
  const topItems = allRows<TopItemRow>(
    connection,
    `SELECT i.product_id,
            i.product_name,
            SUM(i.quantity) AS quantity,
            SUM(i.line_total_cents) AS total_cents
     FROM sale_items i
     JOIN sales s ON s.id = i.sale_id
     WHERE s.status IN ('completed', 'refunded')
       AND s.completed_at >= ? AND s.completed_at < ?
     GROUP BY i.product_id, i.product_name
     ORDER BY quantity DESC, total_cents DESC
     LIMIT 10;`,
    input.from,
    input.to,
  );
  const inventoryMovements = allRows<InventoryMovementRow>(
    connection,
    `SELECT reason,
            COUNT(*) AS movement_count,
            COALESCE(SUM(quantity_change), 0) AS quantity_change
     FROM inventory_movements
     WHERE reason <> 'sale'
       AND occurred_at >= ? AND occurred_at < ?
     GROUP BY reason;`,
    input.from,
    input.to,
  );

  const cashSalesCents = integer(cash.cash_sales_cents, 'Cash sales');
  const cashAccountPaymentsCents = accountPayments
    .filter((payment) => payment.method === 'cash')
    .reduce(
      (total, payment) =>
        total + integer(payment.amount_cents, 'Cash account payments'),
      0,
    );
  const costCents = integer(profit.cost_cents, 'Cost');
  const netSalesCents = integer(profit.net_sales_cents, 'Net sales');

  const tenderTotals: DailyTenderTotal[] = tenders.map((item) => ({
    tender: item.tender,
    saleCount: integer(item.sale_count, 'Tender sale count'),
    totalCents: integer(item.total_cents, 'Tender total'),
  }));
  const accountPaymentTotals: DailyAccountPaymentTotal[] = accountPayments.map(
    (item) => ({
      method: item.method,
      paymentCount: integer(item.payment_count, 'Account payment count'),
      amountCents: integer(item.amount_cents, 'Account payment amount'),
    }),
  );
  const cardTransactionTotals: DailyCardTransactionTotal[] =
    cardTransactions.map((item) => ({
      status: item.status,
      transactionCount: integer(
        item.transaction_count,
        'Card transaction count',
      ),
      amountCents: integer(item.amount_cents, 'Card transaction amount'),
    }));
  const channelTotals: DailyChannelTotal[] = channels.map((item) => ({
    channel: item.channel,
    saleCount: integer(item.sale_count, 'Channel sale count'),
    totalCents: integer(item.total_cents, 'Channel total'),
  }));
  const topItemTotals: DailyTopItem[] = topItems.map((item) => ({
    productId: item.product_id,
    productName: item.product_name,
    quantity: integer(item.quantity, 'Top item quantity'),
    totalCents: integer(item.total_cents, 'Top item total'),
  }));
  const movementTotals: DailyInventoryMovementTotal[] = inventoryMovements.map(
    (item) => ({
      reason: item.reason,
      movementCount: integer(item.movement_count, 'Movement count'),
      quantityChange: integer(item.quantity_change, 'Quantity change'),
    }),
  );

  return {
    rangeStart: input.from,
    rangeEnd: input.to,
    openingFloatCents: input.openingFloatCents,
    sales: {
      saleCount: integer(sales.sale_count, 'Sale count'),
      subtotalCents: integer(sales.subtotal_cents, 'Subtotal'),
      taxCents: integer(sales.tax_cents, 'Tax'),
      totalCents: integer(sales.total_cents, 'Sales total'),
    },
    refunded: {
      count: integer(refunded.refunded_count, 'Refunded sale count'),
      totalCents: integer(refunded.refunded_total_cents, 'Refunded sale total'),
    },
    voided: {
      count: integer(voided.voided_count, 'Voided sale count'),
      totalCents: integer(voided.voided_total_cents, 'Voided sale total'),
    },
    tenders: tenderTotals,
    cash: {
      salesCents: cashSalesCents,
      receivedCents: integer(cash.cash_received_cents, 'Cash received'),
      changeGivenCents: integer(cash.change_given_cents, 'Change given'),
    },
    accountPayments: accountPaymentTotals,
    receivables: {
      debitsCents: integer(receivables.debits_cents, 'Receivables debits'),
      creditsCents: integer(receivables.credits_cents, 'Receivables credits'),
    },
    cardTransactions: cardTransactionTotals,
    unresolvedCard: {
      count: integer(unresolvedCard.unresolved_count, 'Unresolved card count'),
      amountCents: integer(
        unresolvedCard.amount_cents,
        'Unresolved card amount',
      ),
    },
    channels: channelTotals,
    profit: {
      costCents,
      netSalesCents,
      grossProfitCents: netSalesCents - costCents,
    },
    topItems: topItemTotals,
    inventoryMovements: movementTotals,
    expectedCashCents:
      input.openingFloatCents + cashSalesCents + cashAccountPaymentsCents,
  };
}
