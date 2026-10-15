import { randomUUID } from 'node:crypto';
import { ReturnShipmentSchema, ReturnHandoverSchema, ReturnConfirmSchema, ReturnViewSchema, type ReturnShipmentInput, type ReturnHandoverInput, type ReturnConfirmInput } from '@barter/contracts';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { CaseCommandsService } from '../after-sales/case-commands.service.js';
import type { CaseCommandContext, CaseMutationContext } from '../after-sales/case.types.js';
import { currentResolution } from '../after-sales/resolution-policy.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { INTEGRATION_CONFIG, integrationUnavailable, type IntegrationConfiguration } from '../integrations/integration-config.js';
import { returnNotReady } from './return-plan.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertCaseParticipant, assertCurrentCustomer } from '../after-sales/case-policy.js';
import { readCase } from '../after-sales/case-reader.js';
import { readOrder } from '../orders/order-reader.js';
import { RiskTaskService } from '../risk/risk-task.service.js';

export type ReturnCommandContext = Omit<CaseCommandContext, 'input'|'commandName'>;
@Injectable()
export class ReturnCommandsService {
  constructor(@Inject(CaseCommandsService) private readonly commands: CaseCommandsService, @Inject(OutboxService) private readonly outbox: OutboxService, @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration, @Inject(PrismaService) private readonly prisma: PrismaService, @Inject(RiskTaskService) private readonly risks: RiskTaskService) {}
  list(actor: AuthenticatedUser, caseId: string) {
    return this.prisma.$transaction(async tx => {
      await assertCurrentCustomer(tx, actor);
      const value = await readCase(tx, caseId);
      const order = value ? await readOrder(tx, value.orderId) : null;
      assertCaseParticipant(order, value, actor.id);
      return value.resolutions.flatMap(r => r.returnObligations).map(o => ReturnViewSchema.parse({ id: o.id, version: o.progress?.version ?? 1, itemSnapshotId: o.itemSnapshotId, holderSide: o.holderSide, ownerSide: o.ownerSide, status: o.progress?.status ?? 'UNKNOWN', registrationDeadline: o.registrationDeadline.toISOString(), receiptDeadline: o.progress?.receiptDeadline?.toISOString() ?? null, confirmedAt: o.progress?.confirmedAt?.toISOString() ?? null }));
    }, { isolationLevel: 'RepeatableRead' });
  }
  async registerShipment(context: ReturnCommandContext, raw: ReturnShipmentInput) {
    const parsed = ReturnShipmentSchema.safeParse(raw); if (!parsed.success) invalid(); const input = parsed.data;
    try {
      return await this.commands.run({ ...context, input, commandName: 'RETURN_SHIPMENT_REGISTERED' }, async ctx => {
        if (this.config.logistics === 'disabled') throw integrationUnavailable();
        const { resolution, obligations: ownObligations, own } = await active(ctx, input.resolutionVersion);
        if (ctx.order.deliveryMode !== 'COURIER') returnNotReady();
        const obligations = assertSelected(ownObligations, input.obligationIds, input.obligationVersions);
        const source = ctx.order.shipments.find(s => s.side !== own);
        if (!source) returnNotReady('Original shipment association is missing');
        const closure = await ctx.tx.originalShipmentClosure.findUnique({ where: { shipmentId: source.id } });
        if (closure?.outcome !== 'DELIVERED') returnNotReady('Reconcile and close or intercept the original shipment first');
        const destination = await ctx.tx.returnAddress.findUnique({ where: { caseId_side: { caseId: ctx.case.id, side: source.side } } });
        if (!destination?.frozenAt) returnNotReady('Frozen original-owner address is required');
        const shipmentId = randomUUID();
        await ctx.tx.returnShipment.create({ data: { id: shipmentId, resolutionId: resolution.id, holderSide: own, ownerSide: source.side, carrier: input.carrier, trackingNumber: input.trackingNumber, businessNo: `return:shipment:${shipmentId}`, registeredAt: ctx.now, items: { create: obligations.map(o => ({ obligationId: o.id })) } } });
        for (const obligation of obligations) {
          await ctx.tx.returnProgress.update({ where: { obligationId: obligation.id }, data: { status: 'REGISTERED', version: { increment: 1 } } });
          await ctx.tx.returnEvent.create({ data: { obligationId: obligation.id, shipmentId, actorId: context.actor.id, kind: 'REGISTERED', occurredAt: ctx.now } });
        }
        await this.outbox.enqueue(ctx.tx, { orderId: ctx.order.id, kind: 'VERIFY_RETURN', businessNo: `return:shipment:${shipmentId}`, payload: { shipmentId, caseId: ctx.case.id, resolutionId: resolution.id, carrier: input.carrier, trackingNumber: input.trackingNumber, addressId: destination.id, addressVersion: destination.version } });
      });
    } catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new ConflictException({ code: 'TRACKING_NUMBER_IN_USE', message: 'Tracking number is already registered' }); throw error; }
  }
  handBack(context: ReturnCommandContext, raw: ReturnHandoverInput) {
    const parsed = ReturnHandoverSchema.safeParse(raw); if (!parsed.success) invalid(); const input = parsed.data;
    return this.commands.run({ ...context, input, commandName: 'RETURN_HANDED_BACK' }, async ctx => {
      const { obligations: ownObligations } = await active(ctx, input.resolutionVersion);
      if (ctx.order.deliveryMode !== 'IN_PERSON') returnNotReady();
      // Validate ownership before coverage: an original owner cannot impersonate a holder.
      const selected = await ctx.tx.returnObligation.findMany({ where: { id: { in: input.obligationIds }, resolutionId: currentResolution(ctx.case, input.resolutionVersion).id } });
      if (selected.some(o => !ownObligations.some(own => own.id === o.id))) throw new ForbiddenException('Only the actual holder can hand back originals');
      const obligations = assertSelected(ownObligations, input.obligationIds, input.obligationVersions);
      for (const o of obligations) {
        await ctx.tx.returnProgress.update({ where: { obligationId: o.id }, data: { status: 'DELIVERED', handedOverAt: ctx.now, receiptDeadline: new Date(ctx.now.getTime() + 72 * 3600000), version: { increment: 1 } } });
        await ctx.tx.returnEvent.create({ data: { obligationId: o.id, actorId: context.actor.id, kind: 'HANDED_BACK', occurredAt: ctx.now } });
      }
    });
  }
  confirmReceived(context: ReturnCommandContext, raw: ReturnConfirmInput) {
    const parsed = ReturnConfirmSchema.safeParse(raw); if (!parsed.success) invalid(); const input = parsed.data;
    return this.commands.run({ ...context, input, commandName: 'RETURN_RECEIPT_DECIDED' }, async ctx => {
      const { resolution, own } = await active(ctx, input.resolutionVersion);
      const obligation = await ctx.tx.returnObligation.findUnique({ where: { id: input.obligationId }, include: { progress: true } });
      if (!obligation || obligation.resolutionId !== resolution.id) returnNotReady();
      if (obligation.ownerSide !== own) throw new ForbiddenException('Only the original owner can confirm receipt');
      if (obligation.progress?.version !== input.expectedObligationVersion) versionConflict();
      if (obligation.progress.status !== 'DELIVERED') returnNotReady('Delivery evidence or a holder handback is required');
      await ctx.tx.returnProgress.update({ where: { obligationId: obligation.id }, data: { status: input.decision === 'CONFIRM' ? 'CONFIRMED' : 'DISPUTED', confirmedAt: input.decision === 'CONFIRM' ? ctx.now : null, version: { increment: 1 } } });
      await ctx.tx.returnEvent.create({ data: { obligationId: obligation.id, actorId: context.actor.id, kind: input.decision === 'CONFIRM' ? 'OWNER_CONFIRMED' : 'OWNER_DISPUTED', details: input.reason ? { reason: input.reason } : undefined, occurredAt: ctx.now } });
      if (input.decision === 'DISPUTE') await this.risks.recordInTransaction(ctx.tx, { sourceKey: `return:disputed:${obligation.id}`, kind: 'RETURN_DISPUTED', caseId: ctx.case.id, orderId: ctx.order.id, description: 'Original owner disputes the returned item; manual review is required' });
    });
  }
}
async function active(ctx: CaseMutationContext, version: number) {
  const resolution = currentResolution(ctx.case, version);
  if (ctx.case.status !== 'EXECUTING' || resolution.type !== 'RETURN_ORIGINALS' || !resolution.executions.some(e => e.executionStep === 'START')) returnNotReady('Return plan is not executing');
  await ctx.tx.$queryRaw`SELECT id FROM "ReturnObligation" WHERE "resolutionId" = ${resolution.id}::uuid ORDER BY id FOR UPDATE`;
  const own = ctx.order.initiatorId === ctx.actor?.id ? 'INITIATOR' : 'RECIPIENT';
  const obligations = await ctx.tx.returnObligation.findMany({ where: { resolutionId: resolution.id, holderSide: own }, include: { progress: true } });
  return { resolution, own, obligations } as const;
}
function assertSelected(obligations: Awaited<ReturnType<typeof active>>['obligations'], ids: string[], versions: { obligationId: string; expectedVersion: number }[]) {
  const selected = obligations.filter(o => ids.includes(o.id));
  if (!selected.length || selected.length !== ids.length) returnNotReady('Every declared snapshot must belong to this return direction');
  for (const o of selected) {
    if (!o.progress || o.progress.version !== versions.find(v => v.obligationId === o.id)?.expectedVersion) versionConflict();
    if (o.progress.status !== 'PENDING') returnNotReady();
  }
  return selected;
}
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid return command' }); }
function versionConflict(): never { throw new ConflictException({ code: 'RETURN_VERSION_CONFLICT', message: 'Return obligation has changed' }); }
