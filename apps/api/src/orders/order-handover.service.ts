import type { OrderCommandInput, OrderCommandResult } from '@barter/contracts';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { OrderCommandsService } from './order-commands.service.js';

@Injectable()
export class OrderHandoverService {
  constructor(@Inject(OrderCommandsService) private readonly commands: OrderCommandsService) {}
  confirm(actor: AuthenticatedUser, id: string, input: OrderCommandInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    return this.commands.execute({ actor, id, input, key, requestId, commandName: 'CONFIRM_ORDER_HANDOVER' }, async (tx, order, now) => {
      if (order.deliveryMode !== 'IN_PERSON' || order.status !== 'AWAITING_FULFILLMENT' || !order.parties.every(p => p.fundsReady)) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Order is not ready for in-person handover' });
      if (order.cancellations.some(c => c.status === 'REQUESTED')) throw new ConflictException({ code: 'ORDER_CANCELLATION_PENDING', message: 'Cancellation is pending' });
      const side = order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
      if (order.parties.find(p => p.side === side)?.handedOverAt) throw new ConflictException({ code: 'ORDER_FULFILLMENT_STARTED', message: 'Own handover is already recorded' });
      await tx.orderPartyProgress.update({ where: { orderId_side: { orderId: id, side } }, data: { handedOverAt: now } });
      const parties = await tx.orderPartyProgress.findMany({ where: { orderId: id } });
      if (parties.length === 2 && parties.every(p => p.handedOverAt)) {
        await tx.orderPartyProgress.updateMany({ where: { orderId: id }, data: { incomingDeliveredAt: now, acceptanceDeadline: new Date(now.getTime() + order.inspectionHours * 3600000) } });
        await tx.order.update({ where: { id }, data: { status: 'AWAITING_ACCEPTANCE', fulfillmentDeadline: null } });
      }
      return { auditAction: 'ORDER_HANDOVER_CONFIRMED' };
    });
  }
}
