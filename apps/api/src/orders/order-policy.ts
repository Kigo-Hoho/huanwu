import type { OrderView } from '@barter/contracts';

export type OrderDeadline = 'DETAILS' | 'PAYMENT' | 'FULFILLMENT' | 'INSPECTION';

export function dueDeadline(order: OrderView, now: Date): OrderDeadline | null {
  const due = (deadline: string | null) => deadline !== null && now.getTime() >= Date.parse(deadline);
  switch (order.status) {
    case 'AWAITING_DETAILS': return due(order.detailsDeadline) ? 'DETAILS' : null;
    case 'AWAITING_PAYMENT': return due(order.paymentDeadline) ? 'PAYMENT' : null;
    case 'AWAITING_FULFILLMENT': return due(order.fulfillmentDeadline) ? 'FULFILLMENT' : null;
    case 'IN_TRANSIT':
    case 'AWAITING_ACCEPTANCE':
      return order.parties.some(party => party.acceptedAt === null && due(party.acceptanceDeadline)) ? 'INSPECTION' : null;
    default: return null;
  }
}
