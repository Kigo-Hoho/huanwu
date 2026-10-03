import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { VerifiedIntegrationEvent } from '../integrations/integration.types.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { OrderCancellationService } from '../orders/order-cancellation.service.js';
import { readOrder } from '../orders/order-reader.js';
import { ReservationsService } from '../reservations/reservations.service.js';

@Injectable()
export class PaymentEventsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(OrderCancellationService) private readonly cancellation: OrderCancellationService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}
  async applyVerified(event: VerifiedIntegrationEvent): Promise<void> {
    if (event.kind === 'SHIPMENT_PROGRESS') throw new BadRequestException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Expected a financial event' });
    const effect = event.kind === 'PAYMENT_SUCCEEDED' ? null : await this.prisma.outboxCommand.findUnique({ where: { businessNo: event.businessNo } });
    const originalNo = effect ? (effect.payload as Prisma.JsonObject).paymentBusinessNo : event.businessNo;
    const association = typeof originalNo === 'string' ? await this.prisma.paymentIntent.findUnique({ where: { businessNo: originalNo } }) : null;
    await this.prisma.$transaction(async tx => {
      if (association) {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${association.orderId}::uuid FOR UPDATE`;
        const order = await readOrder(tx, association.orderId);
        if (!order) throw new Error('Payment order is missing');
        await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${event.provider}:${event.externalTransactionId}`}, 0))::text`;
        await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${order.id}::uuid ORDER BY id FOR UPDATE`;
      }
      // Keep the exact signed amount in immutable JSON even when it cannot fit the
      // optional integer projection. It can never match a valid persisted obligation.
      const inserted = await tx.integrationEvent.createMany({ data: [{ ...event, amountFen: event.amountFen <= 2_147_483_647 ? event.amountFen : null, occurredAt: new Date(event.occurredAt), payload: event as unknown as Prisma.InputJsonObject }], skipDuplicates: true });
      const recorded = await tx.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, include: { receipt: true } });
      if (!inserted.count) {
        if (!isDeepStrictEqual(recorded.payload, event)) throw new BadRequestException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Event identity has conflicting content' });
        if (recorded.receipt?.status !== 'PENDING') return;
      }
      const now = this.clock.now();
      const receipt = async (status: 'PROCESSED' | 'REJECTED' | 'PENDING', reason: string | null = null) => {
        await tx.integrationEventReceipt.upsert({ where: { eventId: recorded.id }, create: { eventId: recorded.id, status, reason, processedAt: now }, update: { status, reason, processedAt: now } });
      };
      const reject = async (reason: string, hold = false) => {
        await receipt('REJECTED', reason);
        if (hold && association) {
          const current = await tx.order.findUniqueOrThrow({ where: { id: association.orderId } });
          if (!['CANCELLED', 'COMPLETED', 'ON_HOLD'].includes(current.status)) {
            await tx.order.update({ where: { id: current.id }, data: { status: 'ON_HOLD', holdReason: reason, holdPreviousStatus: current.status, heldAt: now, version: { increment: 1 } } });
            await this.audit.record(tx, { actorId: null, action: 'ORDER_FINANCIAL_ANOMALY', entityType: 'Order', entityId: current.id, after: { reason, eventId: recorded.id } });
          }
        }
        await this.audit.record(tx, { actorId: null, action: 'PAYMENT_EVENT_QUARANTINED', entityType: 'IntegrationEvent', entityId: recorded.id, after: { reason } });
      };
      if (!association) { await reject('UNKNOWN_BUSINESS_NUMBER'); return; }
      const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: association.id } });
      const expectedEffect = event.kind === 'PAYMENT_CLOSED' ? 'CLOSE_PAYMENT' : event.kind === 'REFUND_SUCCEEDED' ? 'REFUND_PAYMENT' : null;
      if (event.provider !== intent.provider || event.currency !== 'CNY' || event.amountFen !== intent.amountFen ||
        (event.kind !== 'PAYMENT_SUCCEEDED' && (!effect || !expectedEffect || effect.kind !== expectedEffect || effect.orderId !== intent.orderId || effect.businessNo !== `${event.kind === 'PAYMENT_CLOSED' ? 'close' : 'refund'}:${intent.id}` || (effect.payload as Prisma.JsonObject).amountFen !== intent.amountFen || (effect.payload as Prisma.JsonObject).currency !== 'CNY'))) { await reject('OBLIGATION_MISMATCH'); return; }
      let order = (await readOrder(tx, intent.orderId))!;
      const ledger = await tx.financialEntry.findMany({ where: { intentId: intent.id } });
      if (event.kind === 'PAYMENT_CLOSED') {
        if (ledger.length || intent.paidAt || intent.refundedAt) { await reject('CLOSE_CONTRADICTS_PAYMENT', true); return; }
        if (intent.status === 'CLOSED' && intent.closedAt) { await receipt('PROCESSED'); return; }
        await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'CLOSED', closedAt: new Date(event.occurredAt) } });
        await receipt('PROCESSED', order.status === 'ON_HOLD' ? 'ORDER_ON_HOLD' : null);
        const finalized = await this.cancellation.tryFinalize(tx, order.id, now);
        if (!finalized) await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
        await this.audit.record(tx, { actorId: null, action: 'ORDER_PAYMENT_CLOSED', entityType: 'PaymentIntent', entityId: intent.id, after: { eventId: recorded.id } });
        return;
      }
      const entryType = event.kind === 'PAYMENT_SUCCEEDED' ? 'PAYMENT' : 'REFUND';
      if (entryType === 'REFUND' && !ledger.some(entry => entry.entryType === 'PAYMENT')) {
        await receipt('PENDING', 'PAYMENT_NOT_RECORDED');
        await this.audit.record(tx, { actorId: null, action: 'PAYMENT_EVENT_DEFERRED', entityType: 'IntegrationEvent', entityId: recorded.id, after: { reason: 'PAYMENT_NOT_RECORDED' } });
        return;
      }
      if (entryType === 'REFUND' && ledger.some(entry => entry.entryType === 'DIFFERENCE_SETTLEMENT')) { await reject('REFUND_CONTRADICTS_SETTLEMENT'); return; }
      const previous = await tx.financialEntry.findFirst({ where: { OR: [{ intentId: intent.id, entryType }, { provider: event.provider, externalTransactionId: event.externalTransactionId, entryType }] } });
      if (previous) {
        if (previous.intentId !== intent.id || previous.externalTransactionId !== event.externalTransactionId) await reject('TRANSACTION_CONFLICT');
        else {
          await receipt('PROCESSED');
          await this.audit.record(tx, { actorId: null, action: 'PAYMENT_EVENT_DUPLICATE', entityType: 'IntegrationEvent', entityId: recorded.id });
        }
        return;
      }
      await tx.financialEntry.create({ data: { intentId: intent.id, integrationEventId: recorded.id, entryType, provider: event.provider, externalTransactionId: event.externalTransactionId, businessNo: event.businessNo, amountFen: intent.amountFen, currency: 'CNY', occurredAt: new Date(event.occurredAt) } });
      if (entryType === 'REFUND') {
        await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'REFUNDED', refundedAt: new Date(event.occurredAt) } });
        await receipt('PROCESSED', order.status === 'ON_HOLD' ? 'ORDER_ON_HOLD' : null);
        const finalized = await this.cancellation.tryFinalize(tx, order.id, now);
        if (!finalized) await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
        await this.audit.record(tx, { actorId: null, action: 'ORDER_REFUND_CONFIRMED', entityType: 'PaymentIntent', entityId: intent.id, after: { eventId: recorded.id, amountFen: intent.amountFen, currency: 'CNY' } });
        return;
      }
      if (intent.closedAt || intent.status === 'CLOSED') {
        await tx.paymentIntent.update({ where: { id: intent.id }, data: { paidAt: new Date(event.occurredAt), externalTransactionId: event.externalTransactionId } });
        await reject('PAYMENT_AFTER_CLOSED');
        if (!['CANCELLED', 'COMPLETED', 'ON_HOLD'].includes(order.status)) await tx.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'PAYMENT_AFTER_CLOSED', holdPreviousStatus: order.status, heldAt: now, version: { increment: 1 } } });
        await this.audit.record(tx, { actorId: null, action: 'ORDER_PAYMENT_CONFIRMED', entityType: 'PaymentIntent', entityId: intent.id, after: { eventId: recorded.id, amountFen: intent.amountFen, currency: 'CNY', anomaly: 'PAYMENT_AFTER_CLOSED' } });
        return;
      }
      await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'PAID', paidAt: new Date(event.occurredAt), externalTransactionId: event.externalTransactionId } });
      order = (await readOrder(tx, intent.orderId))!;
      if (order.status === 'AWAITING_PAYMENT' && order.paymentDeadline && now >= order.paymentDeadline) {
        await this.cancellation.begin(tx, order, 'PAYMENT_TIMEOUT', null, now);
        order = (await readOrder(tx, order.id))!;
      }
      if (order.status === 'CANCEL_PENDING') {
        await this.outbox.enqueue(tx, { orderId: order.id, kind: 'REFUND_PAYMENT', businessNo: `refund:${intent.id}`, payload: { paymentBusinessNo: intent.businessNo, amountFen: intent.amountFen, currency: 'CNY' } });
      } else if (order.status === 'AWAITING_PAYMENT') {
        const payments = await tx.paymentIntent.findMany({ where: { orderId: order.id }, include: { entries: true } });
        for (const side of ['INITIATOR', 'RECIPIENT'] as const) {
          const purposes = order.differenceFen > 0 && order.payer === side ? ['DEPOSIT', 'DIFFERENCE'] : ['DEPOSIT'];
          const ready = purposes.every(purpose => payments.some(payment => payment.side === side && payment.purpose === purpose && payment.status === 'PAID' && payment.entries.some(entry => entry.entryType === 'PAYMENT' && entry.amountFen === payment.amountFen && entry.currency === 'CNY')));
          await tx.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side } }, data: { fundsReady: ready } });
        }
        const parties = await tx.orderPartyProgress.findMany({ where: { orderId: order.id } });
        if (parties.length === 2 && parties.every(party => party.fundsReady)) await tx.order.update({ where: { id: order.id }, data: { status: 'AWAITING_FULFILLMENT', paymentDeadline: null, fulfillmentDeadline: new Date(now.getTime() + order.fulfillmentHours * 3600000) } });
      }
      await receipt('PROCESSED', order.status === 'ON_HOLD' ? 'ORDER_ON_HOLD' : null);
      await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      await this.audit.record(tx, { actorId: null, action: 'ORDER_PAYMENT_CONFIRMED', entityType: 'PaymentIntent', entityId: intent.id, after: { eventId: recorded.id, amountFen: intent.amountFen, currency: 'CNY' } });
    });
    if (event.kind === 'PAYMENT_SUCCEEDED' && association) {
      const waiting = await this.prisma.integrationEvent.findMany({ where: { businessNo: `refund:${association.id}`, receipt: { status: 'PENDING', reason: 'PAYMENT_NOT_RECORDED' } } });
      for (const pending of waiting) await this.applyVerified(pending.payload as unknown as VerifiedIntegrationEvent);
    }
  }
}
