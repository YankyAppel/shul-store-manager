import {
  calculateRefund,
  type RecordRefundInput,
  type RefundCalculation,
  type RefundMethod,
  type RefundableSale,
} from '@shul-store/shared';

export interface RefundValidation {
  method: RefundMethod;
  terminalReference: string | null;
  calculation: RefundCalculation;
}

export function validateRefundRequest(
  context: RefundableSale,
  input: RecordRefundInput,
  processorRefundId: string | null = null,
  requireProcessorRefund = true,
): RefundValidation {
  const derivedMethod = context.method;
  const manualExternal =
    input.manualExternalTerminal === true &&
    derivedMethod === 'integrated_card';
  const method = manualExternal ? 'external_terminal' : derivedMethod;
  if (
    derivedMethod === 'integrated_card' &&
    !manualExternal &&
    requireProcessorRefund &&
    !processorRefundId
  )
    throw new Error(
      'No processor refund was completed. Refund on the physical terminal and record an external-terminal refund.',
    );
  const terminalReference = input.terminalReference?.trim() || null;
  if (method === 'external_terminal' && !terminalReference)
    throw new Error('A terminal reference is required for this refund.');
  if (method !== 'external_terminal' && terminalReference)
    throw new Error('Terminal reference is only valid for terminal refunds.');
  if (method !== 'integrated_card' && processorRefundId)
    throw new Error(
      'Processor refund ID is only valid for integrated-card refunds.',
    );
  if (method === 'account' && !context.customerId)
    throw new Error('Account refund requires the original sale customer.');

  const itemsById = new Map(context.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const requested of input.items) {
    if (seen.has(requested.saleItemId))
      throw new Error('A sale line may appear only once in a refund');
    seen.add(requested.saleItemId);
    if (!itemsById.has(requested.saleItemId))
      throw new Error('Refund sale item was not found.');
  }
  const calculation = calculateRefund(
    input.items.map((requested) => {
      const item = itemsById.get(requested.saleItemId)!;
      return {
        saleItemId: item.id,
        productName: item.productName,
        soldQuantity: item.quantity,
        refundedQuantity: item.refundedQuantity,
        taxAlreadyRefundedCents: item.taxRefundedCents,
        unitSellingPriceCents: item.unitSellingPriceCents,
        taxCents: item.taxCents,
        quantity: requested.quantity,
        restocked: requested.restocked,
      };
    }),
  );
  return { method, terminalReference, calculation };
}
