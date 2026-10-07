import type { OrderCancellationInput, OrderCancellationRespondInput, OrderCancellationWithdrawInput, OrderCommandResult } from '@barter/contracts';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { OrderCommandsService } from './order-commands.service.js';
import { mapOrder, type LockedOrder, type OrderTx } from './order.mapper.js';
import { dueDeadline } from './order-policy.js';
import { assertNegotiable, OrderCancellationEngine } from './order-cancellation-engine.service.js';

function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }
const actorSide = (order: LockedOrder, actorId: string) => order.initiatorId === actorId ? 'INITIATOR' as const : 'RECIPIENT' as const;

@Injectable()
export class OrderCancellationService {
  constructor(
    @Inject(OrderCommandsService) private readonly commands: OrderCommandsService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(OrderCancellationEngine) private readonly engine: OrderCancellationEngine,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  request(actor: AuthenticatedUser, id: string, input: OrderCancellationInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    return this.commands.execute({ actor, id, input, key, requestId, commandName: 'REQUEST_ORDER_CANCELLATION' }, async (tx, order, now) => {
      assertNegotiable(order);
      if (await tx.orderCancellation.findFirst({ where: { orderId: id, status: 'REQUESTED' } })) {
        conflict('ORDER_CANCELLATION_PENDING', 'Order already has a pending cancellation request');
      }
      await tx.orderCancellation.create({ data: { orderId: id, requestedBySide: actorSide(order, actor.id), reason: input.reason, requestedVersion: order.version, requestedAt: now } });
      return { auditAction: 'ORDER_CANCELLATION_REQUESTED' };
    });
  }

  respond(actor: AuthenticatedUser, id: string, input: OrderCancellationRespondInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    return this.commands.execute({ actor, id, input, key, requestId, commandName: 'RESPOND_ORDER_CANCELLATION' }, async (tx, order, now) => {
      assertNegotiable(order);
      const cancellation = await this.currentRequest(tx, id, input.cancellationId);
      if (cancellation.requestedBySide === actorSide(order, actor.id)) conflict('ORDER_INVALID_STATE', 'Only the other participant can respond');
      if (input.decision === 'AGREE') {
        // Global order -> items/reservations -> funds ordering, followed by a fresh deadline check.
        await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
        now = this.clock.now();
        if (dueDeadline(mapOrder(order), now)) conflict('ORDER_EXPIRED', 'Order command deadline has passed');
      }
      await tx.orderCancellation.update({ where: { id: cancellation.id }, data: { status: input.decision === 'AGREE' ? 'AGREED' : 'REJECTED', respondedAt: now } });
      if (input.decision === 'AGREE') await this.begin(tx, order, cancellation.reason, actor.id, now);
      return { auditAction: input.decision === 'AGREE' ? 'ORDER_CANCELLATION_AGREED' : 'ORDER_CANCELLATION_REJECTED' };
    });
  }

  withdraw(actor: AuthenticatedUser, id: string, input: OrderCancellationWithdrawInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    return this.commands.execute({ actor, id, input, key, requestId, commandName: 'WITHDRAW_ORDER_CANCELLATION' }, async (tx, order, now) => {
      assertNegotiable(order);
      const cancellation = await this.currentRequest(tx, id, input.cancellationId);
      if (cancellation.requestedBySide !== actorSide(order, actor.id)) conflict('ORDER_INVALID_STATE', 'Only the requester can withdraw');
      await tx.orderCancellation.update({ where: { id: cancellation.id }, data: { status: 'WITHDRAWN', respondedAt: now } });
      return { auditAction: 'ORDER_CANCELLATION_WITHDRAWN' };
    });
  }

  private async currentRequest(tx: OrderTx, orderId: string, cancellationId: string) {
    const cancellation = await tx.orderCancellation.findFirst({ where: { orderId, status: 'REQUESTED' } });
    if (!cancellation || cancellation.id !== cancellationId) conflict('ORDER_INVALID_STATE', 'Cancellation request is no longer current');
    return cancellation;
  }

  // Compatibility façade: the engine retains the exact supplied-tx/revision contracts.
  begin(tx: OrderTx, order: LockedOrder, reason: string, actorId: string | null, now: Date): Promise<void> {
    return this.engine.begin(tx, order, reason, actorId, now);
  }
  tryFinalize(tx: OrderTx, orderId: string, now: Date): Promise<boolean> {
    return this.engine.tryFinalize(tx, orderId, now);
  }
}
