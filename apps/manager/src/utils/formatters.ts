export function formatMoney(cents: number): string {
  const isNegative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const formatted = `$${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
  return isNegative ? `-${formatted}` : formatted;
}

/** Quantity display: weight lines print with their unit (e.g. "2.350 lb"). */
export function formatQuantity(
  quantity: number,
  soldBy?: string | null,
  unit?: string | null,
): string {
  if (soldBy === 'weight') {
    const rounded = Math.round(quantity * 1000) / 1000;
    return `${rounded} ${unit ?? 'units'}`;
  }
  return String(Math.round(quantity * 1000) / 1000);
}

/** Stock levels for weight products are tracked in milli-units. */
export function formatStock(
  stockQuantity: number,
  soldBy?: string | null,
  unit?: string | null,
): string {
  if (soldBy === 'weight')
    return formatQuantity(stockQuantity / 1000, soldBy, unit);
  return String(Math.round(stockQuantity));
}

export function formatBalanceStatus(cents: number): {
  label: string;
  formatted: string;
  className: string;
} {
  if (cents > 0) {
    return {
      label: 'Amount owed',
      formatted: `Amount owed: ${formatMoney(cents)}`,
      className: 'balance-owed',
    };
  }
  if (cents < 0) {
    return {
      label: 'Customer credit',
      formatted: `Customer credit: ${formatMoney(Math.abs(cents))}`,
      className: 'balance-credit',
    };
  }
  return {
    label: 'Settled',
    formatted: 'Settled ($0.00)',
    className: 'balance-settled',
  };
}

export function messageFrom(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': /, '');
  }
  return 'Something went wrong';
}
