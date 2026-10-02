import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { proposalInclude } from './proposal.mapper.js';

type ConfirmedProposal = Prisma.ProposalGetPayload<{ include: typeof proposalInclude }>;
export interface ConfirmedOffer {
  proposal: ConfirmedProposal;
  proposalId: string;
  proposalVersionId: string;
  initiatorId: string;
  recipientId: string;
  currentVersion: ConfirmedProposal['versions'][number];
  itemIds: string[];
}
export function assertProposalParticipant(proposal: ConfirmedProposal | null, actorId: string): asserts proposal is ConfirmedProposal {
  if (!proposal || (proposal.initiatorId !== actorId && proposal.recipientId !== actorId)) throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Proposal was not found' });
}
function expired(): ConflictException { return new ConflictException({ code: 'PROPOSAL_EXPIRED', message: 'Proposal has expired' }); }
function unavailable(): ConflictException { return new ConflictException({ code: 'ITEM_UNAVAILABLE', message: 'Confirmed items are unavailable' }); }

@Injectable()
export class ProposalOrderHandoffService {
  constructor(@Inject(ReservationsService) private readonly reservations: ReservationsService, @Inject(CLOCK) private readonly clock: Clock) {}

  async prepare(tx: Prisma.TransactionClient, actorId: string, proposalId: string, expectedVersion: number, now: Date): Promise<ConfirmedOffer> {
    await tx.$queryRaw`SELECT "id" FROM "Proposal" WHERE "id" = ${proposalId}::uuid FOR UPDATE`;
    const proposal = await tx.proposal.findUnique({ where: { id: proposalId }, include: proposalInclude });
    assertProposalParticipant(proposal, actorId);
    if (proposal.status === 'CONVERTED') throw new ConflictException({ code: 'PROPOSAL_ALREADY_CONVERTED', message: 'Proposal already has an order', orderId: proposal.order?.id ?? null });
    const lockedNow = new Date(Math.max(now.getTime(), this.clock.now().getTime()));
    if (proposal.status === 'EXPIRED' || (proposal.status === 'CONFIRMED' && proposal.reservationExpiresAt && proposal.reservationExpiresAt <= lockedNow)) throw expired();
    if (proposal.version !== expectedVersion) throw new ConflictException({ code: 'PROPOSAL_VERSION_CONFLICT', message: 'Proposal has changed' });
    if (proposal.status !== 'CONFIRMED') throw new ConflictException({ code: 'PROPOSAL_INVALID_STATE', message: 'Only confirmed proposals can be converted' });
    const currentVersion = proposal.versions.find(version => version.number === proposal.currentVersion);
    if (!currentVersion) throw unavailable();
    const itemIds = currentVersion.items.map(item => item.itemId);
    const initiatorItems = currentVersion.items.filter(item => item.side === 'INITIATOR');
    if (initiatorItems.length < 1 || initiatorItems.length > 5 || currentVersion.items.filter(item => item.side === 'RECIPIENT').length !== 1) throw unavailable();
    await this.reservations.lockItems(tx, itemIds);
    const handoffNow = this.clock.now();
    if (proposal.reservationExpiresAt && proposal.reservationExpiresAt <= handoffNow) throw expired();
    await this.reservations.assertProposalLease(tx, proposalId, currentVersion.id, itemIds, handoffNow);
    const items = await tx.item.findMany({ where: { id: { in: itemIds } } });
    if (items.length !== itemIds.length) throw unavailable();
    for (const snapshot of currentVersion.items) {
      const ownerId = snapshot.side === 'INITIATOR' ? proposal.initiatorId : proposal.recipientId;
      const item = items.find(item => item.id === snapshot.itemId)!;
      if (snapshot.ownerId !== ownerId || item.ownerId !== ownerId || item.status !== 'ACTIVE') throw unavailable();
    }
    return { proposal, proposalId, proposalVersionId: currentVersion.id, initiatorId: proposal.initiatorId, recipientId: proposal.recipientId, currentVersion, itemIds };
  }
  async markConverted(tx: Prisma.TransactionClient, proposalId: string, orderId: string): Promise<void> {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { proposalId: true } });
    if (order?.proposalId !== proposalId) throw unavailable();
    const result = await tx.proposal.updateMany({ where: { id: proposalId, status: 'CONFIRMED' }, data: { status: 'CONVERTED', version: { increment: 1 } } });
    if (result.count !== 1) throw new ConflictException({ code: 'PROPOSAL_INVALID_STATE', message: 'Proposal cannot be converted' });
  }
}
