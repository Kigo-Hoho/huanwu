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
    const reusedShipments = new Set<string>();
    for (const item of [...order.items].sort((a, b) => a.id.localeCompare(b.id))) {
      const plan = plans.find(p => p.itemSnapshotId === item.id)!;
      const shipment = order.shipments.find(s => s.side === item.side);
      const transferred = Boolean(shipment || order.parties.find(p => p.side === item.side)?.handedOverAt);
      if (plan.outcome === 'UNDELIVERED') { if (transferred) returnNotReady('Registered shipments require verified closure'); continue; }
      if (!transferred) returnNotReady('Undelivered snapshots have no reverse duty');
      const holderSide = item.side === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR';
      const existing = await tx.returnObligation.findMany({ where: { itemSnapshotId: item.id, resolution: { case: { rootDisputeId: ctx.case.rootDisputeId } } }, include: { progress: true, resolution: { include: { case: true, executions: { include: { progress: true } } } } } });
      if (plan.outcome === 'INTERCEPT_VERIFIED') {
        // The current immutable outcome references the original fact through its
        // exact order/root/snapshot. Never copy an obligation or rebind its outbox.
        const prior = existing.length === 1 ? existing[0] : null;
        const closure = shipment && await tx.originalShipmentClosure.findUnique({ where: { shipmentId: shipment.id } });
        if (!prior || prior.progress?.status !== 'INTERCEPTED' || !shipment || shipment.orderId !== order.id || shipment.deliveredAt || shipment.status === 'DELIVERED'
          || prior.resolution.caseId === ctx.case.id || prior.resolution.case.orderId !== order.id || prior.resolution.case.rootDisputeId !== ctx.case.rootDisputeId
          || prior.ownerSide !== item.side || prior.holderSide !== holderSide || prior.deliveryMode !== order.deliveryMode
          || !prior.resolution.case.closedAt || prior.resolution.case.status !== 'RESOLVED'
          || !prior.resolution.executions.length || prior.resolution.executions.some(e => e.progress?.status !== 'SUCCEEDED' || !e.progress.completedAt)
          || !closure || closure.outcome !== 'INTERCEPTED' || closure.resolutionId !== prior.resolutionId) returnNotReady('Safe historical interception proof is missing');
        const fact = await tx.integrationEvent.findUnique({ where: { id: closure.eventId }, include: { receipt: true } });
        const event = fact?.payload as { kind?: string; shipmentId?: string; businessNo?: string; outcome?: string; provider?: string } | undefined;
        const operation = await tx.outboxCommand.findUnique({ where: { businessNo: `return:intercept:${shipment.id}` } });
        const payload = operation?.payload as { shipmentId?: string; originalBusinessNo?: string; caseId?: string; resolutionId?: string } | undefined;
        const conflictRisk = await tx.riskTask.count({ where: { OR: [{ orderId: order.id }, { case: { rootDisputeId: ctx.case.rootDisputeId } }], status: { not: 'RESOLVED' } } });
        const lateDelivery = await tx.integrationEvent.count({ where: { shipmentId: shipment.id, kind: 'SHIPMENT_PROGRESS', payload: { path: ['progress'], equals: 'DELIVERED' } } });
        if (!fact || fact.receipt?.status !== 'PROCESSED' || fact.kind !== 'ORIGINAL_SHIPMENT_CLOSED' || fact.shipmentId !== shipment.id || fact.businessNo !== operation?.businessNo
          || event?.kind !== fact.kind || event.shipmentId !== shipment.id || event.businessNo !== fact.businessNo || event.outcome !== 'INTERCEPTED' || event.provider !== fact.provider
          || !operation || operation.orderId !== order.id || operation.kind !== 'CLOSE_OR_INTERCEPT' || operation.status !== 'SUCCEEDED'
          || payload?.shipmentId !== shipment.id || payload.originalBusinessNo !== shipment.businessNo || payload.resolutionId !== prior.resolutionId || payload.caseId !== prior.resolution.caseId
          || conflictRisk || lateDelivery) returnNotReady('Historical interception is contradictory or unresolved');
        if (shipment.status === 'EXCEPTION') {
          const risk = await tx.riskTask.findUnique({ where: { sourceKey: `shipment:${shipment.id}:exception` } });
          if (!risk || risk.kind !== 'SHIPMENT_EXCEPTION' || risk.orderId !== order.id || risk.status !== 'RESOLVED') returnNotReady('Historical shipment exception needs source-bound clearance');
          const blocker = await tx.orderHoldBlocker.findUnique({ where: { orderId_kind_sourceId: { orderId: order.id, kind: 'RISK', sourceId: risk.id } } });
          const exceptionFact = await tx.shipmentEvent.findFirst({ where: { shipmentId: shipment.id, progress: 'EXCEPTION', integrationEvent: { kind: 'SHIPMENT_PROGRESS', shipmentId: shipment.id, businessNo: shipment.businessNo, provider: fact.provider, receipt: { status: 'PROCESSED' }, payload: { path: ['progress'], equals: 'EXCEPTION' } } } });
          if (!blocker?.resolvedAt || !exceptionFact) returnNotReady('Historical exception clearance cannot be proven');
        }
        reusedShipments.add(shipment.id);
        continue;
      }
      if (existing.length) returnNotReady('This root dispute already has an obligation for the snapshot');
      let status: 'PENDING'|'UNKNOWN'|'INTERCEPTED'|'UNRETURNABLE' = shipment && !shipment.deliveredAt ? 'UNKNOWN' : 'PENDING';
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
        if (reusedShipments.has(shipment.id)) continue;
        await this.outbox.enqueue(tx, { orderId: order.id, kind: 'CLOSE_OR_INTERCEPT', businessNo: `return:intercept:${shipment.id}`, payload: { shipmentId: shipment.id, originalBusinessNo: shipment.businessNo, resolutionId: resolution.id, caseId: ctx.case.id, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber } });
      }
    }
  }
}
