import { OriginalFundsPlanSchema } from '@barter/contracts';
import type { PrismaService } from '../database/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProviderOperation } from '../integrations/integration.types.js';
import { lockExecutionAuthorities } from '../after-sales/resolution-execution.service.js';
import { isDeepStrictEqual } from 'node:util';

// Called only for an explicitly case-bound original-payment instruction. It
// preserves original payment-purpose uniqueness and refund:<intentId> identity.
export async function authorizeOriginalFunds(prisma: PrismaService, audit: AuditService, op: ProviderOperation): Promise<boolean> {
  const { caseId, resolutionId } = op.payload;
  if (typeof caseId !== 'string' || typeof resolutionId !== 'string') return false;
  const candidate = await prisma.resolutionVersion.findUnique({ where: { id: resolutionId }, include: { approvals: true, executions: true } });
  const start = candidate?.executions.find(e => e.executionStep === 'START');
  if (!candidate || !start?.actorId) return false;
  const actorId = start.actorId;
  return prisma.$transaction(async tx => {
    const fenced = await lockExecutionAuthorities(tx, [...new Set([actorId, ...candidate.approvals.map(a => a.actorId)])].sort());
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${op.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
    const value = await tx.afterSalesCase.findUnique({ where: { id: caseId } });
    const order = await tx.order.findUnique({ where: { id: op.orderId }, include: { parties: true, shipments: true } });
    if (!value || !order || value.orderId !== order.id || value.status !== 'EXECUTING' || candidate.caseId !== caseId || value.currentResolutionVersion !== candidate.number || !fenced.includes(actorId)) return false;
    if (await tx.user.count({ where: { id: { in: candidate.approvals.filter(a => a.actorId !== candidate.authorId && fenced.includes(a.actorId)).map(a => a.actorId) }, disabledAt: null, wechatOpenid: null } }) < 2 || !await tx.user.count({ where: { id: actorId, disabledAt: null, wechatOpenid: null } })) return false;
    if (await tx.riskTask.count({ where: { OR: [{ orderId: order.id }, { case: { rootDisputeId: value.rootDisputeId } }], status: { not: 'RESOLVED' } } })) return false;
    if (await tx.orderHoldBlocker.count({ where: { orderId: order.id, resolvedAt: null, NOT: { kind: 'CASE', sourceId: caseId } } })) return false;
    if (candidate.type === 'CONTINUE_EXCHANGE') return false;
    if (candidate.type === 'KEEP_WITH_COMPENSATION' && (order.parties.length !== 2 || order.parties.some(p => !p.acceptedAt || !p.incomingDeliveredAt))) return false;
    if (candidate.type === 'CANCEL_BEFORE_HANDOVER' && (order.shipments.length || order.parties.some(p => p.handedOverAt))) return false;
    if (candidate.type === 'RETURN_ORIGINALS') {
      const returns = await tx.returnObligation.findMany({ where: { resolutionId }, include: { progress: true } });
      if (returns.some(r => !r.progress || !['CONFIRMED', 'INTERCEPTED', 'UNRETURNABLE'].includes(r.progress.status))) return false;
    }
    if (typeof op.payload.paymentBusinessNo !== 'string') return false;
    const p = await tx.paymentIntent.findUnique({ where: { businessNo: op.payload.paymentBusinessNo }, include: { entries: true } });
    const durable = await tx.outboxCommand.findUnique({ where: { businessNo: op.businessNo } });
    if (!p || p.orderId !== order.id || p.amountFen !== op.payload.amountFen || op.payload.currency !== 'CNY' || !durable || durable.kind !== op.kind || durable.orderId !== op.orderId || !isDeepStrictEqual(durable.payload, op.payload)) return false;
    const destination = OriginalFundsPlanSchema.parse(candidate.originalFunds).find(f => f.paymentIntentId === p.id)?.destination;
    if (op.kind === 'REFUND_PAYMENT' ? destination !== 'REFUND_PAYER' || op.businessNo !== `refund:${p.id}` : op.kind === 'SETTLE_DIFFERENCE' ? destination !== 'SETTLE_BENEFICIARY' || p.purpose !== 'DIFFERENCE' || op.businessNo !== `settle:${p.id}` : true) return false;
    if (p.status !== 'PAID' || !p.entries.some(e => e.entryType === 'PAYMENT') || p.entries.some(e => e.entryType !== 'PAYMENT')) return false;
    const executionStep = `CLAIM:${op.businessNo}`;
    if (!await tx.resolutionExecution.findUnique({ where: { resolutionId_executionStep: { resolutionId, executionStep } } })) {
      await tx.resolutionExecution.create({ data: { resolutionId, executionStep, action: op.kind, originalPaymentIntentId: p.id, actorId, progress: { create: { status: 'PROCESSING' } } } });
      await audit.record(tx, { actorId: null, action: 'AFTER_SALES_ORIGINAL_FUNDS_CLAIMED', entityType: 'PaymentIntent', entityId: p.id, after: { businessNo: op.businessNo, resolutionId } });
    }
    return true;
  });
}
