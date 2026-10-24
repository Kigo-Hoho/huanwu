import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { mapOrder } from '../orders/order.mapper.js';
import { dueDeadline } from '../orders/order-policy.js';
import type { CaseMutationContext } from './case.types.js';
import type { ExecutableResolution } from './resolution-executor.port.js';
import type { OrderInterventionPort } from './order-intervention.port.js';
import { SettlementService } from '../payments/settlement.service.js';

@Injectable()
export class OrderInterventionService implements OrderInterventionPort {
  constructor(@Inject(AuditService) private readonly audit: AuditService, @Inject(SettlementService) private readonly settlement: SettlementService) {}
  async extendDeadlineInTransaction(ctx: CaseMutationContext, input: { kind: 'DETAILS'|'PAYMENT'|'FULFILLMENT'|'ACCEPTANCE'; side?: 'INITIATOR'|'RECIPIENT'; reason?: string }): Promise<void> {
    const { tx, order, now } = ctx;
    const resolution = ctx.case.resolutions.find(r => r.number === ctx.case.currentResolutionVersion);
    if (!ctx.actor || !resolution || resolution.type !== 'CONTINUE_EXCHANGE' || ['COMPLETED', 'CANCELLED'].includes(order.status)) throw new ConflictException('Order cannot be extended');
    if (await tx.orderDeadlineExtension.findUnique({ where: { orderId_kind: { orderId: order.id, kind: input.kind } } })) throw new ConflictException('This deadline category was already extended');
    const sides = input.side ? [input.side] : ['INITIATOR', 'RECIPIENT'] as const;
    const parties = order.parties.filter(p => sides.includes(p.side));
    const field = input.kind === 'DETAILS' ? 'detailsDeadline' : input.kind === 'PAYMENT' ? 'paymentDeadline' : 'fulfillmentDeadline';
    if (input.kind === 'ACCEPTANCE' ? parties.length !== sides.length || parties.some(p => p.acceptedAt || !p.acceptanceDeadline || !p.incomingDeliveredAt)
      : !order[field] || (input.kind === 'DETAILS' && order.parties.every(p => p.addressReady)) || (input.kind === 'PAYMENT' && order.parties.every(p => p.fundsReady)) || (input.kind === 'FULFILLMENT' && order.parties.every(p => p.handedOverAt))) throw new ConflictException('Completed or absent deadlines cannot be extended');
    const newDeadline = new Date(now.getTime() + 72 * 3600000);
    await tx.orderDeadlineExtension.create({ data: { orderId: order.id, resolutionId: resolution.id, actorId: ctx.actor.id, kind: input.kind, originalDeadline: input.kind === 'ACCEPTANCE' ? parties[0]!.acceptanceDeadline : order[field], newDeadline, affectedSides: [...sides], reason: input.reason ?? resolution.reason, approvedAt: now } });
    if (input.kind === 'ACCEPTANCE') await tx.orderPartyProgress.updateMany({ where: { orderId: order.id, side: { in: [...sides] } }, data: { acceptanceDeadline: newDeadline } });
    else await tx.order.update({ where: { id: order.id }, data: { [field]: newDeadline } });
    await this.audit.record(tx, { actorId: ctx.actor.id, action: 'ORDER_DEADLINE_EXTENDED', entityType: 'Order', entityId: order.id, after: { kind: input.kind, newDeadline: newDeadline.toISOString(), resolutionId: resolution.id } });
  }
  async resumeInTransaction(ctx: CaseMutationContext, resolution: ExecutableResolution): Promise<void> {
    const { tx, order, now } = ctx;
    if (resolution.type !== 'CONTINUE_EXCHANGE' || resolution.caseId !== ctx.case.id) throw new ConflictException('Invalid recovery plan');
    if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new ConflictException('Terminal orders cannot resume');
    if (order.status !== 'ON_HOLD') return;
    if (order.parties.length !== 2 || order.cancellations.some(c => c.status === 'REQUESTED')) throw new ConflictException('Unresolved order facts');
    const payments = await tx.paymentIntent.findMany({ where: { orderId: order.id }, include: { entries: true } });
    // All original settlement instructions may have completed after the hold.
    // The public settlement port revalidates both acceptances, exact ledger and
    // owned reservations before changing the final state.
    if (order.parties.every(p => p.acceptedAt && p.incomingDeliveredAt) && payments.some(p => p.entries.some(e => e.entryType !== 'PAYMENT'))) {
      await tx.order.update({ where: { id: order.id }, data: { status: 'SETTLING' } });
      if (!await this.settlement.tryFinalize(tx, order.id, now, true)) throw new ConflictException({ code: 'FUNDS_UNRESOLVED', message: 'Original settlement still requires reconciliation' });
      await tx.orderHoldBlocker.updateMany({ where: { orderId: order.id, kind: 'CASE', sourceId: ctx.case.id, resolvedAt: null }, data: { resolvedAt: now } });
      await this.audit.record(tx, { actorId: ctx.actor?.id, action: 'ORDER_RESUMED', entityType: 'Order', entityId: order.id, before: { status: order.status }, after: { status: 'COMPLETED', resolutionId: resolution.id } });
      return;
    }
    for (const party of order.parties) {
      const purposes = order.differenceFen > 0 && order.payer === party.side ? ['DEPOSIT', 'DIFFERENCE'] : ['DEPOSIT'];
      party.fundsReady = purposes.every(purpose => payments.some(p => p.side === party.side && p.purpose === purpose && p.status === 'PAID' && p.paidAt && !p.closedAt && p.amountFen === (purpose === 'DEPOSIT' ? order.depositFen : order.differenceFen) && p.entries.length === 1 && p.entries[0]!.entryType === 'PAYMENT' && p.entries[0]!.amountFen === p.amountFen));
      await tx.orderPartyProgress.update({ where: { id: party.id }, data: { fundsReady: party.fundsReady } });
    }
    const delivered = order.parties.every(p => p.incomingDeliveredAt);
    const status = order.deliveryMode === 'COURIER' && !order.parties.every(p => p.addressReady) ? 'AWAITING_DETAILS'
      : !order.parties.every(p => p.fundsReady) ? 'AWAITING_PAYMENT'
      : delivered ? 'AWAITING_ACCEPTANCE' : order.shipments.length ? 'IN_TRANSIT' : 'AWAITING_FULFILLMENT';
    if (dueDeadline(mapOrder({ ...order, status }), now)) throw new ConflictException({ code: 'ORDER_EXPIRED', message: 'Approve a bounded deadline extension before recovery' });
    await tx.order.update({ where: { id: order.id }, data: { status, holdReason: null, heldAt: null, holdPreviousStatus: null } });
    await tx.orderHoldBlocker.updateMany({ where: { orderId: order.id, kind: 'CASE', sourceId: ctx.case.id, resolvedAt: null }, data: { resolvedAt: now } });
    await this.audit.record(tx, { actorId: ctx.actor?.id, action: 'ORDER_RESUMED', entityType: 'Order', entityId: order.id, before: { status: order.status }, after: { status, resolutionId: resolution.id } });
  }
}
