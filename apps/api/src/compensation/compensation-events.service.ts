import { isDeepStrictEqual } from 'node:util';
import { CaseFinalizationService } from '../after-sales/case-finalization.service.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { VerifiedIntegrationEvent } from '../integrations/integration.types.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { compensationIdentity } from './compensation-ledger.js';
@Injectable()
export class CompensationEventsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(AuditService) private readonly audit: AuditService, @Inject(OutboxService) private readonly outbox: OutboxService, @Inject(CaseFinalizationService) private readonly finalization: CaseFinalizationService) {}
  async applyVerified(event: VerifiedIntegrationEvent): Promise<void> {
    if ('shipmentId' in event) throw new BadRequestException('Expected financial event');
    const identity = compensationIdentity(event);
    const association = identity && await this.prisma.compensationPayment.findUnique({ where: { id: identity.paymentId }, include: { obligation: { include: { resolution: { include: { case: true } } } } } });
    await this.prisma.$transaction(async tx => {
      if (association) {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${association.obligation.resolution.case.orderId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${association.obligation.resolution.caseId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${event.provider}:${event.externalTransactionId}`}, 0))::text`;
        await tx.$queryRaw`SELECT id FROM "CompensationPayment" WHERE id = ${association.id}::uuid FOR UPDATE`;
      }
      await tx.integrationEvent.createMany({ data: [{ ...event, amountFen: event.amountFen <= 2147483647 ? event.amountFen : null, occurredAt: new Date(event.occurredAt), payload: event as unknown as Prisma.InputJsonObject }], skipDuplicates: true });
      const fact = await tx.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, include: { receipt: true } });
      if (!isDeepStrictEqual(fact.payload, event)) throw new BadRequestException('Conflicting event identity');
      if (fact.receipt && fact.receipt.status !== 'PENDING') return;
      const finish = async (status: 'PENDING'|'PROCESSED'|'REJECTED', reason: string | null = null) => {
        await tx.integrationEventReceipt.upsert({ where: { eventId: fact.id }, create: { eventId: fact.id, status, reason }, update: { status, reason } });
        if (status === 'REJECTED' && association) {
          await tx.riskTask.upsert({ where: { sourceKey: `compensation:fact:${fact.id}` }, create: { sourceKey: `compensation:fact:${fact.id}`, kind: 'FINANCIAL_CONFLICT', description: reason ?? 'Conflicting compensation fact', caseId: association.obligation.resolution.caseId, orderId: association.obligation.resolution.case.orderId }, update: {} });
          await tx.compensationProgress.update({ where: { obligationId: association.obligationId }, data: { status: 'UNKNOWN' } });
        }
        await this.audit.record(tx, { actorId: null, action: `COMPENSATION_EVENT_${status}`, entityType: 'IntegrationEvent', entityId: fact.id, after: { reason, businessNo: event.businessNo } });
      };
      if (!association || !identity?.matches || event.provider !== association.provider || event.amountFen !== association.amountFen || event.currency !== 'CNY') { await finish('REJECTED', 'OBLIGATION_MISMATCH'); return; }
      const p = await tx.compensationPayment.findUniqueOrThrow({ where: { id: association.id }, include: { entries: true } });
      if (event.kind === 'PAYMENT_CLOSED') {
        if (p.entries.length || p.paidAt) { await finish('REJECTED', 'CLOSE_CONTRADICTS_COLLECTION'); return; }
        await tx.compensationPayment.update({ where: { id: p.id }, data: { status: 'CLOSED', closedAt: new Date(event.occurredAt) } });
        await tx.compensationProgress.update({ where: { obligationId: p.obligationId }, data: { status: 'CLOSED', completedAt: new Date(event.occurredAt) } });
        await finish('REJECTED', 'UNPLANNED_CLOSE'); return;
      }
      const entryType = identity.entryType;
      if (entryType !== 'COLLECTION' && !p.entries.some(e => e.entryType === 'COLLECTION')) { await finish('PENDING', 'COLLECTION_NOT_RECORDED'); return; }
      if (p.closedAt || (entryType !== 'COLLECTION' && p.entries.some(e => e.entryType !== 'COLLECTION' && e.entryType !== entryType))) { await finish('REJECTED', 'CONFLICTING_TERMINAL_FACT'); return; }
      const previous = await tx.compensationFinancialEntry.findFirst({ where: { OR: [{ paymentId: p.id, entryType }, { provider: event.provider, externalTransactionId: event.externalTransactionId, entryType }] } });
      if (previous) { await finish(previous.paymentId === p.id && previous.externalTransactionId === event.externalTransactionId ? 'PROCESSED' : 'REJECTED', 'DUPLICATE_TRANSACTION'); return; }
      await tx.compensationFinancialEntry.create({ data: { paymentId: p.id, integrationEventId: fact.id, entryType, provider: event.provider, externalTransactionId: event.externalTransactionId, businessNo: event.businessNo, amountFen: p.amountFen, currency: 'CNY', occurredAt: new Date(event.occurredAt) } });
      await tx.compensationPayment.update({ where: { id: p.id }, data: entryType === 'COLLECTION' ? { status: 'PAID', paidAt: new Date(event.occurredAt) } : entryType === 'REFUND' ? { status: 'REFUNDED', refundedAt: new Date(event.occurredAt) } : { transferredAt: new Date(event.occurredAt) } });
      await tx.compensationProgress.update({ where: { obligationId: p.obligationId }, data: { status: entryType === 'COLLECTION' ? 'COLLECTED' : entryType === 'REFUND' ? 'REFUNDED' : 'TRANSFERRED', ...(entryType !== 'COLLECTION' ? { completedAt: new Date(event.occurredAt) } : {}) } });
      const resolutionId = association.obligation.resolutionId;
      const claim = await tx.resolutionExecution.findUnique({ where: { resolutionId_executionStep: { resolutionId, executionStep: `CLAIM:${event.businessNo}` } } });
      if (claim) await tx.resolutionExecutionProgress.update({ where: { executionId: claim.id }, data: { status: 'SUCCEEDED', completedAt: new Date(event.occurredAt) } });
      if (entryType === 'COLLECTION') await this.outbox.enqueue(tx, { orderId: association.obligation.resolution.case.orderId, kind: 'DISBURSE_COMPENSATION', businessNo: `compensation:disburse:${p.id}`, payload: { paymentId: p.id, paymentBusinessNo: p.businessNo, caseId: association.obligation.resolution.caseId, resolutionId, amountFen: p.amountFen, currency: 'CNY' } });
      await finish(entryType === 'REFUND' ? 'REJECTED' : 'PROCESSED', entryType === 'REFUND' ? 'UNPLANNED_REFUND' : null);
    });
    if (event.kind === 'PAYMENT_SUCCEEDED' && association) {
      const waiting = await this.prisma.integrationEvent.findMany({ where: { businessNo: { in: [`compensation:refund:${association.id}`, `compensation:disburse:${association.id}`] }, receipt: { status: 'PENDING' } } });
      for (const fact of waiting) await this.applyVerified(fact.payload as unknown as VerifiedIntegrationEvent);
    }
    if (association) await this.finalization.reconcile(association.obligation.resolution.caseId);
  }
}
