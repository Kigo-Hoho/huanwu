import { z } from 'zod';
import { ProposalItemSnapshotSchema, ProposalTermsSchema } from './proposals.js';

const uuid = z.string().uuid().toLowerCase();
const positive = z.number().int().positive();
const fen = z.number().int().min(0).max(2_147_483_647);
const time = z.iso.datetime();
const nullableTime = time.nullable();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const OrderStatusSchema = z.enum([
  'AWAITING_DETAILS', 'AWAITING_PAYMENT', 'AWAITING_FULFILLMENT', 'IN_TRANSIT',
  'AWAITING_ACCEPTANCE', 'SETTLING', 'COMPLETED', 'CANCEL_PENDING', 'CANCELLED', 'ON_HOLD',
]);
export const OrderSideSchema = z.enum(['INITIATOR', 'RECIPIENT']);
export const PaymentPurposeSchema = z.enum(['DEPOSIT', 'DIFFERENCE']);
export const PaymentStatusSchema = z.enum(['CREATED', 'PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'UNKNOWN', 'FAILED']);
export const ShipmentStatusSchema = z.enum(['REGISTERED', 'COLLECTED', 'DELIVERED', 'EXCEPTION']);
export const OrderCancellationStatusSchema = z.enum(['REQUESTED', 'AGREED', 'REJECTED', 'WITHDRAWN', 'EXPIRED']);
export const OrderRulesSnapshotSchema = z.strictObject({
  version: text(1, 100), depositFen: fen, feeFen: fen,
  detailsHours: positive, paymentHours: positive, fulfillmentHours: positive, inspectionHours: positive,
});

const command = { expectedVersion: positive };
const address = { recipientName: text(1, 80), phone: text(5, 32), region: text(1, 200), detail: text(4, 500) };
const shipment = { carrier: text(2, 32).toUpperCase(), trackingNumber: text(3, 64).toUpperCase() };
export const OrderCommandSchema = z.strictObject(command);
export const OrderAddressSchema = z.strictObject({ ...command, ...address });
export const OrderPaymentSchema = z.strictObject({ ...command, purpose: PaymentPurposeSchema });
export const OrderShipmentSchema = z.strictObject({ ...command, ...shipment });
export const OrderIssueSchema = z.strictObject({ ...command, reason: text(4, 1000) });
export const OrderCancellationSchema = z.strictObject({ ...command, reason: text(4, 300) });
export const OrderCancellationRespondSchema = z.strictObject({
  ...command, cancellationId: uuid, decision: z.enum(['AGREE', 'REJECT']),
});
export const OrderCancellationWithdrawSchema = z.strictObject({ ...command, cancellationId: uuid });

// These are summary views: no provider payloads, checkout credentials or personal
// address fields can enter an order command result or its idempotency cache.
export const OrderPaymentViewSchema = z.strictObject({
  id: uuid, purpose: PaymentPurposeSchema, amountFen: fen.positive(), currency: z.literal('CNY'), status: PaymentStatusSchema,
});
export const OrderShipmentViewSchema = z.strictObject({
  id: uuid, ...shipment, status: ShipmentStatusSchema, registeredAt: time,
  collectedAt: nullableTime, deliveredAt: nullableTime,
});
export const OrderPartyViewSchema = z.strictObject({
  side: OrderSideSchema, userId: uuid, addressReady: z.boolean(),
  payments: z.array(OrderPaymentViewSchema).max(2).refine(payments => new Set(payments.map(p => p.purpose)).size === payments.length, 'Payment purposes must be unique'),
  outgoingShipment: OrderShipmentViewSchema.nullable(), incomingDeliveredAt: nullableTime,
  acceptanceDeadline: nullableTime, acceptedAt: nullableTime,
});
export const OrderCancellationViewSchema = z.strictObject({
  id: uuid, requestedBySide: OrderSideSchema, reason: text(4, 300),
  status: OrderCancellationStatusSchema, requestedAt: time, respondedAt: nullableTime,
});
export const OrderItemSnapshotSchema = z.strictObject({ ...ProposalItemSnapshotSchema.shape, side: OrderSideSchema });
export const OrderViewSchema = z.strictObject({
  id: uuid, proposalId: uuid, proposalVersionId: uuid, initiatorId: uuid, recipientId: uuid,
  status: OrderStatusSchema, version: positive, rules: OrderRulesSnapshotSchema,
  terms: ProposalTermsSchema, items: z.array(OrderItemSnapshotSchema).min(2).max(6),
  parties: z.array(OrderPartyViewSchema).length(2), cancellation: OrderCancellationViewSchema.nullable(),
  holdReason: text(1, 1000).nullable(), simulation: z.boolean(), detailsDeadline: nullableTime,
  paymentDeadline: nullableTime, fulfillmentDeadline: nullableTime, createdAt: time, updatedAt: time,
}).refine(order => {
  const initiatorItems = order.items.filter(item => item.side === 'INITIATOR');
  const recipientItems = order.items.filter(item => item.side === 'RECIPIENT');
  return order.initiatorId !== order.recipientId &&
    initiatorItems.length >= 1 && initiatorItems.length <= 5 && recipientItems.length === 1 &&
    new Set(order.items.map(item => item.itemId)).size === order.items.length &&
    order.items.every(item => item.ownerId === (item.side === 'INITIATOR' ? order.initiatorId : order.recipientId)) &&
    new Set(order.parties.map(party => party.side)).size === 2 &&
    order.parties.every(party => party.userId === (party.side === 'INITIATOR' ? order.initiatorId : order.recipientId));
}, 'Order snapshots and parties must match both participants');
export const OrderCommandResultSchema = z.strictObject({ order: OrderViewSchema, paymentIntentId: uuid.optional() });
export const OrderListViewSchema = z.strictObject({ items: z.array(OrderViewSchema), nextCursor: z.string().nullable() });
// Full address and temporary checkout parameters have separate authorized GETs.
export const OrderAddressViewSchema = z.strictObject({ orderId: uuid, side: OrderSideSchema, version: positive, ...address });
export const CheckoutViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('PENDING'), paymentIntentId: uuid }),
  z.strictObject({ status: z.literal('READY'), paymentIntentId: uuid, provider: text(1, 100), params: z.record(z.string(), z.string()) }),
]);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type OrderSide = z.infer<typeof OrderSideSchema>;
export type PaymentPurpose = z.infer<typeof PaymentPurposeSchema>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;
export type OrderCancellationStatus = z.infer<typeof OrderCancellationStatusSchema>;
export type OrderRulesSnapshot = z.infer<typeof OrderRulesSnapshotSchema>;
export type OrderCommandInput = z.infer<typeof OrderCommandSchema>;
export type OrderAddressInput = z.infer<typeof OrderAddressSchema>;
export type OrderPaymentInput = z.infer<typeof OrderPaymentSchema>;
export type OrderShipmentInput = z.infer<typeof OrderShipmentSchema>;
export type OrderIssueInput = z.infer<typeof OrderIssueSchema>;
export type OrderCancellationInput = z.infer<typeof OrderCancellationSchema>;
export type OrderCancellationRespondInput = z.infer<typeof OrderCancellationRespondSchema>;
export type OrderCancellationWithdrawInput = z.infer<typeof OrderCancellationWithdrawSchema>;
export type OrderPaymentView = z.infer<typeof OrderPaymentViewSchema>;
export type OrderShipmentView = z.infer<typeof OrderShipmentViewSchema>;
export type OrderPartyView = z.infer<typeof OrderPartyViewSchema>;
export type OrderCancellationView = z.infer<typeof OrderCancellationViewSchema>;
export type OrderItemSnapshot = z.infer<typeof OrderItemSnapshotSchema>;
export type OrderView = z.infer<typeof OrderViewSchema>;
export type OrderCommandResult = z.infer<typeof OrderCommandResultSchema>;
export type OrderListView = z.infer<typeof OrderListViewSchema>;
export type OrderAddressView = z.infer<typeof OrderAddressViewSchema>;
export type CheckoutView = z.infer<typeof CheckoutViewSchema>;
