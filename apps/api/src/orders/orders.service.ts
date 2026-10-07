import { OrderCommandResultSchema, type OrderCommandInput, type OrderCommandResult, type OrderListView, type OrderView } from '@barter/contracts';
import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertPureCustomer } from '../auth/customer-only.guard.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { assertProposalParticipant, ProposalOrderHandoffService } from '../proposals/proposal-order-handoff.service.js';
import { mapProposal, proposalInclude } from '../proposals/proposal.mapper.js';
import { ProposalsService } from '../proposals/proposals.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { assertOrderParticipant, orderRequestHash, replayOrderCommand, uniqueConflict } from './order-commands.service.js';
import { mapOrder } from './order.mapper.js';
import { readOrder, readOrderRelations } from './order-reader.js';
import { testOrderRules } from './order-rules.js';
import { OrderExpiryService } from './order-expiry.service.js';
import { orderListQuery, orderNextCursor, type OrderListQuery } from './order-list-query.js';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ProposalOrderHandoffService) private readonly handoff: ProposalOrderHandoffService,
    @Inject(ProposalsService) private readonly proposals: ProposalsService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(OrderExpiryService) private readonly expiry: OrderExpiryService,
  ) {}
  async convert(actor: AuthenticatedUser, id: string, input: OrderCommandInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    assertPureCustomer(actor);
    const identity = { actorId: actor.id, commandName: 'CONVERT_PROPOSAL_TO_ORDER', key };
    const where = { actorId_commandName_key: identity };
    const requestHash = orderRequestHash(id, input);
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Proposal" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const proposal = await tx.proposal.findUnique({ where: { id }, include: proposalInclude });
        assertProposalParticipant(proposal, actor.id);
        const previous = await tx.idempotencyRecord.findUnique({ where });
        if (previous) return replayOrderCommand(previous, requestHash);
        const simulated = process.env.PAYMENT_PROVIDER === 'simulated' || process.env.LOGISTICS_PROVIDER === 'simulated';
        if (process.env.NODE_ENV === 'production' || (simulated && !['development', 'test'].includes(process.env.NODE_ENV ?? ''))) throw new ServiceUnavailableException({ code: 'INTEGRATION_UNAVAILABLE', message: 'Order rules and integrations are unavailable in this environment' });
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: {} } });
        const offer = await this.handoff.prepare(tx, actor.id, id, input.expectedVersion, this.clock.now());
        const now = this.clock.now();
        if (offer.proposal.reservationExpiresAt && now >= offer.proposal.reservationExpiresAt) throw new ConflictException({ code: 'PROPOSAL_EXPIRED', message: 'Proposal has expired' });
        const rules = testOrderRules();
        const current = offer.currentVersion;
        const courier = current.deliveryMode === 'COURIER';
        const deadline = new Date(now.getTime() + (courier ? rules.detailsHours : rules.paymentHours) * 3600000);
        const order = await tx.order.create({ data: {
          proposalId: id, proposalVersionId: offer.proposalVersionId, initiatorId: offer.initiatorId, recipientId: offer.recipientId,
          status: courier ? 'AWAITING_DETAILS' : 'AWAITING_PAYMENT',
          rulesVersion: rules.version, depositFen: rules.depositFen, feeFen: rules.feeFen, detailsHours: rules.detailsHours, paymentHours: rules.paymentHours, fulfillmentHours: rules.fulfillmentHours, inspectionHours: rules.inspectionHours,
          differenceFen: current.differenceFen, payer: current.payer, deliveryMode: current.deliveryMode, initiatorShippingFen: current.initiatorShippingFen, recipientShippingFen: current.recipientShippingFen,
          simulation: simulated,
          detailsDeadline: courier ? deadline : null, paymentDeadline: courier ? null : deadline,
          createdAt: now,
        } });
        await tx.orderItemSnapshot.createMany({ data: current.items.map(item => ({ orderId: order.id, itemId: item.itemId, ownerId: item.ownerId, side: item.side, sortOrder: item.sortOrder, itemVersion: item.itemVersion, title: item.title, description: item.description, referenceValueFen: item.referenceValueFen, condition: item.condition, wantedText: item.wantedText, imageUrls: item.imageUrls })) });
        await tx.orderPartyProgress.createMany({ data: [{ orderId: order.id, side: 'INITIATOR' }, { orderId: order.id, side: 'RECIPIENT' }] });
        try { await this.reservations.handoffToOrder(tx, id, order.id, offer.itemIds); }
        catch (error) {
          if (error instanceof ConflictException && offer.proposal.reservationExpiresAt && this.clock.now() >= offer.proposal.reservationExpiresAt) throw new ConflictException({ code: 'PROPOSAL_EXPIRED', message: 'Proposal has expired' });
          throw error;
        }
        await this.handoff.markConverted(tx, id, order.id);
        const created = await readOrder(tx, order.id);
        assertOrderParticipant(created, actor.id);
        const result = OrderCommandResultSchema.parse({ order: mapOrder(created) });
        await this.audit.record(tx, { actorId: actor.id, action: 'ORDER_CREATED', entityType: 'Order', entityId: order.id, requestId, after: result.order as unknown as Prisma.InputJsonValue });
        const converted = mapProposal(await tx.proposal.findUniqueOrThrow({ where: { id }, include: proposalInclude }));
        await this.audit.record(tx, { actorId: actor.id, action: 'PROPOSAL_CONVERTED', entityType: 'Proposal', entityId: id, requestId, before: mapProposal(proposal) as unknown as Prisma.InputJsonValue, after: converted as unknown as Prisma.InputJsonValue });
        await tx.idempotencyRecord.update({ where, data: { response: result as unknown as Prisma.InputJsonValue } });
        return result;
      });
    } catch (error) {
      if (error instanceof ConflictException && (error.getResponse() as { code?: string }).code === 'PROPOSAL_EXPIRED') { await this.proposals.expire(id); throw error; }
      if (!uniqueConflict(error)) throw error;
      const proposal = await this.prisma.proposal.findUnique({ where: { id }, include: proposalInclude });
      assertProposalParticipant(proposal, actor.id);
      const previous = await this.prisma.idempotencyRecord.findUnique({ where });
      if (previous) return replayOrderCommand(previous, requestHash);
      throw new ConflictException({ code: 'ORDER_ALREADY_EXISTS', message: 'Order conversion conflicted' });
    }
  }
  async detail(actor: AuthenticatedUser, id: string): Promise<OrderView> {
    assertPureCustomer(actor);
    assertOrderParticipant(await readOrder(this.prisma, id), actor.id);
    await this.expiry.reconcile(id);
    return this.prisma.$transaction(async tx => {
      const order = await readOrder(tx, id);
      assertOrderParticipant(order, actor.id);
      return mapOrder(order);
    }, { isolationLevel: 'RepeatableRead' });
  }
  async list(actor: AuthenticatedUser, query: OrderListQuery): Promise<OrderListView> {
    assertPureCustomer(actor);
    const { limit, after } = orderListQuery(query);
    // Reconcile only this participant's orders before applying status filters:
    // an expired AWAITING_DETAILS order now belongs in the CANCELLED filter.
    const candidates = await this.prisma.order.findMany({ where: { OR: [{ initiatorId: actor.id }, { recipientId: actor.id }], status: { in: ['AWAITING_DETAILS', 'AWAITING_PAYMENT', 'AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'] } }, select: { id: true } });
    for (const candidate of candidates) await this.expiry.reconcile(candidate.id);
    return this.prisma.$transaction(async tx => {
      const orders = await tx.order.findMany({ where: {
        AND: [
          { OR: [{ initiatorId: actor.id }, { recipientId: actor.id }] },
          ...(after ? [after] : []),
        ], ...(query.status ? { status: query.status } : {}),
      }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const page = orders.slice(0, limit); const last = page.at(-1);
      return { items: (await readOrderRelations(tx, page)).map(mapOrder), nextCursor: orderNextCursor(orders.length > limit, last) };
    }, { isolationLevel: 'RepeatableRead' });
  }
}
