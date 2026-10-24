import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { lockExecutionAuthorities } from '../after-sales/resolution-execution.service.js';
import type { IntegrationOperationHandler, ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
import { OutboxHandlerRegistry } from '../integrations/outbox-handler.registry.js';
import { COMPENSATION_PORT, type CompensationPort } from './compensation.port.js';
import { CompensationEventsService } from './compensation-events.service.js';

@Injectable()
export class CompensationOutboxHandler implements IntegrationOperationHandler, OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(COMPENSATION_PORT) private readonly port: CompensationPort, @Inject(CompensationEventsService) private readonly events: CompensationEventsService, @Inject(OutboxHandlerRegistry) private readonly registry: OutboxHandlerRegistry, @Inject(AuditService) private readonly audit: AuditService, @Inject(CLOCK) private readonly clock: Clock) {}
  onModuleInit() { for (const kind of ['CREATE_COMPENSATION', 'CLOSE_COMPENSATION', 'REFUND_COMPENSATION', 'DISBURSE_COMPENSATION'] as const) this.registry.register(kind, this); }
  async authorize(op: ProviderOperation): Promise<boolean> {
    const { resolutionId, caseId, paymentId } = op.payload;
    if (typeof resolutionId !== 'string' || typeof caseId !== 'string' || typeof paymentId !== 'string') return false;
    const candidates = await this.prisma.resolutionApproval.findMany({ where: { resolutionId } });
    const start = await this.prisma.resolutionExecution.findUnique({ where: { resolutionId_executionStep: { resolutionId, executionStep: 'START' } } });
    const identities = [...new Set([...candidates.map(a => a.actorId), ...(start?.actorId ? [start.actorId] : [])])].sort();
    return this.prisma.$transaction(async tx => {
      const fenced = await lockExecutionAuthorities(tx, identities);
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${op.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
      const value = await tx.afterSalesCase.findUnique({ where: { id: caseId } });
      const resolution = await tx.resolutionVersion.findUnique({ where: { id: resolutionId }, include: { approvals: true } });
      if (!value || value.orderId !== op.orderId || value.status !== 'EXECUTING' || resolution?.caseId !== caseId || resolution.number !== value.currentResolutionVersion || !start?.actorId || !fenced.includes(start.actorId)) return false;
      const valid = await tx.user.count({ where: { id: { in: resolution.approvals.filter(a => a.actorId !== resolution.authorId && fenced.includes(a.actorId)).map(a => a.actorId) }, disabledAt: null, wechatOpenid: null, roles: { some: { role: 'SUPER_ADMIN' }, none: { role: 'CUSTOMER' } }, adminCredential: { isNot: null } } });
      if (valid < 2 || !await tx.user.count({ where: { id: start.actorId, disabledAt: null, wechatOpenid: null } })) return false;
      if (await tx.riskTask.count({ where: { OR: [{ orderId: op.orderId }, { case: { rootDisputeId: value.rootDisputeId } }], status: { not: 'RESOLVED' } } })) return false;
      if (await tx.orderHoldBlocker.count({ where: { orderId: op.orderId, resolvedAt: null, NOT: { kind: 'CASE', sourceId: caseId } } })) return false;
      const durable = await tx.outboxCommand.findUnique({ where: { businessNo: op.businessNo } });
      if (!durable || durable.kind !== op.kind || durable.orderId !== op.orderId || !isDeepStrictEqual(durable.payload, op.payload)) return false;
      await tx.$queryRaw`SELECT id FROM "CompensationPayment" WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = await tx.compensationPayment.findUnique({ where: { id: paymentId }, include: { obligation: { include: { progress: true } }, entries: true } });
      if (!p || p.obligation.resolutionId !== resolutionId || p.amountFen !== op.payload.amountFen || op.payload.currency !== 'CNY') return false;
      const create = op.kind === 'CREATE_COMPENSATION';
      const disburse = op.kind === 'DISBURSE_COMPENSATION';
      // No authorized cancellation transition exists yet. Task10 must supply
      // one explicitly; the mere presence of a forged outbox is never authority.
      if (!create && !disburse) return false;
      if (create ? (op.businessNo !== p.businessNo || !['CREATED', 'PENDING'].includes(p.status) || !p.obligation.progress?.authorizedAt || this.clock.now() >= p.obligation.paymentDeadline)
        : (op.businessNo !== `compensation:disburse:${p.id}` || op.payload.paymentBusinessNo !== p.businessNo || !p.entries.some(e => e.entryType === 'COLLECTION') || p.entries.some(e => e.entryType !== 'COLLECTION') || p.closedAt !== null)) return false;
      const executionStep = `CLAIM:${op.businessNo}`;
      if (!await tx.resolutionExecution.findUnique({ where: { resolutionId_executionStep: { resolutionId, executionStep } } })) {
        await tx.resolutionExecution.create({ data: { resolutionId, executionStep, action: op.kind, actorId: start.actorId, progress: { create: { status: 'PROCESSING' } } } });
        await this.audit.record(tx, { actorId: null, action: 'COMPENSATION_OPERATION_CLAIMED', entityType: 'CompensationPayment', entityId: p.id, after: { businessNo: op.businessNo, resolutionId } });
      }
      if (create && p.status === 'CREATED') await tx.compensationPayment.update({ where: { id: p.id }, data: { status: 'PENDING' } });
      return true;
    });
  }
  query(op: ProviderOperation) { return op.kind === 'REFUND_COMPENSATION' ? this.port.queryRefund(op.businessNo) : op.kind === 'DISBURSE_COMPENSATION' ? this.port.queryDisbursement(op.businessNo) : this.port.query(op.businessNo); }
  async execute(op: ProviderOperation) {
    if (!await this.authorize(op)) throw new Error('Compensation execution is not currently authorized');
    return op.kind === 'CREATE_COMPENSATION' ? this.port.create(op) : op.kind === 'CLOSE_COMPENSATION' ? this.port.close(op) : op.kind === 'REFUND_COMPENSATION' ? this.port.refund(op) : this.port.disburse(op);
  }
  async apply(op: ProviderOperation, result: ProviderResult) {
    if (result.status !== 'SUCCESS') return;
    const expected = op.kind === 'CREATE_COMPENSATION' ? 'PAYMENT_SUCCEEDED' : op.kind === 'CLOSE_COMPENSATION' ? 'PAYMENT_CLOSED' : op.kind === 'REFUND_COMPENSATION' ? 'REFUND_SUCCEEDED' : 'DIFFERENCE_SETTLED';
    if ('shipmentId' in result.event || result.event.kind !== expected || result.event.businessNo !== op.businessNo || result.event.externalTransactionId !== result.externalTransactionId) throw new Error('Mismatched compensation result');
    await this.events.applyVerified(result.event);
  }
}
