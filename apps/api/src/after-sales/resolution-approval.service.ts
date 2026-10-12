import { ResolutionApprovalSchema, type CaseCommandResult, type ResolutionApprovalInput } from '@barter/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ActionGrantService } from '../operator-security/action-grant.service.js';
import { operatorRequestHash, type OperatorActionContext } from '../operator-security/operator-action.types.js';
import { CaseCommandsService } from './case-commands.service.js';
import { requiresFinancialApproval } from './resolution-executor.port.js';
import { assertResolutionNotExecuting, currentResolution, invalidResolution } from './resolution-policy.js';

@Injectable()
export class ResolutionApprovalService {
  constructor(@Inject(CaseCommandsService) private readonly commands: CaseCommandsService, @Inject(ActionGrantService) private readonly grants: ActionGrantService) {}

  async approve(context: OperatorActionContext, caseId: string, input: ResolutionApprovalInput, key: string): Promise<CaseCommandResult> {
    const parsed = ResolutionApprovalSchema.safeParse(input);
    if (!parsed.success) invalidResolution('Invalid resolution approval');
    input = parsed.data;
    assertResolutionActionContext(context, input);
    return this.commands.run({ actor: context.actor, operatorSession: context, requiredAction: 'APPROVE_FUNDS', caseId, input, key, commandName: 'CASE_RESOLUTION_APPROVED' }, async ctx => {
      assertResolutionNotExecuting(ctx.case);
      const resolution = currentResolution(ctx.case, input.resolutionVersion);
      if (!requiresFinancialApproval(resolution)) throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'An unchanged exchange requires authorized resume, not financial approval' });
      if (resolution.authorId === context.actor.id) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'The proposer cannot approve their own resolution' });
      if (resolution.approvals.some(a => a.actorId === context.actor.id)) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'A different super administrator must provide the next approval' });
      await this.grants.consume(ctx.tx, context, resolutionActionBinding('APPROVE_FUNDS', caseId, input));
      await ctx.tx.resolutionApproval.create({ data: { resolutionId: resolution.id, actorId: context.actor.id, sessionId: context.sessionId, grantId: context.grantId, createdAt: ctx.now } });
      await ctx.tx.caseRecord.create({ data: { caseId, actorId: context.actor.id, kind: 'RESOLUTION_APPROVED', description: input.reason, details: { resolutionId: resolution.id, resolutionVersion: resolution.number, sessionId: context.sessionId, deviceId: context.deviceId, grantId: context.grantId }, createdAt: ctx.now } });
    });
  }
}

export function assertResolutionActionContext(context: OperatorActionContext, input: ResolutionApprovalInput): void {
  if (input.operatorAction.sessionId !== context.sessionId || input.operatorAction.grantId !== context.grantId) throw new ForbiddenException({ code: 'GRANT_INVALID', message: 'Action must use the current bound session and grant' });
}
export function resolutionActionBinding(action: 'APPROVE_FUNDS' | 'EXECUTE_FUNDS' | 'RESUME_ORDER', caseId: string, input: ResolutionApprovalInput) {
  return { action, resourceId: caseId, expectedVersions: { expectedCaseVersion: input.expectedCaseVersion, expectedOrderVersion: input.expectedOrderVersion, resolutionVersion: input.resolutionVersion }, requestHash: operatorRequestHash(input) };
}
