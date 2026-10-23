import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ResolutionCommandSchema, type CaseCommandResult } from '@barter/contracts';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CaseCommandsService } from '../after-sales/case-commands.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { SimulatedProviderStore } from '../integrations/simulated-provider.store.js';
import { CompensationService, fundsUnresolved } from './compensation.service.js';
import { CompensationEventsService } from './compensation-events.service.js';
import { CompensationOutboxHandler } from './compensation-outbox.handler.js';
import type { ProviderOperation } from '../integrations/integration.types.js';
@Injectable()
export class CompensationSimulationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CaseCommandsService) private readonly commands: CaseCommandsService, @Inject(CompensationService) private readonly service: CompensationService, @Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore, @Inject(CompensationEventsService) private readonly events: CompensationEventsService, @Inject(CompensationOutboxHandler) private readonly handler: CompensationOutboxHandler) {}
  async complete(actor: AuthenticatedUser, paymentId: string, raw: unknown, key: string): Promise<CaseCommandResult> {
    this.store.assertEnabled('payment');
    const input = ResolutionCommandSchema.parse(raw);
    const p = await this.prisma.compensationPayment.findUnique({ where: { id: paymentId }, include: { obligation: { include: { resolution: true } } } });
    if (!p) throw new NotFoundException();
    const commandName = 'COMPENSATION_SIMULATION_ADMITTED';
    const normalized = { ...input, paymentId };
    const result = await this.commands.run({ actor, caseId: p.obligation.resolution.caseId, input: normalized, key, commandName }, async ctx => {
      if ((p.obligation.payerSide === 'INITIATOR' ? ctx.order.initiatorId : ctx.order.recipientId) !== actor.id) throw fundsUnresolved();
      if (ctx.case.status !== 'EXECUTING' || ctx.case.currentResolutionVersion !== input.resolutionVersion || input.resolutionVersion !== p.obligation.resolution.number || p.obligation.paymentDeadline <= ctx.now) throw fundsUnresolved();
    });
    let external = await this.store.query(p.businessNo);
    if (external.status === 'PENDING') {
      await this.service.getCheckout(actor, p.obligation.resolution.caseId, paymentId);
      const command = await this.prisma.outboxCommand.findUniqueOrThrow({ where: { businessNo: p.businessNo } });
      if (!await this.handler.authorize({ businessNo: command.businessNo, orderId: command.orderId, kind: command.kind, payload: command.payload as ProviderOperation['payload'] })) throw fundsUnresolved();
      const admission = await this.prisma.idempotencyRecord.findUniqueOrThrow({ where: { actorId_commandName_key: { actorId: actor.id, commandName, key } } });
      await this.store.recordEvent({ provider: 'simulated', eventId: `compensation:complete:${p.id}`, businessNo: p.businessNo, kind: 'PAYMENT_SUCCEEDED', externalTransactionId: `simulated-compensation:${p.id}`, amountFen: p.amountFen, currency: 'CNY', occurredAt: admission.createdAt.toISOString() });
      external = await this.store.query(p.businessNo);
    }
    if (external.status !== 'SUCCESS') throw fundsUnresolved();
    await this.events.applyVerified(external.event);
    return result;
  }
}
