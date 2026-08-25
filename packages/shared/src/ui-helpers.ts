const attentionReasonLabels: Record<string, string> = {
  'invalid-snapshot': 'The saved cart details are no longer valid.',
  'snapshot-hash-mismatch': 'The saved cart details were changed unexpectedly.',
  'amount-mismatch': 'The processor amount does not match the saved cart.',
  'processor-changed': 'The configured card processor changed.',
  'processor-config-changed':
    'The card processor configuration changed before this charge was settled.',
  'frozen-config-unavailable':
    'The saved card processor configuration could not be recovered.',
  'finalization-failed':
    'The charge was approved but the sale could not be completed.',
  'reconciliation-failed': 'The charge status could not be checked.',
};

export function describeAttentionReason(reason: string | null): string {
  const key = reason?.split(':', 1)[0] ?? '';
  if (key === 'voided') return 'The charge was voided by the manager.';
  return attentionReasonLabels[key] ?? 'This charge needs manager attention.';
}

export function formatRelativeTime(
  timestamp: string,
  now = Date.now(),
): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 'unknown time';
  const elapsedSeconds = Math.floor(Math.max(0, now - parsed) / 1000);
  if (elapsedSeconds < 60) return 'just now';
  if (elapsedSeconds < 3600) {
    const minutes = Math.floor(elapsedSeconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsedSeconds < 86400) {
    const hours = Math.floor(elapsedSeconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(elapsedSeconds / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatKioskAddress(address: string, port: number): string {
  return `${address}:${port}`;
}

export function validatePort(value: string): string | null {
  if (!/^\d+$/.test(value.trim())) return 'Port must be an integer.';
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    return 'Port must be between 1 and 65535.';
  return null;
}
