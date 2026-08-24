import type {
  AccountPaymentReceiptData,
  CustomerStatementData,
  ReceiptData,
} from './index.js';

export function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatCents(cents: number): string {
  const isNegative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const formatted = `$${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
  return isNegative ? `-${formatted}` : formatted;
}

function receiptPaperWidthMm(settings: {
  receiptPaperWidthMm?: 58 | 80 | undefined;
}): 58 | 80 {
  return settings.receiptPaperWidthMm === 58 ? 58 : 80;
}

function receiptBodyCss(settings: {
  receiptPaperWidthMm?: 58 | 80 | undefined;
}): string {
  const widthMm = receiptPaperWidthMm(settings);
  return `body{font:14px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;width:${widthMm}mm;max-width:${widthMm}mm;margin:auto;padding:4mm;color:#111;box-sizing:border-box}
    @page{size:${widthMm}mm auto;margin:0}`;
}

export function receiptHtml({ sale, settings }: ReceiptData): string {
  const rows = sale.items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.productName)} × ${item.quantity}</td><td>${formatCents(item.lineTotalCents)}</td></tr>`,
    )
    .join('');

  let paymentDetails = '';
  if (sale.payment.method === 'cash') {
    paymentDetails = `Cash ${formatCents(sale.payment.cashReceivedCents ?? 0)} · Change ${formatCents(sale.payment.changeDueCents ?? 0)}`;
  } else if (sale.payment.method === 'external_terminal') {
    paymentDetails = `External terminal${sale.payment.terminalReference ? ` · Ref ${escapeHtml(sale.payment.terminalReference)}` : ''}`;
  } else if (sale.payment.method === 'account') {
    const prev = sale.payment.previousBalanceCents ?? 0;
    const next = sale.payment.newBalanceCents ?? prev + sale.totalCents;
    paymentDetails = `<b>Charged to Account</b><br>Customer: ${escapeHtml(sale.payment.customerName ?? '')} (${escapeHtml(sale.payment.accountNumber ?? '')})<br>Previous balance: ${formatCents(prev)}<br>This purchase: ${formatCents(sale.totalCents)}<br><b>New balance: ${formatCents(next)}</b>`;
  } else if (sale.payment.method === 'integrated_card') {
    paymentDetails = `Card ending in ${escapeHtml(sale.payment.cardLast4 ?? '')}<br>Brand: ${escapeHtml(sale.payment.cardBrand ?? 'Unknown')}<br>Processor Ref: ${escapeHtml(sale.payment.processorTransactionId ?? '')}`;
  }

  const customerHeader =
    sale.payment.method === 'account'
      ? `<div style="text-align:center;margin:6px 0;font-size:13px"><b>Customer:</b> ${escapeHtml(sale.payment.customerName ?? '')} (Acct #${escapeHtml(sale.payment.accountNumber ?? '')})</div>`
      : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt #${sale.receiptNumber}</title>
  <style>
    ${receiptBodyCss(settings)}
    h1{text-align:center;margin:0 0 6px 0;font-size:18px}
    table{width:100%;border-collapse:collapse;margin:12px 0}
    td{padding:3px 0}
    td:last-child{text-align:right}
    .totals{border-top:1px dashed #666;margin-top:10px;padding-top:8px;line-height:1.5}
    .footer{text-align:center;margin-top:20px;white-space:pre-line;font-size:12px;color:#555}
  </style>
</head>
<body data-paper-width="${receiptPaperWidthMm(settings)}">
  <h1>${escapeHtml(settings.storeName)}</h1>
  ${settings.contactLines.map((line) => `<div style="text-align:center;font-size:12px">${escapeHtml(line)}</div>`).join('')}
  <p style="margin:10px 0 6px;font-size:12px">Receipt #${sale.receiptNumber}<br>${escapeHtml(new Date(sale.completedAt ?? sale.createdAt).toLocaleString())}</p>
  ${customerHeader}
  <table>${rows}</table>
  <div class="totals">
    Subtotal: ${formatCents(sale.subtotalCents)}<br>
    Tax: ${formatCents(sale.taxCents)}<br>
    <b>Total: ${formatCents(sale.totalCents)}</b>
    <hr style="border:none;border-top:1px dotted #aaa;margin:8px 0">
    ${paymentDetails}
  </div>
  ${settings.receiptFooter ? `<div class="footer">${escapeHtml(settings.receiptFooter)}</div>` : ''}
</body>
</html>`;
}

export function accountPaymentReceiptHtml({
  payment,
  settings,
}: AccountPaymentReceiptData): string {
  const methodText =
    payment.method === 'cash'
      ? `Cash: ${formatCents(payment.cashReceivedCents ?? payment.amountCents)} · Change: ${formatCents(payment.changeDueCents ?? 0)}`
      : `External terminal${payment.terminalReference ? ` (Ref: ${escapeHtml(payment.terminalReference)})` : ''}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Payment Receipt #${payment.receiptNumber}</title>
  <style>
    ${receiptBodyCss(settings)}
    h1{text-align:center;margin:0 0 6px 0;font-size:18px}
    .payment-box{border:1px solid #333;border-radius:4px;padding:12px;margin:12px 0;background:#fafafa}
    .totals{line-height:1.6}
    .footer{text-align:center;margin-top:20px;white-space:pre-line;font-size:12px;color:#555}
  </style>
</head>
<body data-paper-width="${receiptPaperWidthMm(settings)}">
  <h1>${escapeHtml(settings.storeName)}</h1>
  ${settings.contactLines.map((line) => `<div style="text-align:center;font-size:12px">${escapeHtml(line)}</div>`).join('')}
  <div style="text-align:center;margin:10px 0;font-size:15px"><b>Account Payment Receipt #${payment.receiptNumber}</b></div>
  <div style="font-size:12px;margin-bottom:10px;text-align:center">${escapeHtml(new Date(payment.createdAt).toLocaleString())}</div>
  
  <div class="payment-box">
    <div><b>Customer:</b> ${escapeHtml(payment.customerName)}</div>
    <div><b>Account #:</b> ${escapeHtml(payment.accountNumber)}</div>
    ${payment.notes ? `<div><b>Notes:</b> ${escapeHtml(payment.notes)}</div>` : ''}
  </div>

  <div class="totals">
    Previous balance: ${formatCents(payment.previousBalanceCents)}<br>
    <b>Payment applied: ${formatCents(payment.amountCents)}</b><br>
    Method: ${methodText}<br>
    <hr style="border:none;border-top:1px dashed #666;margin:8px 0">
    <b>New balance: ${formatCents(payment.newBalanceCents)}</b>
  </div>

  ${settings.receiptFooter ? `<div class="footer">${escapeHtml(settings.receiptFooter)}</div>` : ''}
</body>
</html>`;
}

export function statementHtml(data: CustomerStatementData): string {
  const {
    customer,
    settings,
    period,
    openingBalanceCents,
    entries,
    closingBalanceCents,
    totalChargesCents,
    totalPaymentsCents,
  } = data;

  const rows = entries
    .map((entry) => {
      const ref = entry.relatedSaleReceiptNumber
        ? `Sale #${entry.relatedSaleReceiptNumber}`
        : entry.relatedPaymentReceiptNumber
          ? `Payment #${entry.relatedPaymentReceiptNumber}`
          : '—';
      const charge =
        entry.chargeCents !== null ? formatCents(entry.chargeCents) : '';
      const payment =
        entry.paymentCents !== null ? formatCents(entry.paymentCents) : '';
      return `<tr>
      <td>${escapeHtml(new Date(entry.occurredAt).toLocaleDateString())}</td>
      <td>${escapeHtml(entry.notes)}</td>
      <td>${escapeHtml(ref)}</td>
      <td style="text-align:right">${charge}</td>
      <td style="text-align:right">${payment}</td>
      <td style="text-align:right"><b>${formatCents(entry.runningBalanceCents)}</b></td>
    </tr>`;
    })
    .join('');

  const balanceLabel =
    closingBalanceCents > 0
      ? `Amount owed: ${formatCents(closingBalanceCents)}`
      : closingBalanceCents < 0
        ? `Customer credit: ${formatCents(Math.abs(closingBalanceCents))}`
        : `Settled ($0.00)`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Statement - ${escapeHtml(customer.name)}</title>
  <style>
    body{font:13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:auto;padding:30px;color:#111}
    .header{display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:14px;margin-bottom:16px}
    .cust-info{background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;padding:12px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse;margin:16px 0}
    th, td{border:1px solid #ddd;padding:6px 8px;font-size:12px}
    th{background:#f1f3f5;text-align:left}
    .summary-box{margin-top:20px;float:right;width:280px;background:#f8f9fa;border:1px solid #333;border-radius:4px;padding:12px;line-height:1.6}
    .footer{clear:both;text-align:center;padding-top:40px;font-size:11px;color:#666;white-space:pre-line}
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h2 style="margin:0 0 4px 0">${escapeHtml(settings.storeName)}</h2>
      ${settings.contactLines.map((line) => `<div style="font-size:12px;color:#555">${escapeHtml(line)}</div>`).join('')}
    </div>
    <div style="text-align:right">
      <h3 style="margin:0 0 4px 0">ACCOUNT STATEMENT</h3>
      <div style="font-size:12px"><b>Period:</b> ${escapeHtml(period.label)}</div>
      <div style="font-size:11px;color:#666">Generated: ${escapeHtml(new Date(data.generatedAt).toLocaleString())}</div>
    </div>
  </div>

  <div class="cust-info">
    <strong>Customer:</strong> ${escapeHtml(customer.name)} ${customer.secondaryName ? `(${escapeHtml(customer.secondaryName)})` : ''}<br>
    <strong>Account #:</strong> ${escapeHtml(customer.accountNumber)}
    ${customer.phone ? ` &nbsp;·&nbsp; <strong>Phone:</strong> ${escapeHtml(customer.phone)}` : ''}
    ${customer.email ? ` &nbsp;·&nbsp; <strong>Email:</strong> ${escapeHtml(customer.email)}` : ''}
    ${customer.address ? `<br><strong>Address:</strong> ${escapeHtml(customer.address)}` : ''}
  </div>

  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Description</th>
        <th>Reference</th>
        <th style="text-align:right">Charges</th>
        <th style="text-align:right">Payments</th>
        <th style="text-align:right">Balance</th>
      </tr>
    </thead>
    <tbody>
      <tr style="background:#fdfdfd">
        <td colspan="5"><em>Opening Balance</em></td>
        <td style="text-align:right"><b>${formatCents(openingBalanceCents)}</b></td>
      </tr>
      ${rows}
    </tbody>
  </table>

  <div class="summary-box">
    <div style="display:flex;justify-content:space-between"><span>Opening balance:</span> <span>${formatCents(openingBalanceCents)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>Total charges:</span> <span>+${formatCents(totalChargesCents)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>Total payments:</span> <span>-${formatCents(totalPaymentsCents)}</span></div>
    <hr style="border:none;border-top:1px solid #333;margin:6px 0">
    <div style="display:flex;justify-content:space-between;font-size:14px"><b>Closing balance:</b> <b>${escapeHtml(balanceLabel)}</b></div>
  </div>

  ${settings.statementFooter ? `<div class="footer">${escapeHtml(settings.statementFooter)}</div>` : ''}
</body>
</html>`;
}
