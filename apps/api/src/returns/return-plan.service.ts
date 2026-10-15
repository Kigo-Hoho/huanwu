import { ResolutionReturnPlanSchema } from '@barter/contracts';
import { ConflictException, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { CaseMutationContext } from '../after-sales/case.types.js';
import { RESOLUTION_EXECUTORS, type ExecutableResolution, type ResolutionExecutor, type ResolutionExecutors } from '../after-sales/resolution-executor.port.js';
import { OutboxService } from '../integrations/outbox.service.js';

export function returnNotReady(message = 'Return obligation is not ready'): never { throw new ConflictException({ code: 'RETURN_NOT_READY', message }); }
@Injectable()
export class ReturnPlanService implements ResolutionExecutor, OnModuleInit {
  constructor(@Inject(RESOLUTION_EXECUTORS) private readonly registry: ResolutionExecutors, @Inject(OutboxService) private readonly outbox: OutboxService) {}
  onModuleInit(): void { this.registry.set('RETURN_ORIGINALS', this); }
  async planInTransaction(ctx: CaseMutationContext, resolution: ExecutableResolution): Promise<void> {
    const { tx, order, now } = ctx;
    if (resolution.type !== 'RETURN_ORIGINALS' || resolution.caseId !== ctx.case.id) returnNotReady();
    const plans = ResolutionReturnPlanSchema.parse(resolution.returnPlan);
    if (JSON.stringify(plans.map(p => p.itemSnapshotId).sort()) !== JSON.stringify(order.items.map(i => i.id).sort())) returnNotReady('Plan must cover every exact order snapshot');
    const owners = new Set<string>();
    for (const item of [...order.items].sort((a, b) => a.id.localeCompare(b.id))) {
      const plan = plans.find(p => p.itemSnapshotId === item.id)!;
      const shipment = order.shipments.find(s => s.side === item.side);
      const transferred = Boolean(shipment || order.parties.find(p => p.side === item.side)?.handedOverAt);
      if (plan.outcome === 'UNDELIVERED') { if (transferred) returnNotReady('Registered shipments require verified closure'); continue; }
      if (!transferred) returnNotReady('Undelivered snapshots have no reverse duty');
      const holderSide = item.side === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR';
      const existing = await tx.returnObligation.findFirst({ where: { itemSnapshotId: item.id, resolution: { case: { rootDisputeId: ctx.case.rootDisputeId } } } });
      if (existing) returnNotReady('This root dispute already has an obligation for the snapshot');
      let status: 'PENDING'|'UNKNOWN'|'INTERCEPTED'|'UNRETURNABLE' = shipment && !shipment.deliveredAt ? 'UNKNOWN' : 'PENDING';
      if (plan.outcome === 'INTERCEPT_VERIFIED') {
        const closure = shipment && await tx.originalShipmentClosure.findUnique({ where: { shipmentId: shipment.id } });
        if (!closure || closure.outcome !== 'INTERCEPTED') returnNotReady('Interception proof is missing');
        status = 'INTERCEPTED';
      }
      if (plan.outcome === 'UNRETURNABLE_RULING') {
        if (!resolution.evidenceIds.length || ['NONE', 'UNDETERMINED'].includes(resolution.responsibility)) returnNotReady('A ruling requires evidence and responsibility');
        status = 'UNRETURNABLE';
      }
      await tx.returnObligation.create({ data: { resolutionId: resolution.id, itemSnapshotId: item.id, holderSide, ownerSide: item.side, deliveryMode: order.deliveryMode, registrationDeadline: new Date(now.getTime() + 72 * 3600000), createdAt: now, progress: { create: { status } } } });
      if (!['INTERCEPTED', 'UNRETURNABLE'].includes(status)) owners.add(item.side);
    }
    if (order.deliveryMode === 'COURIER') {
      for (const side of [...owners].sort()) {
        const address = await tx.returnAddress.findUnique({ where: { caseId_side: { caseId: ctx.case.id, side: side as 'INITIATOR'|'RECIPIENT' } } });
        if (!address) returnNotReady('Each original owner must supply a private return address');
        await tx.returnAddress.update({ where: { id: address.id }, data: { frozenAt: now } });
      }
      for (const shipment of [...order.shipments].sort((a, b) => a.id.localeCompare(b.id))) {
        await this.outbox.enqueue(tx, { orderId: order.id, kind: 'CLOSE_OR_INTERCEPT', businessNo: `return:intercept:${shipment.id}`, payload: { shipmentId: shipment.id, originalBusinessNo: shipment.businessNo, resolutionId: resolution.id, caseId: ctx.case.id, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber } });
      }
    }
  }
}
