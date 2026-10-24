import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { OrderDeadlineExtensionSchema, ResolutionCommandSchema, type OrderDeadlineExtensionInput } from '@barter/contracts';
import { ActionGrantService } from '../operator-security/action-grant.service.js';
import type { OperatorActionContext } from '../operator-security/operator-action.types.js';
import { CaseCommandsService } from './case-commands.service.js';
import type { CaseCommandContext } from './case.types.js';
import { currentResolution } from './resolution-policy.js';
import { assertResolutionActionContext, resolutionActionBinding } from './resolution-approval.service.js';
import { CaseFinalizationService } from './case-finalization.service.js';
import { OrderInterventionService } from './order-intervention.service.js';
@Injectable()
export class InterventionCommandsService {
  constructor(@Inject(CaseCommandsService) private readonly commands: CaseCommandsService, @Inject(ActionGrantService) private readonly grants: ActionGrantService, @Inject(OrderInterventionService) private readonly intervention: OrderInterventionService, @Inject(CaseFinalizationService) private readonly finalization: CaseFinalizationService) {}
  keep(context: CaseCommandContext) {
    const input = ResolutionCommandSchema.parse(context.input);
    return this.commands.run({ ...context, input }, async ctx => {
      const resolution = currentResolution(ctx.case, input.resolutionVersion);
      const side = ctx.order.initiatorId === ctx.actor!.id ? 'INITIATOR' : 'RECIPIENT';
      const party = ctx.order.parties.find(p => p.side === side);
      if (ctx.case.status !== 'EXECUTING' || resolution.type !== 'KEEP_WITH_COMPENSATION' || !party?.incomingDeliveredAt) throw new ConflictException('Independent receipt is required');
      if (!ctx.case.records.some(r => r.kind === 'KEEP_CONFIRMED' && r.actorId === ctx.actor!.id && (r.details as { resolutionId?: string })?.resolutionId === resolution.id)) {
        await ctx.tx.caseRecord.create({ data: { caseId: ctx.case.id, actorId: ctx.actor!.id, kind: 'KEEP_CONFIRMED', description: '用户确认已收到并保留全部物品', details: { resolutionId: resolution.id, side }, createdAt: ctx.now } });
        if (!party.acceptedAt) await ctx.tx.orderPartyProgress.update({ where: { id: party.id }, data: { acceptedAt: ctx.now } });
      }
      await this.finalization.reconcileInTransaction(ctx);
    });
  }
  extend(context: OperatorActionContext, caseId: string, raw: OrderDeadlineExtensionInput, key: string) {
    const input = OrderDeadlineExtensionSchema.parse(raw);
    assertResolutionActionContext(context, input);
    return this.commands.run({ actor: context.actor, operatorSession: context, requiredAction: 'RESUME_ORDER', caseId, input, key, commandName: 'CASE_DEADLINE_EXTENDED' }, async ctx => {
      currentResolution(ctx.case, input.resolutionVersion);
      await this.grants.consume(ctx.tx, context, resolutionActionBinding('RESUME_ORDER', caseId, input));
      await this.intervention.extendDeadlineInTransaction(ctx, input);
      await ctx.tx.caseRecord.create({ data: { caseId, actorId: context.actor.id, kind: 'DEADLINE_EXTENDED', description: input.reason, details: { kind: input.kind, side: input.side ?? null }, createdAt: ctx.now } });
    });
  }
}
