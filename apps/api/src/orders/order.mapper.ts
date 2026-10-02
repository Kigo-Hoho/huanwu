import type { OrderView } from '@barter/contracts';
import type { Prisma } from '../generated/prisma/client.js';

export const orderInclude = {
  items: { orderBy: [{ side: 'asc' }, { sortOrder: 'asc' }] },
  parties: { orderBy: { side: 'asc' } },
  payments: { select: { id: true, orderId: true, side: true, purpose: true, amountFen: true, currency: true, status: true }, orderBy: { purpose: 'asc' } },
  shipments: true,
  cancellations: { orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 1 },
} satisfies Prisma.OrderInclude;
export type OrderTx = Prisma.TransactionClient;
export type LockedOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
const time = (value: Date | null) => value?.toISOString() ?? null;
export function mapOrder(order: LockedOrder): OrderView {
  const cancellation = order.cancellations[0];
  return {
    id: order.id, proposalId: order.proposalId, proposalVersionId: order.proposalVersionId,
    initiatorId: order.initiatorId, recipientId: order.recipientId, status: order.status, version: order.version,
    rules: { version: order.rulesVersion, depositFen: order.depositFen, feeFen: order.feeFen, detailsHours: order.detailsHours, paymentHours: order.paymentHours, fulfillmentHours: order.fulfillmentHours, inspectionHours: order.inspectionHours },
    terms: { differenceFen: order.differenceFen, payer: order.payer, deliveryMode: order.deliveryMode, initiatorShippingFen: order.initiatorShippingFen, recipientShippingFen: order.recipientShippingFen },
    items: order.items.map(item => ({ itemId: item.itemId, ownerId: item.ownerId, itemVersion: item.itemVersion, side: item.side, title: item.title, description: item.description, condition: item.condition, referenceValueFen: item.referenceValueFen, wantedText: item.wantedText, imageUrls: item.imageUrls })),
    parties: order.parties.map(party => {
      const shipment = order.shipments.find(shipment => shipment.side === party.side);
      return {
        side: party.side, userId: party.side === 'INITIATOR' ? order.initiatorId : order.recipientId,
        addressReady: party.addressReady,
        payments: order.payments.filter(payment => payment.side === party.side).map(payment => ({ id: payment.id, purpose: payment.purpose, amountFen: payment.amountFen, currency: 'CNY', status: payment.status })),
        outgoingShipment: shipment ? { id: shipment.id, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, status: shipment.status, registeredAt: shipment.registeredAt.toISOString(), collectedAt: time(shipment.collectedAt), deliveredAt: time(shipment.deliveredAt) } : null,
        incomingDeliveredAt: time(party.incomingDeliveredAt), acceptanceDeadline: time(party.acceptanceDeadline), acceptedAt: time(party.acceptedAt),
      };
    }),
    cancellation: cancellation ? { id: cancellation.id, requestedBySide: cancellation.requestedBySide, reason: cancellation.reason, status: cancellation.status, requestedAt: cancellation.requestedAt.toISOString(), respondedAt: time(cancellation.respondedAt) } : null,
    holdReason: order.holdReason, simulation: order.simulation,
    detailsDeadline: time(order.detailsDeadline), paymentDeadline: time(order.paymentDeadline), fulfillmentDeadline: time(order.fulfillmentDeadline),
    createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(),
  };
}
