import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { mapOrder, type LockedOrder, type OrderTx } from './order.mapper.js';
import { dueDeadline } from './order-policy.js';
import { readOrder } from './order-reader.js';

function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }
function assertNoHandoff(order: LockedOrder): void {
  if (order.shipments.length || order.parties.some(party => party.handedOverAt || party.incomingDeliveredAt || party.acceptedAt)) {
    conflict('ORDER_FULFILLMENT_STARTED', 'Order fulfillment has already started');
  }
}
export function assertNegotiable(order: LockedOrder): void {
  if (!['AWAITING_DETAILS', 'AWAITING_PAYMENT', 'AWAITING_FULFILLMENT'].includes(order.status)) {
    conflict('ORDER_INVALID_STATE', 'Order does not allow cancellation negotiation');
  }
  assertNoHandoff(order);
}

@Injectable()
export class OrderCancellationEngine {
  constructor(
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Caller holds the order lock and owns its revision increment (commands or expiry).
  // Acquire sorted item locks BEFORE financial locks; no provider is invoked here.
  async begin(tx: OrderTx, order: LockedOrder, reason: string, actorId: string | null, now: Date): Promise<void> {
    assertNegotiable(order);
    await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
    const payments = await this.lockPayments(tx, order.id);
    now = this.clock.now();
    if (actorId !== null && dueDeadline(mapOrder(order), now)) conflict('ORDER_EXPIRED', 'Order command deadline has passed');
    const entries = await tx.financialEntry.findMany({ where: { intentId: { in: payments.map(payment => payment.id) } } });
    const pending = await tx.orderCancellation.findFirst({ where: { orderId: order.id, status: 'REQUESTED' } });
    if (pending) {
      await tx.orderCancellation.update({ where: { id: pending.id }, data: { status: 'EXPIRED', respondedAt: now } });
      await this.audit.record(tx, { actorId, action: 'ORDER_CANCELLATION_EXPIRED', entityType: 'OrderCancellation', entityId: pending.id, before: { status: 'REQUESTED' }, after: { status: 'EXPIRED' } });
    }
    await tx.order.update({ where: { id: order.id }, data: { status: 'CANCEL_PENDING' } });
    for (const payment of payments) {
      const paid = payment.status === 'PAID' || entries.some(entry => entry.intentId === payment.id && entry.entryType === 'PAYMENT');
      if (payment.status === 'REFUNDED' || (payment.status === 'CLOSED' && !paid)) continue;
      const kind = paid ? 'REFUND_PAYMENT' as const : 'CLOSE_PAYMENT' as const;
      await this.outbox.enqueue(tx, { orderId: order.id, kind, businessNo: `${kind === 'REFUND_PAYMENT' ? 'refund' : 'close'}:${payment.id}`, payload: { paymentBusinessNo: payment.businessNo, amountFen: payment.amountFen, currency: 'CNY' } });
    }
    await this.audit.record(tx, { actorId, action: 'ORDER_CANCEL_PENDING', entityType: 'Order', entityId: order.id, before: { status: order.status }, after: { status: 'CANCEL_PENDING', reason } });
    await this.finalizeLocked(tx, order, payments, entries, actorId, now, false);
  }

  // Same supplied transaction, no root transaction. Event consumers must acquire
  // order -> sorted items/reservations BEFORE intent locks; a successful finalize
  // owns ONE revision increment, so callers must not increment again for it.
  async tryFinalize(tx: OrderTx, orderId: string, now: Date): Promise<boolean> {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    let order = await readOrder(tx, orderId);
    if (!order || order.status !== 'CANCEL_PENDING') return false;
    if (order.shipments.length || order.parties.some(party => party.handedOverAt || party.incomingDeliveredAt || party.acceptedAt)) return false;
    await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
    order = await readOrder(tx, orderId);
    if (!order || order.status !== 'CANCEL_PENDING') return false;
    const payments = await this.lockPayments(tx, orderId);
    now = this.clock.now();
    const entries = await tx.financialEntry.findMany({ where: { intentId: { in: payments.map(payment => payment.id) } } });
    return this.finalizeLocked(tx, order, payments, entries, null, now, true);
  }

  private async lockPayments(tx: OrderTx, orderId: string) {
    await tx.$queryRaw`SELECT "id" FROM "PaymentIntent" WHERE "orderId" = ${orderId}::uuid ORDER BY "id" FOR UPDATE`;
    return tx.paymentIntent.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
  }

  private async finalizeLocked(
    tx: OrderTx, order: LockedOrder,
    payments: Awaited<ReturnType<OrderCancellationEngine['lockPayments']>>,
    entries: Awaited<ReturnType<OrderTx['financialEntry']['findMany']>>,
    actorId: string | null, now: Date, incrementVersion: boolean,
  ): Promise<boolean> {
    assertNoHandoff(order);
    const safe = payments.every(payment => {
      const ledger = entries.filter(entry => entry.intentId === payment.id);
      if (ledger.some(entry => entry.entryType === 'DIFFERENCE_SETTLEMENT')) return false;
      if (payment.status === 'CLOSED') return payment.closedAt !== null && ledger.length === 0;
      if (payment.status !== 'REFUNDED' || !payment.refundedAt) return false;
      const paid = ledger.find(entry => entry.entryType === 'PAYMENT');
      const refund = ledger.find(entry => entry.entryType === 'REFUND');
      return !!paid && !!refund && paid.amountFen === payment.amountFen && refund.amountFen === payment.amountFen && paid.currency === 'CNY' && refund.currency === 'CNY';
    });
    if (!safe) return false;
    await this.reservations.releaseOrder(tx, order.id);
    await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', ...(incrementVersion ? { version: { increment: 1 } } : {}) } });
    await this.audit.record(tx, { actorId, action: 'ORDER_CANCELLED', entityType: 'Order', entityId: order.id, before: { status: 'CANCEL_PENDING' }, after: { status: 'CANCELLED', cancelledAt: now.toISOString() } });
    return true;
  }
}
