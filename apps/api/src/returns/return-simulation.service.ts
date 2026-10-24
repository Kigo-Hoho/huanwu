import { createHmac } from 'node:crypto';
import { ResolutionCommandSchema } from '@barter/contracts';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CaseCommandsService } from '../after-sales/case-commands.service.js';
import { currentResolution } from '../after-sales/resolution-policy.js';
import { PrismaService } from '../database/prisma.service.js';
import { INTEGRATION_CONFIG, integrationUnavailable, type IntegrationConfiguration } from '../integrations/integration-config.js';
import { SimulatedLogisticsAdapter } from '../integrations/simulated-logistics.adapter.js';
import { SimulatedProviderStore } from '../integrations/simulated-provider.store.js';
import { LOGISTICS_PORT, type LogisticsPort } from '../logistics/logistics.port.js';
import type { ReturnCommandContext } from './return-commands.service.js';
import { ReturnEventsService } from './return-events.service.js';
import { returnNotReady } from './return-plan.service.js';

const base = { ...ResolutionCommandSchema.shape, shipmentId: z.uuid() };
export const ReturnSimulationSchema = z.union([
  z.strictObject({ ...base, kind: z.literal('RETURN_PROGRESS'), progress: z.enum(['COLLECTED', 'DELIVERED', 'EXCEPTION']) }),
  z.strictObject({ ...base, kind: z.literal('ORIGINAL_SHIPMENT_CLOSED'), outcome: z.enum(['DELIVERED', 'INTERCEPTED']) }),
]);
export type ReturnSimulationInput = z.infer<typeof ReturnSimulationSchema>;

// A participant can trigger the selected external simulator. These requests are
// never provider callbacks or customer receipt confirmations. Only the adapter's
// signed, operation-bound facts enter the independent audited event transaction.
@Injectable()
export class ReturnSimulationService {
  constructor(
    @Inject(CaseCommandsService) private readonly commands: CaseCommandsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration,
    @Inject(LOGISTICS_PORT) private readonly port: LogisticsPort,
    @Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore,
    @Inject(ReturnEventsService) private readonly events: ReturnEventsService,
  ) {}
  async progress(context: ReturnCommandContext, raw: ReturnSimulationInput) {
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? '') || this.config.logistics !== 'simulated' || !(this.port instanceof SimulatedLogisticsAdapter)) throw integrationUnavailable();
    this.store.assertEnabled('logistics');
    const input = ReturnSimulationSchema.parse(raw);
    const businessNo = input.kind === 'RETURN_PROGRESS' ? `return:shipment:${input.shipmentId}` : `return:intercept:${input.shipmentId}`;
    const commandName = 'SIMULATED_RETURN_PROGRESS_ADMITTED';
    await this.commands.run({ ...context, input, commandName }, async ctx => {
      const resolution = currentResolution(ctx.case, input.resolutionVersion);
      if (ctx.case.status !== 'EXECUTING' || resolution.type !== 'RETURN_ORIGINALS' || !resolution.executions.some(e => e.executionStep === 'START') || !ctx.order.simulation) returnNotReady();
      const op = await ctx.tx.outboxCommand.findUnique({ where: { businessNo } });
      const payload = op?.payload as { caseId?: string; resolutionId?: string; shipmentId?: string } | undefined;
      if (!op || op.orderId !== ctx.order.id || op.kind !== (input.kind === 'RETURN_PROGRESS' ? 'VERIFY_RETURN' : 'CLOSE_OR_INTERCEPT') || payload?.caseId !== ctx.case.id || payload.resolutionId !== resolution.id || payload.shipmentId !== input.shipmentId) returnNotReady('Simulation operation association is invalid');
      if (input.kind === 'RETURN_PROGRESS') {
        const shipment = await ctx.tx.returnShipment.findUnique({ where: { id: input.shipmentId } });
        if (!shipment || shipment.resolutionId !== resolution.id || shipment.businessNo !== businessNo) returnNotReady();
        if ((shipment.holderSide === 'INITIATOR' ? ctx.order.initiatorId : ctx.order.recipientId) !== context.actor.id) throw new ForbiddenException('Only the simulated return sender can trigger progress');
        if (input.progress === 'DELIVERED' && !shipment.collectedAt) returnNotReady('Collection must precede simulated delivery');
      } else {
        const shipment = ctx.order.shipments.find(s => s.id === input.shipmentId);
        if (!shipment) returnNotReady();
        if ((shipment.side === 'INITIATOR' ? ctx.order.initiatorId : ctx.order.recipientId) !== context.actor.id) throw new ForbiddenException('Only the original sender can trigger simulated closure');
        if (input.outcome === 'DELIVERED' && !shipment.deliveredAt && shipment.status !== 'DELIVERED') returnNotReady('Original delivery must already be verified');
        if (input.outcome === 'INTERCEPTED' && (shipment.deliveredAt || shipment.status === 'DELIVERED')) returnNotReady('Delivered originals cannot be intercepted');
      }
    });
    const admission = await this.prisma.idempotencyRecord.findUniqueOrThrow({ where: { actorId_commandName_key: { actorId: context.actor.id, commandName, key: context.key } } });
    const candidate = { provider: 'simulated', eventId: `return-simulation:${admission.id}`, businessNo, occurredAt: admission.createdAt.toISOString(), shipmentId: input.shipmentId, ...(input.kind === 'RETURN_PROGRESS' ? { kind: input.kind, progress: input.progress } : { kind: input.kind, outcome: input.outcome }) };
    const bytes = JSON.stringify(candidate);
    const event = this.port.verifySignedEvent(bytes, createHmac('sha256', this.config.signingKey!).update(bytes).digest('hex'));
    const saved = await this.prisma.integrationEvent.findUnique({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, include: { receipt: true } });
    // Old successful commands must replay even after the simulator advanced.
    if (saved?.receipt?.status !== 'PROCESSED') {
      await this.store.recordEvent(event);
      await this.events.applyVerified(event);
    }
    return { simulation: true, accepted: true };
  }
}
