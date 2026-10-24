import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { readOrder } from '../orders/order-reader.js';
import { RiskTaskService } from '../risk/risk-task.service.js';
import { readCase } from './case-reader.js';
import type { CaseMutationContext, CaseTx } from './case.types.js';

const TERMINAL = new Set(['RESOLVED', 'WITHDRAWN', 'REJECTED']);
const SEVEN_DAYS_MS = 7 * 86400000;

@Injectable()
export class CaseExpiryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RiskTaskService) private readonly risks: RiskTaskService,
  ) {}

  async reconcile(caseId: string): Promise<void> {
    const located = await this.prisma.afterSalesCase.findUnique({ where: { id: caseId }, select: { orderId: true, status: true } });
    if (!located || TERMINAL.has(located.status)) return;
    await this.prisma.$transaction(async tx => {
      // Match CaseCommandsService lock order: order then case.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${located.orderId}::uuid FOR UPDATE`;
      const order = await readOrder(tx, located.orderId);
      await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
      const value = await readCase(tx, caseId);
      if (!order || !value || TERMINAL.has(value.status)) return;
      const changed = await this.apply(tx, { tx, order, case: value, now: this.clock.now(), actor: null });
      if (changed) {
        await tx.afterSalesCase.update({ where: { id: caseId }, data: { version: { increment: 1 } } });
        await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      }
    });
  }

  async reconcileInTransaction(ctx: CaseMutationContext): Promise<void> {
    await this.apply(ctx.tx, ctx);
  }

  async reconcileDue(): Promise<void> {
    const now = this.clock.now();
    const transitCutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
    const due = await this.prisma.afterSalesCase.findMany({
      where: {
        status: { notIn: ['RESOLVED', 'WITHDRAWN', 'REJECTED'] },
        OR: [
          { status: 'AWAITING_RESPONSE', responseDeadline: { lte: now } },
          { status: 'AWAITING_AGREEMENT', agreementDeadline: { lte: now } },
          { status: 'EXECUTING', resolutions: { some: { OR: [
            { returnObligations: { some: { registrationDeadline: { lte: now }, progress: { status: 'PENDING' } } } },
            { returnObligations: { some: { progress: { status: 'DELIVERED', receiptDeadline: { lte: now } } } } },
            { returnShipments: { some: { collectedAt: { lte: transitCutoff }, status: { in: ['COLLECTED'] } } } },
            { compensationObligations: { some: { paymentDeadline: { lte: now }, progress: { status: { in: ['PENDING', 'AUTHORIZED'] } } } } },
          ] } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const row of due) await this.reconcile(row.id);
  }

  private async apply(tx: CaseTx, ctx: CaseMutationContext): Promise<boolean> {
    if (TERMINAL.has(ctx.case.status)) return false;
    let bump = false;
    if (ctx.case.status === 'AWAITING_RESPONSE' && ctx.case.responseDeadline && ctx.now >= ctx.case.responseDeadline) {
      await this.markResponseOverdue(tx, ctx);
      bump = true;
    }
    if (ctx.case.status === 'AWAITING_AGREEMENT' && ctx.case.agreementDeadline && ctx.now >= ctx.case.agreementDeadline) {
      await this.markAgreementOverdue(tx, ctx);
      bump = true;
    }
    // Execution risks keep obligations in place; upserts are idempotent and do not
    // invent consent, payment, confirmation or reservation release.
    if (ctx.case.status === 'EXECUTING') await this.markExecutionRisks(tx, ctx);
    return bump;
  }

  private async markResponseOverdue(tx: CaseTx, ctx: CaseMutationContext): Promise<void> {
    const already = await tx.caseRecord.count({ where: { caseId: ctx.case.id, kind: 'RESPONSE_OVERDUE' } });
    if (!already) {
      await tx.caseRecord.create({ data: { caseId: ctx.case.id, actorId: null, kind: 'RESPONSE_OVERDUE', description: '补证期限已届满，转人工核验', createdAt: ctx.now } });
    }
    await this.risks.recordInTransaction(tx, {
      sourceKey: `case:${ctx.case.id}:response-overdue`,
      kind: 'RESPONSE_OVERDUE',
      caseId: ctx.case.id,
      orderId: ctx.order.id,
      description: 'Evidence response deadline elapsed; manual review required',
    });
    await tx.afterSalesCase.update({ where: { id: ctx.case.id }, data: { status: 'UNDER_REVIEW', responseSide: null, responseDeadline: null } });
    if (!await tx.auditLog.count({ where: { entityId: ctx.case.id, action: 'CASE_RESPONSE_OVERDUE' } })) {
      await this.audit.record(tx, { actorId: null, action: 'CASE_RESPONSE_OVERDUE', entityType: 'AfterSalesCase', entityId: ctx.case.id, after: { previousStatus: 'AWAITING_RESPONSE' } });
    }
  }

  private async markAgreementOverdue(tx: CaseTx, ctx: CaseMutationContext): Promise<void> {
    const already = await tx.caseRecord.count({ where: { caseId: ctx.case.id, kind: 'AGREEMENT_OVERDUE' } });
    if (!already) {
      await tx.caseRecord.create({ data: { caseId: ctx.case.id, actorId: null, kind: 'AGREEMENT_OVERDUE', description: '方案回应期限已届满，转人工核验', createdAt: ctx.now } });
    }
    await this.risks.recordInTransaction(tx, {
      sourceKey: `case:${ctx.case.id}:agreement-overdue`,
      kind: 'AGREEMENT_OVERDUE',
      caseId: ctx.case.id,
      orderId: ctx.order.id,
      description: 'Resolution agreement deadline elapsed without consent; manual review required',
    });
    await tx.afterSalesCase.update({ where: { id: ctx.case.id }, data: { status: 'UNDER_REVIEW', agreementDeadline: null } });
    if (!await tx.auditLog.count({ where: { entityId: ctx.case.id, action: 'CASE_AGREEMENT_OVERDUE' } })) {
      await this.audit.record(tx, { actorId: null, action: 'CASE_AGREEMENT_OVERDUE', entityType: 'AfterSalesCase', entityId: ctx.case.id, after: { previousStatus: 'AWAITING_AGREEMENT' } });
    }
  }

  private async markExecutionRisks(tx: CaseTx, ctx: CaseMutationContext): Promise<void> {
    const resolutions = ctx.case.resolutions.filter(r => r.number === ctx.case.currentResolutionVersion);
    for (const resolution of resolutions) {
      for (const obligation of resolution.returnObligations) {
        const status = obligation.progress?.status ?? 'PENDING';
        if (status === 'PENDING' && ctx.now >= obligation.registrationDeadline) {
          await this.risks.recordInTransaction(tx, {
            sourceKey: `return:${obligation.id}:registration-overdue`,
            kind: 'RETURN_REGISTRATION_OVERDUE',
            caseId: ctx.case.id,
            orderId: ctx.order.id,
            description: 'Return registration deadline elapsed; obligation retained for manual follow-up',
          });
        }
        if (status === 'DELIVERED' && obligation.progress?.receiptDeadline && ctx.now >= obligation.progress.receiptDeadline) {
          await this.risks.recordInTransaction(tx, {
            sourceKey: `return:${obligation.id}:receipt-overdue`,
            kind: 'RETURN_RECEIPT_OVERDUE',
            caseId: ctx.case.id,
            orderId: ctx.order.id,
            description: 'Return receipt confirmation deadline elapsed; not auto-confirmed',
          });
        }
      }
      for (const obligation of resolution.compensationObligations) {
        const status = obligation.progress?.status ?? 'PENDING';
        if (['PENDING', 'AUTHORIZED'].includes(status) && ctx.now >= obligation.paymentDeadline) {
          await this.risks.recordInTransaction(tx, {
            sourceKey: `compensation:${obligation.id}:payment-overdue`,
            kind: 'COMPENSATION_PAYMENT_OVERDUE',
            caseId: ctx.case.id,
            orderId: ctx.order.id,
            description: 'Compensation payment deadline elapsed; no deposit penalty applied',
          });
        }
      }
    }
    const shipments = await tx.returnShipment.findMany({
      where: {
        resolution: { caseId: ctx.case.id, number: ctx.case.currentResolutionVersion ?? undefined },
        status: 'COLLECTED',
        collectedAt: { not: null, lte: new Date(ctx.now.getTime() - SEVEN_DAYS_MS) },
      },
    });
    for (const shipment of shipments) {
      await this.risks.recordInTransaction(tx, {
        sourceKey: `return:shipment:${shipment.id}:transit-overdue`,
        kind: 'RETURN_TRANSIT_OVERDUE',
        caseId: ctx.case.id,
        orderId: ctx.order.id,
        description: 'Return shipment undelivered seven days after collection; obligation retained',
      });
    }
  }
}
