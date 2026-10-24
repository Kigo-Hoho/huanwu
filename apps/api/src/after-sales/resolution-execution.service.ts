import { ResolutionExecutionSchema, type CaseCommandResult, type ResolutionExecutionInput } from '@barter/contracts';
import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ActionGrantService } from '../operator-security/action-grant.service.js';
import type { OperatorActionContext } from '../operator-security/operator-action.types.js';
import { CaseCommandsService } from './case-commands.service.js';
import type { CaseMutationContext, CaseTx } from './case.types.js';
import { assertResolutionActionContext, resolutionActionBinding } from './resolution-approval.service.js';
import { RESOLUTION_EXECUTORS, requiresFinancialApproval, type ExecutableResolution, type ResolutionExecutors } from './resolution-executor.port.js';
import { assertResolutionNotExecuting, currentResolution, invalidResolution } from './resolution-policy.js';
import { OrderInterventionService } from './order-intervention.service.js';
import { CaseFinalizationService } from './case-finalization.service.js';

@Injectable()
export class ResolutionExecutionService {
  constructor(
    @Inject(CaseCommandsService) private readonly commands: CaseCommandsService,
    @Inject(ActionGrantService) private readonly grants: ActionGrantService,
    @Inject(RESOLUTION_EXECUTORS) private readonly executors: ResolutionExecutors,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrderInterventionService) private readonly intervention: OrderInterventionService,
    @Inject(CaseFinalizationService) private readonly finalization: CaseFinalizationService,
  ) {}

  async start(context: OperatorActionContext, caseId: string, input: ResolutionExecutionInput, key: string): Promise<CaseCommandResult> {
    const parsed = ResolutionExecutionSchema.safeParse(input);
    if (!parsed.success) invalidResolution('Invalid resolution execution');
    input = parsed.data;
    assertResolutionActionContext(context, input);
    // This is only a candidate set. The locked current version below may count
    // only approvals whose identities were fenced before any session/order lock.
    const candidates = await this.prisma.resolutionApproval.findMany({ where: { resolution: { caseId, number: input.resolutionVersion } }, select: { actorId: true } });
    const authorityIds = [...new Set([context.actor.id, ...candidates.map(a => a.actorId)])].sort();
    let fencedAuthorityIds: string[] = [];
    // Both possible actions require the same current desktop SUPER_ADMIN role.
    // The exact action is derived only from the locked immutable resolution.
    return this.commands.run({ actor: context.actor, operatorSession: context, requiredAction: 'EXECUTE_FUNDS', caseId, input, key, commandName: 'CASE_RESOLUTION_EXECUTION_STARTED' }, async ctx => {
      assertResolutionNotExecuting(ctx.case);
      const resolution = currentResolution(ctx.case, input.resolutionVersion);
      const financial = requiresFinancialApproval(resolution);
      if (financial) await assertDualApproval(ctx, resolution, fencedAuthorityIds);
      const agreed = ['INITIATOR', 'RECIPIENT'].every(side => resolution.consents.some(c => c.side === side && c.decision === 'AGREE'));
      const adjudicated = ctx.case.records.some(r => r.kind === 'RESOLUTION_ADJUDICATED' && (r.details as { resolutionId?: string } | null)?.resolutionId === resolution.id);
      if (!agreed && !adjudicated) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'Current participant agreement or a separate adjudication is required' });
      await assertExecutionSafe(ctx);
      await this.grants.consume(ctx.tx, context, resolutionActionBinding(financial ? 'EXECUTE_FUNDS' : 'RESUME_ORDER', caseId, input));
      const executor = this.executors.get(resolution.type);
      if (!executor) throw new ServiceUnavailableException({ code: 'RESOLUTION_EXECUTOR_UNAVAILABLE', message: 'This resolution has no registered transactional executor' });
      // START is a server-owned step, independent of every future financial or
      // return obligation. No caller-provided account, business number or step.
      await ctx.tx.resolutionExecution.create({ data: { resolutionId: resolution.id, executionStep: 'START', action: financial ? 'EXECUTE_FUNDS' : 'RESUME_ORDER', actorId: context.actor.id, createdAt: ctx.now, progress: { create: { status: 'PENDING' } } } });
      await executor.planInTransaction(ctx, resolution);
      await ctx.tx.afterSalesCase.update({ where: { id: caseId }, data: { status: 'EXECUTING', agreementDeadline: null, responseDeadline: null, responseSide: null } });
      if (resolution.type === 'CONTINUE_EXCHANGE') await this.intervention.resumeInTransaction(ctx, resolution);
      await this.finalization.reconcileInTransaction(ctx);
      await ctx.tx.caseRecord.create({ data: { caseId, actorId: context.actor.id, kind: 'RESOLUTION_EXECUTION_STARTED', description: input.reason, details: { resolutionId: resolution.id, resolutionVersion: resolution.number, executionStep: 'START', sessionId: context.sessionId, deviceId: context.deviceId, grantId: context.grantId }, createdAt: ctx.now } });
    }, async tx => { fencedAuthorityIds = await lockExecutionAuthorities(tx, authorityIds); });
  }
}

export async function lockExecutionAuthorities(tx: CaseTx, ids: string[]): Promise<string[]> {
  // All identities (including the executor) use one sorted order before the
  // shared session locks. Existing child rows need their own revocation fences;
  // a child DELETE/UPDATE need not touch User. Keep parent locks shared to avoid
  // a child-to-parent FK upgrade cycle in role replacement transactions.
  for (const id of ids) await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR SHARE`;
  const fenced: string[] = [];
  for (const id of ids) {
    const roles = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM "UserRole" WHERE "userId" = ${id}::uuid ORDER BY role FOR SHARE`;
    const credential = await tx.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "AdminCredential" WHERE "userId" = ${id}::uuid FOR SHARE`;
    // Do not count a formerly absent qualifying row inserted after this fence.
    // Runtime customer enrollment rejects these independent operator identities.
    if (roles.some(r => r.role === 'SUPER_ADMIN') && !roles.some(r => r.role === 'CUSTOMER') && credential.length) fenced.push(id);
  }
  return fenced;
}

async function assertDualApproval(ctx: CaseMutationContext, resolution: ExecutableResolution, authorityIds: string[]): Promise<void> {
  const actorIds = [...new Set(resolution.approvals.filter(a => a.actorId !== resolution.authorId && authorityIds.includes(a.actorId)).map(a => a.actorId))];
  const valid = await ctx.tx.user.count({ where: { id: { in: actorIds }, disabledAt: null, wechatOpenid: null, adminCredential: { isNot: null }, roles: { some: { role: 'SUPER_ADMIN' }, none: { role: 'CUSTOMER' } } } });
  if (valid < 2) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'Two distinct current super administrators other than the proposer must approve this version' });
}

async function assertExecutionSafe(ctx: CaseMutationContext): Promise<void> {
  const { tx, order, case: value } = ctx;
  const risky = await tx.riskTask.count({ where: { OR: [{ orderId: order.id }, { case: { rootDisputeId: value.rootDisputeId } }], status: { not: 'RESOLVED' } } });
  const blocked = await tx.orderHoldBlocker.count({ where: { orderId: order.id, resolvedAt: null, NOT: { kind: 'CASE', sourceId: value.id } } });
  // Historical EXCEPTION can remain after its independent investigation ends.
  // The owning planner still enforces its resolution's
  // return/resume semantics using those facts; admission uses current blockers.
  if (risky || blocked) throw new ConflictException({ code: 'RISK_BLOCKS_RESUME', message: 'Independent active risk requires review before execution' });
  const payments = await tx.paymentIntent.findMany({ where: { orderId: order.id } });
  const commands = await tx.outboxCommand.findMany({ where: { orderId: order.id, kind: { in: ['CREATE_PAYMENT', 'CLOSE_PAYMENT', 'REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] } } });
  const businessNos = [...new Set([...payments.flatMap(p => [p.businessNo, `refund:${p.id}`, `settle:${p.id}`, `close:${p.id}`]), ...commands.map(c => c.businessNo)])];
  const pendingFacts = await tx.integrationEvent.count({ where: { businessNo: { in: businessNos }, OR: [{ receipt: null }, { receipt: { status: { not: 'PROCESSED' } } }] } });
  if (payments.some(p => p.status === 'UNKNOWN') || commands.some(c => c.status !== 'SUCCEEDED') || pendingFacts) throw new ConflictException({ code: 'FUNDS_UNRESOLVED', message: 'Reconcile existing funds instructions and facts using their original business numbers first' });
}
