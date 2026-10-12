import type { CaseEvidenceRequestInput, CaseRejectInput, CaseResponseInput, CaseWithdrawalInput, CaseWithdrawalResponseInput } from '@barter/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { CaseCommandsService, type OperatorCaseCommandContext } from './case-commands.service.js';
import { assertSafeCaseClosure } from './case-policy.js';
import type { CaseCommandContext, CaseMutationContext } from './case.types.js';

@Injectable()
export class CaseRecordsService {
  constructor(@Inject(CaseCommandsService) private readonly commands: CaseCommandsService) {}
  respond(context: CaseCommandContext, input: CaseResponseInput) {
    return this.commands.run({ ...context, input }, async ctx => {
      if (ctx.case.status === 'EXECUTING') throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Execution requires its dedicated workflow' });
      await this.record(ctx, 'RESPONSE', input.description);
      const side = ctx.order.initiatorId === ctx.actor!.id ? 'INITIATOR' : 'RECIPIENT';
      if (ctx.case.status === 'AWAITING_RESPONSE' && (ctx.case.responseSide === side || (ctx.case.responseDeadline !== null && ctx.now >= ctx.case.responseDeadline))) {
        if (ctx.case.responseDeadline !== null && ctx.now >= ctx.case.responseDeadline) await this.record(ctx, 'RESPONSE_OVERDUE', '补证期限已届满，转人工核验', undefined, true);
        await ctx.tx.afterSalesCase.update({ where: { id: ctx.case.id }, data: { status: 'UNDER_REVIEW', responseSide: null, responseDeadline: null } });
      }
    });
  }
  requestEvidence(context: OperatorCaseCommandContext, input: CaseEvidenceRequestInput) {
    return this.commands.run({ ...context, input }, async ctx => {
      if (!['OPEN', 'AWAITING_RESPONSE', 'UNDER_REVIEW'].includes(ctx.case.status)) throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Case does not allow an evidence request' });
      await this.record(ctx, 'EVIDENCE_REQUESTED', input.reason, { side: input.side });
      await ctx.tx.afterSalesCase.update({ where: { id: ctx.case.id }, data: { status: 'AWAITING_RESPONSE', responseSide: input.side, responseDeadline: new Date(ctx.now.getTime() + 72 * 3600000) } });
    });
  }
  withdraw(context: CaseCommandContext, input: CaseWithdrawalInput) {
    return this.commands.run({ ...context, input }, async ctx => {
      const pending = this.pendingWithdrawal(ctx);
      if (pending) throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'A withdrawal request is already pending' });
      await this.record(ctx, 'WITHDRAWAL_REQUESTED', input.reason);
    });
  }
  withdrawalRespond(context: CaseCommandContext, input: CaseWithdrawalResponseInput) {
    return this.commands.run({ ...context, input }, async ctx => {
      const pending = this.pendingWithdrawal(ctx);
      if (!pending || pending.id !== input.withdrawalRequestId) throw new ConflictException({ code: 'CASE_VERSION_CONFLICT', message: 'Withdrawal request is no longer current' });
      if (pending.actorId === ctx.actor!.id) throw new ForbiddenException('The other participant must confirm withdrawal');
      if (input.decision === 'AGREE') await assertSafeCaseClosure(ctx.tx, ctx.order, ctx.case);
      await this.record(ctx, input.decision === 'AGREE' ? 'WITHDRAWAL_CONFIRMED' : 'WITHDRAWAL_REJECTED', input.reason ?? '同意撤回工单', { withdrawalRequestId: pending.id });
      if (input.decision === 'AGREE') await this.close(ctx, 'WITHDRAWN');
    });
  }
  reject(context: OperatorCaseCommandContext, input: CaseRejectInput) {
    return this.commands.run({ ...context, input }, async ctx => {
      if (!['OPEN', 'AWAITING_RESPONSE', 'UNDER_REVIEW'].includes(ctx.case.status)) throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Only a case without an active resolution can be rejected' });
      if (ctx.case.currentResolutionVersion !== null) throw new ConflictException({ code: 'RESOLUTION_VERSION_CONFLICT', message: 'Active resolution requires its dedicated workflow' });
      await assertSafeCaseClosure(ctx.tx, ctx.order, ctx.case);
      await this.record(ctx, 'REJECTED', input.reason);
      await this.close(ctx, 'REJECTED');
    });
  }
  private pendingWithdrawal(ctx: CaseMutationContext) {
    // Confirmation/rejection binds to the immutable request id. Sorting by UUID
    // is only a display tie-breaker, never the chronology of a shared clock tick.
    const replied = new Set(ctx.case.records.filter(r => ['WITHDRAWAL_CONFIRMED', 'WITHDRAWAL_REJECTED'].includes(r.kind)).map(r => (r.details as Prisma.JsonObject | null)?.withdrawalRequestId));
    return ctx.case.records.find(r => r.kind === 'WITHDRAWAL_REQUESTED' && !replied.has(r.id));
  }
  private async close(ctx: CaseMutationContext, status: 'WITHDRAWN' | 'REJECTED') {
    await ctx.tx.afterSalesCase.update({ where: { id: ctx.case.id }, data: { status, closedAt: ctx.now, responseSide: null, responseDeadline: null, agreementDeadline: null } });
    await ctx.tx.orderHoldBlocker.updateMany({ where: { orderId: ctx.order.id, kind: 'CASE', sourceId: ctx.case.id, resolvedAt: null }, data: { resolvedAt: ctx.now } });
    // Closing the case never changes order status, reservations or other holds.
  }
  private async record(ctx: CaseMutationContext, kind: string, description: string, details?: Prisma.InputJsonObject, system = false) {
    await ctx.tx.caseRecord.create({ data: { caseId: ctx.case.id, actorId: system ? null : ctx.actor?.id, kind, description, details, createdAt: ctx.now } });
  }
}
