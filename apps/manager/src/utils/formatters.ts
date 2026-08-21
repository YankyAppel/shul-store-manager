export function formatMoney(cents: number): string {
  const isNegative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const formatted = `$${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
  return isNegative ? `-${formatted}` : formatted;
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
