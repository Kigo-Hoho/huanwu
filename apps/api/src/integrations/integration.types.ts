import type { IntegrationOperationKind, Prisma, ShipmentStatus } from '../generated/prisma/client.js';

export interface ProviderOperation { businessNo: string; orderId: string; kind: IntegrationOperationKind; payload: Prisma.InputJsonObject }
export interface PaymentOperationPayload { amountFen: number; currency: 'CNY' }
export interface PaymentEffectPayload extends PaymentOperationPayload { paymentBusinessNo: string }
export interface ShipmentOperationPayload { shipmentId: string; carrier: string; trackingNumber: string }
interface EventIdentity { provider: string; eventId: string; businessNo: string; occurredAt: string }
export type VerifiedIntegrationEvent = EventIdentity & (
  | { kind: 'PAYMENT_SUCCEEDED' | 'PAYMENT_CLOSED' | 'REFUND_SUCCEEDED' | 'DIFFERENCE_SETTLED'; externalTransactionId: string; amountFen: number; currency: 'CNY' }
  | { kind: 'SHIPMENT_PROGRESS'; shipmentId: string; progress: ShipmentStatus }
);
export type ProviderResult =
  | { status: 'SUCCESS'; externalTransactionId: string; event: VerifiedIntegrationEvent }
  | { status: 'PENDING' | 'UNKNOWN'; reason?: string }
  | { status: 'FAILURE'; reason: string };

export interface IntegrationOperationHandler {
  // A short locked authorization transaction, never held over provider I/O.
  // Missing/false gates execute only: existing facts must still be reconciled.
  authorize?(operation: ProviderOperation): Promise<boolean>;
  query(operation: ProviderOperation): Promise<ProviderResult>;
  execute(operation: ProviderOperation): Promise<ProviderResult>;
  // Must be idempotent under replay/expired leases, with its own audited transaction.
  apply(operation: ProviderOperation, result: ProviderResult): Promise<void>;
}
