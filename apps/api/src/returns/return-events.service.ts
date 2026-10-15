import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma, Shipment } from '../generated/prisma/client.js';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../integrations/integration-config.js';
import type { VerifiedIntegrationEvent } from '../integrations/integration.types.js';
import { RiskTaskService } from '../risk/risk-task.service.js';

@Injectable()
export class ReturnEventsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(AuditService) private readonly audit: AuditService, @Inject(CLOCK) private readonly clock: Clock, @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration, @Inject(RiskTaskService) private readonly risks: RiskTaskService) {}
  // Original logistics callers already own the order lock. Acquire associated
  // cases before their item/funds/shipment locks, preserving the common order.
  async lockOriginalCasesInTransaction(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    await tx.$queryRaw`SELECT c.id FROM "AfterSalesCase" c WHERE c."orderId" = ${orderId}::uuid AND EXISTS (SELECT 1 FROM "ResolutionVersion" v JOIN "ReturnObligation" r ON r."resolutionId" = v.id WHERE v."caseId" = c.id) ORDER BY c.id FOR UPDATE`;
  }
  async reconcileOriginalDeliveryInTransaction(tx: Prisma.TransactionClient, shipment: Shipment): Promise<void> {
    const closure = await tx.originalShipmentClosure.findUnique({ where: { shipmentId: shipment.id } });
    if (closure?.outcome !== 'INTERCEPTED') return;
    await tx.$queryRaw`SELECT r.id FROM "ReturnObligation" r JOIN "OrderItemSnapshot" s ON s.id = r."itemSnapshotId" WHERE s."orderId" = ${shipment.orderId}::uuid AND r."ownerSide" = ${shipment.side}::"OrderSide" ORDER BY r.id FOR UPDATE OF r`;
    const obligations = await tx.returnObligation.findMany({ where: { itemSnapshot: { orderId: shipment.orderId }, ownerSide: shipment.side, progress: { status: 'INTERCEPTED' } }, include: { resolution: true } });
    const cases = new Set<string>();
    for (const o of obligations) {
      await tx.returnProgress.update({ where: { obligationId: o.id }, data: { status: 'UNKNOWN', version: { increment: 1 } } });
      cases.add(o.resolution.caseId);
    }
    for (const caseId of cases) {
      await this.risks.recordInTransaction(tx, { sourceKey: `return:closure-conflict:${shipment.id}:${caseId}`, kind: 'RETURN_CLOSURE_CONFLICT', orderId: shipment.orderId, caseId, description: 'Original delivery conflicts with verified interception; retain obligations for manual reconciliation' });
      await tx.afterSalesCase.update({ where: { id: caseId }, data: { version: { increment: 1 } } });
      await this.audit.record(tx, { actorId: null, action: 'RETURN_ORIGINAL_CLOSURE_CONFLICT', entityType: 'AfterSalesCase', entityId: caseId, after: { shipmentId: shipment.id, obligationIds: obligations.filter(o => o.resolution.caseId === caseId).map(o => o.id) } });
    }
  }
  async applyVerified(event: VerifiedIntegrationEvent): Promise<void> {
    if (event.kind !== 'RETURN_PROGRESS' && event.kind !== 'ORIGINAL_SHIPMENT_CLOSED') throw new BadRequestException('Expected a return event');
    const operation = await this.prisma.outboxCommand.findUnique({ where: { businessNo: event.businessNo } });
    const payload = operation?.payload as Prisma.JsonObject | undefined;
    await this.prisma.$transaction(async tx => {
      if (operation) await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${operation.orderId}::uuid FOR UPDATE`;
      const caseId = typeof payload?.caseId === 'string' ? payload.caseId : null;
      if (caseId) await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
      const inserted = await tx.integrationEvent.createMany({ data: [{ provider: event.provider, eventId: event.eventId, kind: event.kind, businessNo: event.businessNo, shipmentId: event.shipmentId, occurredAt: new Date(event.occurredAt), payload: event as unknown as Prisma.InputJsonObject }], skipDuplicates: true });
      const saved = await tx.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } } });
      if (!inserted.count) { if (!isDeepStrictEqual(saved.payload, event)) throw new BadRequestException('Conflicting return event identity'); return; }
      const resolution = typeof payload?.resolutionId === 'string' ? await tx.resolutionVersion.findUnique({ where: { id: payload.resolutionId } }) : null;
      const value = caseId ? await tx.afterSalesCase.findUnique({ where: { id: caseId } }) : null;
      let reason: string | null = !operation || !value || value.orderId !== operation.orderId || resolution?.caseId !== caseId || event.provider !== this.config.logistics || event.shipmentId !== payload?.shipmentId || (event.kind === 'RETURN_PROGRESS' ? operation.kind !== 'VERIFY_RETURN' : operation.kind !== 'CLOSE_OR_INTERCEPT') ? 'RETURN_OPERATION_MISMATCH' : null;
      if (!reason && event.kind === 'ORIGINAL_SHIPMENT_CLOSED') {
        const source = await tx.shipment.findUnique({ where: { id: event.shipmentId } });
        const prior = await tx.originalShipmentClosure.findUnique({ where: { shipmentId: event.shipmentId } });
        if (!source || source.orderId !== operation!.orderId || source.businessNo !== payload!.originalBusinessNo || (prior && prior.outcome !== event.outcome) || (event.outcome === 'INTERCEPTED' && (source.deliveredAt || source.status === 'DELIVERED'))) reason = 'ORIGINAL_CLOSURE_CONFLICT';
        else {
          await tx.$queryRaw`SELECT id FROM "ReturnObligation" WHERE "resolutionId" = ${resolution!.id}::uuid ORDER BY id FOR UPDATE`;
          if (!prior) await tx.originalShipmentClosure.create({ data: { shipmentId: source.id, resolutionId: resolution!.id, outcome: event.outcome, eventId: saved.id } });
          const obligations = await tx.returnObligation.findMany({ where: { resolutionId: resolution!.id, ownerSide: source.side }, include: { progress: true } });
          for (const o of obligations) {
            if (o.progress && ['PENDING', 'UNKNOWN'].includes(o.progress.status)) await tx.returnProgress.update({ where: { obligationId: o.id }, data: { status: event.outcome === 'INTERCEPTED' ? 'INTERCEPTED' : 'PENDING', version: { increment: 1 } } });
          }
        }
      }
      if (!reason && event.kind === 'RETURN_PROGRESS') {
        const shipment = await tx.returnShipment.findUnique({ where: { id: event.shipmentId }, include: { items: { include: { obligation: { include: { progress: true } } } } } });
        if (!shipment || shipment.resolutionId !== resolution!.id || shipment.businessNo !== operation!.businessNo) reason = 'RETURN_SHIPMENT_MISMATCH';
        else {
          await tx.$queryRaw`SELECT id FROM "ReturnObligation" WHERE "resolutionId" = ${resolution!.id}::uuid ORDER BY id FOR UPDATE`;
          const rank = { REGISTERED: 0, COLLECTED: 1, DELIVERED: 2, EXCEPTION: 3 };
          if (rank[event.progress] > rank[shipment.status]) await tx.returnShipment.update({ where: { id: shipment.id }, data: { status: event.progress } });
          if (event.progress === 'DELIVERED' && !shipment.deliveredAt) await tx.returnShipment.update({ where: { id: shipment.id }, data: { deliveredAt: new Date(event.occurredAt) } });
          if (event.progress === 'COLLECTED' && !shipment.collectedAt) await tx.returnShipment.update({ where: { id: shipment.id }, data: { collectedAt: new Date(event.occurredAt) } });
          for (const { obligation: o } of shipment.items) {
            const status = o.progress?.status;
            // Customer decisions are immutable facts. Late provider evidence cannot
            // confirm receipt, erase a dispute or reverse an accepted receipt.
            if (status && ['REGISTERED', 'COLLECTED', 'DELIVERED'].includes(status)) {
              const next = event.progress === 'EXCEPTION' ? 'DISPUTED' : event.progress;
              if (event.progress === 'EXCEPTION' || rank[event.progress] > rank[status as 'REGISTERED'|'COLLECTED'|'DELIVERED']) await tx.returnProgress.update({ where: { obligationId: o.id }, data: { status: next, version: { increment: 1 }, ...(event.progress === 'DELIVERED' ? { receiptDeadline: new Date(this.clock.now().getTime() + 72 * 3600000) } : {}) } });
            }
          }
          await tx.returnEvent.create({ data: { shipmentId: shipment.id, provider: event.provider, providerEventId: event.eventId, kind: event.progress, occurredAt: new Date(event.occurredAt) } });
          if (event.progress === 'EXCEPTION') await this.risks.recordInTransaction(tx, { sourceKey: `return:${shipment.id}:exception`, kind: 'RETURN_EXCEPTION', orderId: operation!.orderId, caseId: caseId!, description: 'Trusted return exception requires manual review' });
        }
      }
      await tx.integrationEventReceipt.create({ data: { eventId: saved.id, status: reason ? 'REJECTED' : 'PROCESSED', reason, processedAt: this.clock.now() } });
      if (!reason) {
        await tx.afterSalesCase.update({ where: { id: caseId! }, data: { version: { increment: 1 } } });
        await tx.order.update({ where: { id: operation!.orderId }, data: { version: { increment: 1 } } });
      }
      await this.audit.record(tx, { actorId: null, action: reason ? 'RETURN_EVENT_QUARANTINED' : 'RETURN_PROVIDER_FACT_RECORDED', entityType: 'IntegrationEvent', entityId: saved.id, after: { kind: event.kind, reason, shipmentId: event.shipmentId } });
    });
  }
}
