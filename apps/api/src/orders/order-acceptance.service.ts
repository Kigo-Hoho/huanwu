import type { OrderCommandInput, OrderCommandResult, OrderIssueInput } from '@barter/contracts';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { SettlementService } from '../payments/settlement.service.js';
import { OrderCommandsService } from './order-commands.service.js';
import { OrderHoldService } from './order-hold.service.js';
import { mapOrder, type LockedOrder, type OrderTx } from './order.mapper.js';
import { dueDeadline } from './order-policy.js';
import { readOrder } from './order-reader.js';

@Injectable()
export class OrderAcceptanceService {
  constructor(
    @Inject(OrderCommandsService) private readonly commands: OrderCommandsService,
    @Inject(OrderHoldService) private readonly hold: OrderHoldService,
    @Inject(SettlementService) private readonly settlement: SettlementService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  accept(actor: AuthenticatedUser, id: string, input: OrderCommandInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    return this.commands.execute({ actor, id, input, key, requestId, commandName: 'ACCEPT_ORDER' }, async (tx, order) => {
      const now = await this.lockInspection(tx, order);
      const side = order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
      this.assertReceived(order, side, now);
      if (order.cancellations.some(c => c.status === 'REQUESTED')) throw new ConflictException({ code: 'ORDER_CANCELLATION_PENDING', message: 'Cancellation is pending' });
      if (order.parties.find(p => p.side === side)?.acceptedAt) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Own acceptance is already recorded' });
      await tx.orderPartyProgress.update({ where: { orderId_side: { orderId: id, side } }, data: { acceptedAt: now } });
      const updated = (await readOrder(tx, id))!;
      if (updated.parties.length === 2 && updated.parties.every(p => p.acceptedAt)) await this.settlement.begin(tx, updated, now);
      return { auditAction: 'ORDER_ACCEPTED' };
    });
  }
  issue(actor: AuthenticatedUser, id: string, input: OrderIssueInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    return this.commands.execute({ actor, id, input, key, requestId, commandName: 'REPORT_ORDER_ISSUE' }, async (tx, order) => {
      const now = await this.lockInspection(tx, order);
      this.assertReceived(order, order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT', now);
      await this.hold.enter(tx, (await readOrder(tx, id))!, input.reason, now);
      return { auditAction: 'ORDER_ISSUE_REPORTED' };
    });
  }
  private async lockInspection(tx: OrderTx, order: LockedOrder): Promise<Date> {
    await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
    await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${order.id}::uuid ORDER BY id FOR UPDATE`;
    const now = this.clock.now();
    if (dueDeadline(mapOrder(order), now)) throw new ConflictException({ code: 'ORDER_EXPIRED', message: 'Inspection deadline has passed' });
    return now;
  }
  private assertReceived(order: LockedOrder, side: 'INITIATOR' | 'RECIPIENT', now: Date): void {
    const party = order.parties.find(p => p.side === side);
    if (!['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status) || !party?.incomingDeliveredAt || !party.acceptanceDeadline) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Own incoming items have not been received' });
    if (now >= party.acceptanceDeadline) throw new ConflictException({ code: 'ORDER_EXPIRED', message: 'Inspection deadline has passed' });
  }
}
