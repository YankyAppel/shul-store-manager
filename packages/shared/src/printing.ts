export interface PrinterInfo {
  name: string;
  displayName: string;
  description: string;
  status: number;
  isDefault: boolean;
}

export interface PrintResult {
  success: boolean;
  error: string | null;
  fallbackReason: string | null;
}

export function describePrintResult(
  result: PrintResult,
  documentLabel: string,
): string {
  if (result.success && result.fallbackReason) {
    return `${documentLabel} printed using the system dialog. ${result.fallbackReason}`;
  }
  if (result.success) {
    return `${documentLabel} sent to the printer.`;
  }
  return `${documentLabel} printing failed. ${result.error ?? 'Printing was canceled or failed.'}`.trim();
}
