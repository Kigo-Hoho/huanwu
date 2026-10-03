import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { mapOrder, type LockedOrder, type OrderTx } from '../orders/order.mapper.js';
import { dueDeadline } from '../orders/order-policy.js';
import { readOrder } from '../orders/order-reader.js';
import { ReservationsService } from '../reservations/reservations.service.js';

@Injectable()
export class SettlementService {
  constructor(
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  // Supplied transaction; caller holds Order and owns its single command revision.
  async begin(tx: OrderTx, order: LockedOrder, now: Date): Promise<void> {
    await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
    const payments = await this.lockPayments(tx, order.id);
    order = (await readOrder(tx, order.id))!;
    now = this.clock.now();
    if (dueDeadline(mapOrder(order), now)) throw new ConflictException({ code: 'ORDER_EXPIRED', message: 'Order deadline has passed' });
    if (!['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status) || !this.accepted(order) || order.cancellations.some(c => c.status === 'REQUESTED')) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Both valid acceptances are required' });
    if (!this.obligations(order, payments) || payments.some(p => p.status !== 'PAID' || !p.paidAt || p.closedAt || p.entries.length !== 1 || !this.entry(p, 'PAYMENT'))) throw new ConflictException({ code: 'ORDER_PAYMENT_NOT_READY', message: 'Original funding must be confirmed and undisposed' });
    await tx.order.update({ where: { id: order.id }, data: { status: 'SETTLING', fulfillmentDeadline: null } });
    for (const payment of payments) {
      const deposit = payment.purpose === 'DEPOSIT';
      await this.outbox.enqueue(tx, { orderId: order.id, kind: deposit ? 'REFUND_PAYMENT' : 'SETTLE_DIFFERENCE', businessNo: `${deposit ? 'refund' : 'settle'}:${payment.id}`, payload: { paymentBusinessNo: payment.businessNo, amountFen: payment.amountFen, currency: 'CNY' } });
    }
    await this.audit.record(tx, { actorId: null, action: 'ORDER_SETTLING', entityType: 'Order', entityId: order.id, before: { status: order.status }, after: { status: 'SETTLING', startedAt: now.toISOString() } });
  }
  // Event callers already lock order -> sorted items/leases -> funds. True owns
  // one terminal revision; false performs no mutation. No network/nested tx.
  async tryFinalize(tx: OrderTx, orderId: string, now: Date): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
    let order = await readOrder(tx, orderId);
    if (!order || order.status !== 'SETTLING') return false;
    await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
    const payments = await this.lockPayments(tx, orderId);
    order = await readOrder(tx, orderId); now = this.clock.now();
    if (!order || order.status !== 'SETTLING' || !this.accepted(order) || order.cancellations.some(c => c.status === 'REQUESTED') || !this.obligations(order, payments)) return false;
    if (payments.some(p => !p.paidAt || p.closedAt || !this.entry(p, 'PAYMENT') || p.entries.length !== 2 || (p.purpose === 'DEPOSIT' ? p.status !== 'REFUNDED' || !p.refundedAt || !this.entry(p, 'REFUND') : p.status !== 'PAID' || !this.entry(p, 'DIFFERENCE_SETTLEMENT')))) return false;
    const ids = order.items.map(item => item.itemId);
    const items = await tx.item.findMany({ where: { id: { in: ids } }, include: { reservation: true } });
    const leases = await tx.itemReservation.findMany({ where: { orderId } });
    if (ids.length < 2 || ids.length > 6 || items.length !== ids.length || leases.length !== ids.length || items.some(item => item.status !== 'ACTIVE' || item.ownerId !== order!.items.find(snapshot => snapshot.itemId === item.id)?.ownerId || item.reservation?.orderId !== orderId)) return false;
    await tx.item.updateMany({ where: { id: { in: ids } }, data: { status: 'INACTIVE', version: { increment: 1 } } });
    await this.reservations.releaseOrder(tx, orderId);
    await tx.order.update({ where: { id: orderId }, data: { status: 'COMPLETED', version: { increment: 1 } } });
    await this.audit.record(tx, { actorId: null, action: 'ORDER_COMPLETED', entityType: 'Order', entityId: orderId, before: { status: 'SETTLING' }, after: { status: 'COMPLETED', completedAt: now.toISOString(), itemIds: ids } });
    return true;
  }
  private accepted(order: LockedOrder): boolean {
    return order.parties.length === 2 && order.parties.every(p => p.incomingDeliveredAt && p.acceptanceDeadline && p.acceptedAt && p.acceptedAt >= p.incomingDeliveredAt && p.acceptedAt < p.acceptanceDeadline);
  }
  private async lockPayments(tx: OrderTx, orderId: string) {
    await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${orderId}::uuid ORDER BY id FOR UPDATE`;
    return tx.paymentIntent.findMany({ where: { orderId }, orderBy: { id: 'asc' }, include: { entries: true } });
  }
  private obligations(order: LockedOrder, payments: Awaited<ReturnType<SettlementService['lockPayments']>>): boolean {
    return payments.length === (order.differenceFen > 0 ? 3 : 2) && ['INITIATOR', 'RECIPIENT'].every(side => payments.some(p => p.side === side && p.purpose === 'DEPOSIT' && p.amountFen === order.depositFen && p.currency === 'CNY')) && (!order.differenceFen || payments.some(p => p.side === order.payer && p.purpose === 'DIFFERENCE' && p.amountFen === order.differenceFen && p.currency === 'CNY'));
  }
  private entry(payment: Awaited<ReturnType<SettlementService['lockPayments']>>[number], kind: 'PAYMENT' | 'REFUND' | 'DIFFERENCE_SETTLEMENT'): boolean {
    return payment.entries.some(e => e.entryType === kind && e.amountFen === payment.amountFen && e.currency === 'CNY' && e.provider === payment.provider && e.businessNo === (kind === 'PAYMENT' ? payment.businessNo : `${kind === 'REFUND' ? 'refund' : 'settle'}:${payment.id}`));
  }
}
