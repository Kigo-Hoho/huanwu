import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { LockedOrder, OrderTx } from './order.mapper.js';
import type { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class OrderHoldService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}
  // Caller holds the order lock, supplies fresh server time and owns one revision.
  async enter(tx: OrderTx, order: LockedOrder, reason: string, now: Date): Promise<void> {
    if (['ON_HOLD', 'COMPLETED', 'CANCELLED'].includes(order.status)) return;
    const previous = order.outstandingObligations as Prisma.JsonObject | null;
    const fulfillment = {
      pendingCollectionSides: order.deliveryMode === 'COURIER' ? order.parties.filter(p => !order.shipments.some(s => s.side === p.side && ['COLLECTED', 'DELIVERED'].includes(s.status))).map(p => p.side) : [],
      pendingHandoverSides: order.deliveryMode === 'IN_PERSON' ? order.parties.filter(p => !p.handedOverAt).map(p => p.side) : [],
      pendingAcceptanceSides: order.parties.filter(p => !p.acceptedAt).map(p => p.side),
    };
    await tx.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: reason, holdPreviousStatus: order.status, heldAt: now, outstandingObligations: { ...previous, fulfillment } } });
    await this.audit.record(tx, { actorId: null, action: 'ORDER_HELD', entityType: 'Order', entityId: order.id, before: { status: order.status }, after: { reason, status: 'ON_HOLD' } });
  }
}
