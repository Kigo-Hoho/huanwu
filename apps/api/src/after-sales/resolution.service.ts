import { ResolutionAdjudicationSchema, ResolutionConsentSchema, ResolutionInputSchema, type CaseCommandResult, type ResolutionAdjudicationInput, type ResolutionConsentInput, type ResolutionInput } from '@barter/contracts';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { ActionGrantService } from '../operator-security/action-grant.service.js';
import { operatorRequestHash, type OperatorActionContext, type OperatorSessionContext } from '../operator-security/operator-action.types.js';
import { CaseCommandsService } from './case-commands.service.js';
import type { CaseCommandContext } from './case.types.js';
import { assertCaseEvidence, assertResolutionNotExecuting, currentResolution, deriveResolution, invalidResolution } from './resolution-policy.js';

@Injectable()
export class ResolutionService {
  constructor(@Inject(CaseCommandsService) private readonly commands: CaseCommandsService, @Inject(ActionGrantService) private readonly grants: ActionGrantService) {}
  async propose(operator: OperatorSessionContext, caseId: string, input: ResolutionInput, key: string): Promise<CaseCommandResult> {
    const parsed = ResolutionInputSchema.safeParse(input);
    if (!parsed.success) invalidResolution('Invalid resolution input');
    input = parsed.data;
    return this.commands.run({ actor: operator.actor, operatorSession: operator, caseId, input, key, commandName: 'CASE_RESOLUTION_PROPOSED' }, async ctx => {
      assertResolutionNotExecuting(ctx.case);
      const next = (ctx.case.currentResolutionVersion ?? 0) + 1;
      if (input.resolutionVersion !== next) throw new ConflictException({ code: 'RESOLUTION_VERSION_CONFLICT', message: 'New proposal must use the next resolution number' });
      const derived = await deriveResolution(ctx, input);
      if (ctx.case.status === 'OPEN') {
        await ctx.tx.caseRecord.create({ data: { caseId, actorId: operator.actor.id, kind: 'REVIEW_STARTED', description: '平台开始审核售后方案', createdAt: ctx.now } });
      }
      const resolution = await ctx.tx.resolutionVersion.create({ data: {
        caseId, number: next, authorId: operator.actor.id, type: input.type, reason: input.reason, rulesVersion: input.rulesVersion,
        evidenceIds: input.evidenceIds, itemSnapshotIds: derived.itemSnapshotIds, responsibility: input.responsibility,
        originalFunds: derived.originalFunds, returnPlan: input.returnPlan, compensationComponents: input.compensationComponents,
        netCompensationFen: derived.netCompensation.amountFen, compensationPayer: derived.netCompensation.payer, orderOutcome: derived.orderOutcome, createdAt: ctx.now,
      } });
      await ctx.tx.caseRecord.create({ data: { caseId, actorId: operator.actor.id, kind: 'RESOLUTION_PROPOSED', description: input.reason, details: { resolutionId: resolution.id, resolutionVersion: next, sessionId: operator.sessionId, deviceId: operator.deviceId }, createdAt: ctx.now } });
      await ctx.tx.afterSalesCase.update({ where: { id: caseId }, data: { status: 'AWAITING_AGREEMENT', currentResolutionVersion: next, responseDeadline: null, responseSide: null, agreementDeadline: new Date(ctx.now.getTime() + 72 * 60 * 60_000) } });
    });
  }
  async consent(context: CaseCommandContext, input: ResolutionConsentInput): Promise<CaseCommandResult> {
    const parsed = ResolutionConsentSchema.safeParse(input);
    if (!parsed.success) invalidResolution('Invalid resolution consent');
    input = parsed.data;
    return this.commands.run({ ...context, input, commandName: 'CASE_RESOLUTION_CONSENT' }, async ctx => {
      const resolution = currentResolution(ctx.case, input.resolutionVersion);
      if (ctx.case.status !== 'AWAITING_AGREEMENT' || !ctx.case.agreementDeadline || ctx.now >= ctx.case.agreementDeadline) throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Resolution is not awaiting a current response' });
      const side = ctx.order.initiatorId === context.actor.id ? 'INITIATOR' : 'RECIPIENT';
      if (resolution.consents.some(c => c.side === side)) throw new ConflictException({ code: 'RESOLUTION_VERSION_CONFLICT', message: 'This participant already responded to this immutable version' });
      await ctx.tx.resolutionConsent.create({ data: { resolutionId: resolution.id, actorId: context.actor.id, side, decision: input.decision, reason: input.reason ?? null, createdAt: ctx.now } });
      await ctx.tx.caseRecord.create({ data: { caseId: ctx.case.id, actorId: context.actor.id, kind: input.decision === 'REJECT' ? 'RESOLUTION_REJECTED' : 'RESOLUTION_AGREED', description: input.reason ?? '同意当前售后方案（不代表验收物品）', details: { resolutionId: resolution.id, resolutionVersion: resolution.number, side }, createdAt: ctx.now } });
      if (input.decision === 'REJECT') await ctx.tx.afterSalesCase.update({ where: { id: ctx.case.id }, data: { status: 'UNDER_REVIEW', agreementDeadline: null } });
    });
  }
  async adjudicate(operator: OperatorActionContext, input: ResolutionAdjudicationInput & { caseId: string }, key: string): Promise<CaseCommandResult> {
    const { caseId, ...body } = input;
    const parsed = ResolutionAdjudicationSchema.safeParse(body);
    if (!parsed.success) invalidResolution('Invalid adjudication input');
    const business = parsed.data;
    return this.commands.run({ actor: operator.actor, operatorSession: operator, requiredAction: 'ADJUDICATE_RESOLUTION', caseId, input: business, key, commandName: 'CASE_RESOLUTION_ADJUDICATED' }, async ctx => {
      assertResolutionNotExecuting(ctx.case);
      const resolution = currentResolution(ctx.case, business.resolutionVersion);
      assertCaseEvidence(ctx.case, business.evidenceIds);
      if (ctx.case.records.some(r => r.kind === 'RESOLUTION_ADJUDICATED' && (r.details as { resolutionId?: string } | null)?.resolutionId === resolution.id)) throw new ConflictException({ code: 'RESOLUTION_VERSION_CONFLICT', message: 'This version already has an immutable adjudication' });
      await this.grants.consume(ctx.tx, operator, { action: 'ADJUDICATE_RESOLUTION', resourceId: caseId, expectedVersions: { expectedCaseVersion: business.expectedCaseVersion, expectedOrderVersion: business.expectedOrderVersion, resolutionVersion: business.resolutionVersion }, requestHash: operatorRequestHash(business) });
      await ctx.tx.caseRecord.create({ data: { caseId, actorId: operator.actor.id, kind: 'RESOLUTION_ADJUDICATED', description: business.reason, details: { resolutionId: resolution.id, resolutionVersion: resolution.number, evidenceIds: business.evidenceIds, responsibility: resolution.responsibility, sessionId: operator.sessionId, deviceId: operator.deviceId, grantId: operator.grantId }, createdAt: ctx.now } });
      // A ruling is only a recorded fact. Task6 owns approval and execution.
      await ctx.tx.afterSalesCase.update({ where: { id: caseId }, data: { status: 'UNDER_REVIEW', agreementDeadline: null, responseDeadline: null, responseSide: null } });
    });
  }
}
