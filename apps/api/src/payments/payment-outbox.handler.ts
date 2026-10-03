import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../integrations/integration-config.js';
import type { IntegrationOperationHandler, ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
import { OutboxHandlerRegistry } from '../integrations/outbox-handler.registry.js';
import { PAYMENT_PORT, type PaymentPort } from './payment.port.js';
import { PaymentEventsService } from './payment-events.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OrderCancellationService } from '../orders/order-cancellation.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { readOrder } from '../orders/order-reader.js';

@Injectable()
export class PaymentOutboxHandler implements IntegrationOperationHandler, OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_PORT) private readonly port: PaymentPort,
    @Inject(PaymentEventsService) private readonly events: PaymentEventsService,
    @Inject(OutboxHandlerRegistry) private readonly registry: OutboxHandlerRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration,
    @Inject(OrderCancellationService) private readonly cancellation: OrderCancellationService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
  ) {}
  onModuleInit(): void { for (const kind of ['CREATE_PAYMENT', 'CLOSE_PAYMENT', 'REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] as const) this.registry.register(kind, this); }
  async authorize(operation: ProviderOperation): Promise<boolean> {
    if (this.config.payment === 'disabled') return false;
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${operation.orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: operation.orderId } });
      if (!order) return false;
      const originalNo = operation.kind === 'CREATE_PAYMENT' ? operation.businessNo : operation.payload.paymentBusinessNo;
      if (typeof originalNo !== 'string') return false;
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "businessNo" = ${originalNo} FOR UPDATE`;
      const intent = await tx.paymentIntent.findUnique({ where: { businessNo: originalNo } });
      if (!intent || intent.orderId !== order.id || intent.amountFen !== operation.payload.amountFen || operation.payload.currency !== 'CNY') return false;
      if (operation.kind === 'CREATE_PAYMENT') {
        if (order.status !== 'AWAITING_PAYMENT' || !['CREATED', 'PENDING'].includes(intent.status) || !order.paymentDeadline || this.clock.now() >= order.paymentDeadline) return false;
      } else {
        const kind = operation.kind === 'CLOSE_PAYMENT' ? 'close' : operation.kind === 'REFUND_PAYMENT' ? 'refund' : operation.kind === 'SETTLE_DIFFERENCE' ? 'settle' : null;
        if (!kind || operation.businessNo !== `${kind}:${intent.id}`) return false;
        if (order.status === 'SETTLING') {
          if (kind === 'close' || (kind === 'refund' && intent.purpose !== 'DEPOSIT') || (kind === 'settle' && (intent.purpose !== 'DIFFERENCE' || !order.differenceFen || intent.side !== order.payer || intent.amountFen !== order.differenceFen))) return false;
          if (await tx.orderCancellation.count({ where: { orderId: order.id, status: 'REQUESTED' } })) return false;
          const parties = await tx.orderPartyProgress.findMany({ where: { orderId: order.id } });
          if (parties.length !== 2 || parties.some(p => !p.incomingDeliveredAt || !p.acceptedAt)) return false;
        } else if (order.status !== 'CANCEL_PENDING' || kind === 'settle') return false;
        const ledger = await tx.financialEntry.findMany({ where: { intentId: intent.id } });
        if (kind === 'close' && (ledger.length || ['PAID', 'REFUNDED', 'CLOSED'].includes(intent.status))) return false;
        if (kind !== 'close' && (intent.status !== 'PAID' || !ledger.some(entry => entry.entryType === 'PAYMENT' && entry.amountFen === intent.amountFen && entry.currency === 'CNY') || ledger.some(entry => entry.entryType !== 'PAYMENT'))) return false;
        const previous = order.outstandingObligations as Prisma.JsonObject | null;
        const admitted = Array.isArray(previous?.financialOperations) ? previous.financialOperations as string[] : [];
        if (!admitted.includes(operation.businessNo)) {
          await tx.order.update({ where: { id: order.id }, data: { outstandingObligations: { ...previous, financialOperations: [...admitted, operation.businessNo] }, version: { increment: 1 } } });
          await this.audit.record(tx, { actorId: null, action: 'ORDER_FINANCIAL_OPERATION_ADMITTED', entityType: 'PaymentIntent', entityId: intent.id, after: { businessNo: operation.businessNo, kind: operation.kind } });
        }
      }
      if (operation.kind === 'CREATE_PAYMENT' && intent.status === 'CREATED') {
        await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'PENDING' } });
        await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
        await this.audit.record(tx, { actorId: null, action: 'ORDER_PAYMENT_ADMITTED', entityType: 'PaymentIntent', entityId: intent.id, after: { status: 'PENDING' } });
      }
      return true;
    });
  }
  async query(operation: ProviderOperation): Promise<ProviderResult> {
    const result = await (operation.kind === 'REFUND_PAYMENT' ? this.port.queryRefund(operation.businessNo) : operation.kind === 'SETTLE_DIFFERENCE' ? this.port.querySettlement(operation.businessNo) : this.port.queryPayment(operation.businessNo));
    if (operation.kind !== 'CLOSE_PAYMENT' || result.status !== 'FAILURE' || result.reason !== 'NOT_FOUND') return result;
    const originalNo = operation.payload.paymentBusinessNo;
    if (typeof originalNo !== 'string') return { status: 'UNKNOWN', reason: 'ORIGINAL_PAYMENT_UNRESOLVED' };
    const original = await this.port.queryPayment(originalNo);
    if (original.status === 'PENDING') return result;
    if (original.status === 'SUCCESS') {
      const intent = await this.prisma.paymentIntent.findUnique({ where: { businessNo: originalNo } });
      if (intent?.status === 'REFUNDED') return { status: 'FAILURE', reason: 'PAYMENT_ALREADY_REFUNDED' };
      return { status: 'UNKNOWN', reason: 'ORIGINAL_PAYMENT_SUCCEEDED' };
    }
    if (original.status === 'FAILURE' && original.reason === 'NOT_FOUND' && await this.closeAbsent(operation, false)) return { status: 'FAILURE', reason: 'ORIGINAL_PAYMENT_NOT_FOUND' };
    return { status: 'UNKNOWN', reason: 'ORIGINAL_PAYMENT_UNRESOLVED' };
  }
  execute(operation: ProviderOperation): Promise<ProviderResult> {
    if (operation.kind === 'CREATE_PAYMENT') return this.port.createPayment(operation);
    if (operation.kind === 'CLOSE_PAYMENT') return this.port.closePayment(operation);
    if (operation.kind === 'SETTLE_DIFFERENCE') return this.port.settleDifference(operation);
    return this.port.refundPayment(operation);
  }
  async apply(operation: ProviderOperation, result: ProviderResult): Promise<void> {
    if (result.status === 'SUCCESS') {
      const expectedKind = operation.kind === 'CREATE_PAYMENT' ? 'PAYMENT_SUCCEEDED' : operation.kind === 'CLOSE_PAYMENT' ? 'PAYMENT_CLOSED' : operation.kind === 'SETTLE_DIFFERENCE' ? 'DIFFERENCE_SETTLED' : 'REFUND_SUCCEEDED';
      if (result.event.kind === 'SHIPMENT_PROGRESS' || result.event.businessNo !== operation.businessNo || result.event.kind !== expectedKind || result.externalTransactionId !== result.event.externalTransactionId) throw new Error('Provider result does not match the queried financial operation');
      await this.events.applyVerified(result.event);
    }
    else if (operation.kind === 'CLOSE_PAYMENT' && result.status === 'FAILURE' && result.reason === 'ORIGINAL_PAYMENT_NOT_FOUND') {
      if (!await this.closeAbsent(operation, true)) throw new Error('Absence proof no longer holds');
    } else if (operation.kind === 'CLOSE_PAYMENT' && result.status === 'UNKNOWN' && result.reason === 'ORIGINAL_PAYMENT_SUCCEEDED') {
      const original = await this.port.queryPayment(operation.payload.paymentBusinessNo as string);
      if (original.status === 'SUCCESS') {
        if (original.event.kind !== 'PAYMENT_SUCCEEDED' || original.event.businessNo !== operation.payload.paymentBusinessNo || original.externalTransactionId !== original.event.externalTransactionId) throw new Error('Original payment query returned an unrelated result');
        await this.events.applyVerified(original.event);
      }
    }
  }
  private closeAbsent(operation: ProviderOperation, apply: boolean): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${operation.orderId}::uuid FOR UPDATE`;
      const order = await readOrder(tx, operation.orderId); if (!order) return false;
      await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${order.id}::uuid ORDER BY id FOR UPDATE`;
      const intent = await tx.paymentIntent.findUnique({ where: { businessNo: operation.payload.paymentBusinessNo as string } });
      if (!intent || intent.orderId !== order.id || operation.businessNo !== `close:${intent.id}` || operation.payload.amountFen !== intent.amountFen || operation.payload.currency !== 'CNY') return false;
      if (intent.status === 'CLOSED' && await tx.auditLog.count({ where: { entityId: intent.id, action: 'ORDER_PAYMENT_CLOSED_WITHOUT_EXTERNAL_INTENT' } })) return true;
      if (order.status !== 'CANCEL_PENDING' || intent.status !== 'CREATED') return false;
      // This immutable admission audit is committed before any possible CREATE sender.
      if (await tx.auditLog.count({ where: { entityId: intent.id, action: 'ORDER_PAYMENT_ADMITTED' } }) || await tx.financialEntry.count({ where: { intentId: intent.id } })) return false;
      if (!apply) return true;
      const now = this.clock.now();
      await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'CLOSED', closedAt: now } });
      await this.audit.record(tx, { actorId: null, action: 'ORDER_PAYMENT_CLOSED_WITHOUT_EXTERNAL_INTENT', entityType: 'PaymentIntent', entityId: intent.id, after: { businessNo: intent.businessNo, proof: 'NOT_FOUND_AND_NEVER_ADMITTED' } });
      if (!await this.cancellation.tryFinalize(tx, order.id, now)) await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      return true;
    });
  }
}
