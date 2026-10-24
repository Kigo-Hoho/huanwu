import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { CaseFundsStatusService } from '../compensation/case-funds-status.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { readOrder } from '../orders/order-reader.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { readCase } from './case-reader.js';
import type { CaseMutationContext } from './case.types.js';
import { OrderFactsService } from '../orders/order-facts.service.js';

@Injectable()
export class CaseFinalizationService implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(CaseFundsStatusService) private readonly funds: CaseFundsStatusService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OrderFactsService) private readonly facts: OrderFactsService) {}
  onModuleInit() { this.facts.subscribe(async orderId => {
    for (const value of await this.prisma.afterSalesCase.findMany({ where: { orderId, status: 'EXECUTING' } })) await this.reconcile(value.id);
  }); }
  async reconcile(caseId: string): Promise<boolean> {
    const located = await this.prisma.afterSalesCase.findUnique({ where: { id: caseId } });
    if (!located) return false;
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${located.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
      const order = await readOrder(tx, located.orderId); const value = await readCase(tx, caseId);
      if (!order || !value) return false;
      const done = await this.reconcileInTransaction({ tx, order, case: value, now: this.clock.now(), actor: null });
      if (done) {
        await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
        await tx.afterSalesCase.update({ where: { id: caseId }, data: { version: { increment: 1 } } });
      }
      return done;
    });
  }
  async reconcileInTransaction(ctx: CaseMutationContext): Promise<boolean> {
    const { tx, now } = ctx;
    const value = await readCase(tx, ctx.case.id); const order = await readOrder(tx, ctx.order.id);
    if (!value || !order || value.status !== 'EXECUTING') return false;
    const resolution = value.resolutions.find(r => r.number === value.currentResolutionVersion);
    if (!resolution || !resolution.executions.some(e => e.executionStep === 'START')) return false;
    if (resolution.executions.some(e => e.executionStep !== 'START' && (e.progress?.status !== 'SUCCEEDED' || !e.progress.completedAt))) return false;
    if (await tx.riskTask.count({ where: { OR: [{ orderId: order.id }, { case: { rootDisputeId: value.rootDisputeId } }], status: { not: 'RESOLVED' } } })) return false;
    if (await tx.orderHoldBlocker.count({ where: { orderId: order.id, resolvedAt: null, NOT: { kind: 'CASE', sourceId: value.id } } })) return false;
    if (!(await this.funds.inspect(tx, value.id)).complete) return false;
    if (resolution.returnObligations.some(o => !['CONFIRMED', 'INTERCEPTED', 'UNRETURNABLE'].includes(o.progress?.status ?? ''))) return false;
    if (resolution.returnObligations.some(o => o.progress?.status === 'CONFIRMED' && !o.progress.confirmedAt)) return false;
    if (resolution.type === 'KEEP_WITH_COMPENSATION' && ![order.initiatorId, order.recipientId].every(actorId => value.records.some(r => r.kind === 'KEEP_CONFIRMED' && r.actorId === actorId && (r.details as { resolutionId?: string })?.resolutionId === resolution.id))) return false;
    const terminal = ['COMPLETED', 'CANCELLED'].includes(order.status);
    if (resolution.type === 'CONTINUE_EXCHANGE') {
      if (order.status === 'ON_HOLD') return false;
    } else if (!terminal) {
      if (resolution.type === 'FUNDS_ONLY') return false;
      await this.reservations.lockItems(tx, order.items.map(i => i.itemId));
      const leases = await tx.itemReservation.findMany({ where: { orderId: order.id } });
      if (leases.length !== order.items.length || order.items.some(i => !leases.some(l => l.itemId === i.itemId))) return false;
      const delivered = order.items.filter(i => order.parties.some(p => p.side === i.side && p.handedOverAt) || order.shipments.some(s => s.side === i.side && s.deliveredAt));
      if (delivered.length) await tx.item.updateMany({ where: { id: { in: delivered.map(i => i.itemId) } }, data: { status: 'INACTIVE', version: { increment: 1 } } });
      await this.reservations.releaseOrder(tx, order.id);
      await tx.order.update({ where: { id: order.id }, data: resolution.type === 'KEEP_WITH_COMPENSATION' ? { status: 'COMPLETED', completedAt: now } : { status: 'CANCELLED' } });
    }
    await tx.resolutionExecutionProgress.updateMany({ where: { execution: { resolutionId: resolution.id, executionStep: 'START' } }, data: { status: 'SUCCEEDED', completedAt: now } });
    await tx.orderHoldBlocker.updateMany({ where: { orderId: order.id, kind: 'CASE', sourceId: value.id, resolvedAt: null }, data: { resolvedAt: now } });
    await tx.afterSalesCase.update({ where: { id: value.id }, data: { status: 'RESOLVED', closedAt: now } });
    await tx.caseRecord.create({ data: { caseId: value.id, actorId: ctx.actor?.id, kind: 'RESOLUTION_FINALIZED', description: resolution.returnObligations.some(o => o.progress?.status === 'UNRETURNABLE') ? '裁决处置及资金义务已完成' : '方案全部义务已完成', details: { resolutionId: resolution.id }, createdAt: now } });
    await this.audit.record(tx, { actorId: ctx.actor?.id, action: 'CASE_RESOLVED', entityType: 'AfterSalesCase', entityId: value.id, after: { resolutionId: resolution.id, closedAt: now.toISOString() } });
    return true;
  }
}
