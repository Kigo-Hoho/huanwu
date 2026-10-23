import type { VerifiedIntegrationEvent } from '../integrations/integration.types.js';
export function compensationIdentity(event: VerifiedIntegrationEvent) {
  if ('shipmentId' in event) return null;
  const match = /^compensation:(payment|refund|disburse|close):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(event.businessNo);
  if (!match) return null;
  const expected = { payment: 'PAYMENT_SUCCEEDED', refund: 'REFUND_SUCCEEDED', disburse: 'DIFFERENCE_SETTLED', close: 'PAYMENT_CLOSED' }[match[1]];
  return { paymentId: match[2], matches: event.kind === expected, entryType: match[1] === 'payment' ? 'COLLECTION' as const : match[1] === 'refund' ? 'REFUND' as const : 'TRANSFER' as const };
}
