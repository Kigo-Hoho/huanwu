import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { OrderCancellationEngine } from './order-cancellation-engine.service.js';
import { OrderHoldService } from './order-hold.service.js';
import { mapOrder, type OrderTx } from './order.mapper.js';
import { dueDeadline } from './order-policy.js';
import { readOrder } from './order-reader.js';

@Injectable()
export class OrderExpiryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(OrderCancellationEngine) private readonly cancellation: OrderCancellationEngine,
    @Inject(OrderHoldService) private readonly hold: OrderHoldService,
  ) {}
  async reconcile(id: string): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id}::uuid FOR UPDATE`;
      const order = await readOrder(tx, id);
      if (!order || !dueDeadline(mapOrder(order), this.clock.now())) return false;
      await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${id}::uuid ORDER BY id FOR UPDATE`;
      const changed = await this.reconcileLocked(tx, id);
      if (changed) await tx.order.update({ where: { id }, data: { version: { increment: 1 } } });
      return changed;
    });
  }
  // Internal supplied-tx seam. Caller holds order -> sorted items -> relevant
  // financial/associated rows, and owns the one revision for its actual change.
  // Never opens a nested transaction or performs an external request.
  async reconcileLocked(tx: OrderTx, id: string): Promise<boolean> {
    const order = await readOrder(tx, id);
    if (!order) return false;
    const now = this.clock.now(); const due = dueDeadline(mapOrder(order), now);
    if (!due) return false;
    if (due === 'DETAILS' || due === 'PAYMENT') await this.cancellation.begin(tx, order, `${due}_TIMEOUT`, null, now);
    else await this.hold.enter(tx, order, `${due}_TIMEOUT`, now);
    return true;
  }
  async reconcileDue(): Promise<void> {
    const now = this.clock.now();
    const orders = await this.prisma.order.findMany({ where: { OR: [
      { status: 'AWAITING_DETAILS', detailsDeadline: { lte: now } },
      { status: 'AWAITING_PAYMENT', paymentDeadline: { lte: now } },
      { status: 'AWAITING_FULFILLMENT', fulfillmentDeadline: { lte: now } },
      { status: { in: ['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'] }, parties: { some: { acceptedAt: null, acceptanceDeadline: { lte: now } } } },
    ] }, select: { id: true }, orderBy: { id: 'asc' } });
    for (const order of orders) await this.reconcile(order.id);
  }
}
