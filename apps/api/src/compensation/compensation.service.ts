import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { OriginalFundsPlanSchema, ResolutionCommandSchema, type CaseCommandResult, type CompensationCheckoutView } from '@barter/contracts';
import { CaseCommandsService } from '../after-sales/case-commands.service.js';
import type { CaseCommandContext, CaseMutationContext } from '../after-sales/case.types.js';
import { RESOLUTION_EXECUTORS, type ExecutableResolution, type ResolutionExecutors } from '../after-sales/resolution-executor.port.js';
import { currentResolution } from '../after-sales/resolution-policy.js';
import { assertCaseParticipant, assertCurrentCustomer } from '../after-sales/case-policy.js';
import { readCase } from '../after-sales/case-reader.js';
import { readOrder } from '../orders/order-reader.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { SimulatedProviderStore } from '../integrations/simulated-provider.store.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ReturnPlanService } from '../returns/return-plan.service.js';
import { CaseExpiryService } from '../after-sales/case-expiry.service.js';

export const fundsUnresolved = () => new ConflictException({ code: 'FUNDS_UNRESOLVED', message: 'Current compensation obligation is not ready' });
@Injectable()
export class CompensationService implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CaseCommandsService) private readonly commands: CaseCommandsService, @Inject(RESOLUTION_EXECUTORS) private readonly registry: ResolutionExecutors, @Inject(OutboxService) private readonly outbox: OutboxService, @Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore, @Inject(CLOCK) private readonly clock: Clock, @Inject(ReturnPlanService) private readonly returns: ReturnPlanService, @Inject(CaseExpiryService) private readonly expiry: CaseExpiryService) {}
  onModuleInit() {
    // This planner records funds only. START remains pending for Task10's order
    // finalization; no order is resumed/completed merely by accepting this plan.
    for (const type of ['KEEP_WITH_COMPENSATION', 'CONTINUE_EXCHANGE', 'FUNDS_ONLY', 'CANCEL_BEFORE_HANDOVER'] as const) this.registry.set(type, this);
    this.registry.set('RETURN_ORIGINALS', { planInTransaction: async (ctx, resolution) => { await this.returns.planInTransaction(ctx, resolution); await this.planInTransaction(ctx, resolution); } });
  }
  async planInTransaction(ctx: CaseMutationContext, resolution: ExecutableResolution): Promise<void> {
    if (resolution.caseId !== ctx.case.id) throw fundsUnresolved();
    for (const target of OriginalFundsPlanSchema.parse(resolution.originalFunds)) {
      if (target.destination === 'RETAIN_FOR_EXCHANGE') continue;
      const p = await ctx.tx.paymentIntent.findUniqueOrThrow({ where: { id: target.paymentIntentId }, include: { entries: true } });
      if (p.orderId !== ctx.order.id) throw fundsUnresolved();
      if (p.entries.some(e => e.entryType !== 'PAYMENT') || p.status === 'CLOSED') continue;
      if (!p.entries.some(e => e.entryType === 'PAYMENT') || p.status !== 'PAID') throw fundsUnresolved();
      const refund = target.destination === 'REFUND_PAYER';
      await this.outbox.enqueue(ctx.tx, { orderId: ctx.order.id, businessNo: `${refund ? 'refund' : 'settle'}:${p.id}`, kind: refund ? 'REFUND_PAYMENT' : 'SETTLE_DIFFERENCE', payload: { paymentBusinessNo: p.businessNo, amountFen: p.amountFen, currency: 'CNY', caseId: ctx.case.id, resolutionId: resolution.id } });
    }
    if (!resolution.netCompensationFen) return;
    if (resolution.compensationPayer === 'NONE') throw fundsUnresolved();
    const components = resolution.compensationComponents as { originalDifferenceReversal: { amountFen: number } };
    const original = components.originalDifferenceReversal.amountFen ? await ctx.tx.paymentIntent.findFirst({ where: { orderId: ctx.order.id, purpose: 'DIFFERENCE', entries: { some: { entryType: 'DIFFERENCE_SETTLEMENT' } } } }) : null;
    if (components.originalDifferenceReversal.amountFen && !original) throw fundsUnresolved();
    await ctx.tx.compensationObligation.create({ data: { resolutionId: resolution.id, rootDisputeId: ctx.case.rootDisputeId, executionStep: 'NET_COMPENSATION', originalPaymentIntentId: original?.id, payerSide: resolution.compensationPayer, payeeSide: resolution.compensationPayer === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR', amountFen: resolution.netCompensationFen, currency: 'CNY', paymentDeadline: new Date(ctx.now.getTime() + 72 * 3600000), progress: { create: {} } } });
  }
  async requestPayment(context: CaseCommandContext): Promise<CaseCommandResult> {
    const input = ResolutionCommandSchema.parse(context.input);
    return this.commands.run({ ...context, input, commandName: 'COMPENSATION_PAYMENT_REQUESTED' }, async ctx => {
      this.store.assertEnabled('payment');
      const resolution = currentResolution(ctx.case, input.resolutionVersion);
      if (ctx.case.status !== 'EXECUTING') throw fundsUnresolved();
      const obligation = await ctx.tx.compensationObligation.findFirst({ where: { resolutionId: resolution.id }, include: { payment: true, progress: true } });
      if (!obligation) throw fundsUnresolved();
      if ((obligation.payerSide === 'INITIATOR' ? ctx.order.initiatorId : ctx.order.recipientId) !== ctx.actor!.id) throw new ForbiddenException();
      if (obligation.paymentDeadline <= ctx.now || !['PENDING', 'AUTHORIZED'].includes(obligation.progress?.status ?? '')) throw fundsUnresolved();
      if (obligation.payment) return;
      const id = randomUUID();
      const businessNo = `compensation:payment:${id}`;
      await ctx.tx.compensationPayment.create({ data: { id, businessNo, obligationId: obligation.id, provider: 'simulated', amountFen: obligation.amountFen } });
      await ctx.tx.compensationProgress.update({ where: { obligationId: obligation.id }, data: { status: 'AUTHORIZED', authorizedAt: ctx.now } });
      await this.outbox.enqueue(ctx.tx, { orderId: ctx.order.id, businessNo, kind: 'CREATE_COMPENSATION', payload: { paymentId: id, caseId: ctx.case.id, resolutionId: resolution.id, amountFen: obligation.amountFen, currency: 'CNY' } });
    });
  }
  async getCheckout(actor: AuthenticatedUser, caseId: string, paymentId: string): Promise<CompensationCheckoutView> {
    this.store.assertEnabled('payment');
    const authorize = () => this.prisma.$transaction(async tx => {
      await assertCurrentCustomer(tx, actor);
      const located = await tx.afterSalesCase.findUnique({ where: { id: caseId } });
      if (!located) throw new NotFoundException();
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${located.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
      const value = await readCase(tx, caseId); const order = await readOrder(tx, located.orderId);
      assertCaseParticipant(order, value, actor.id);
      const payment = await tx.compensationPayment.findUnique({ where: { id: paymentId }, include: { obligation: { include: { resolution: true } } } });
      if (!payment || payment.obligation.resolution.caseId !== caseId) throw new NotFoundException();
      if ((payment.obligation.payerSide === 'INITIATOR' ? order!.initiatorId : order!.recipientId) !== actor.id) throw new ForbiddenException();
      if (value.status !== 'EXECUTING' || value.currentResolutionVersion !== payment.obligation.resolution.number || !['CREATED', 'PENDING'].includes(payment.status) || payment.obligation.paymentDeadline <= this.clock.now()) throw fundsUnresolved();
      return payment;
    });
    let payment;
    try { payment = await authorize(); }
    catch (error) {
      if (error instanceof ConflictException && (error.getResponse() as { code?: string }).code === 'FUNDS_UNRESOLVED') await this.expiry.reconcile(caseId);
      throw error;
    }
    const result = await this.store.query(payment.businessNo, ['CREATE_COMPENSATION']);
    await authorize();
    return result.status === 'PENDING' ? { paymentId, status: 'READY', provider: 'simulated', params: { simulation: 'true', businessNo: payment.businessNo } } : { paymentId, status: 'PENDING' };
  }
}
