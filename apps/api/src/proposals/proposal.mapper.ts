import type { ProposalItemSnapshot, ProposalView } from '@barter/contracts';
import type { Prisma, ProposalVersionItem } from '../generated/prisma/client.js';

export const proposalInclude = {
  order: { select: { id: true } },
  versions: { orderBy: { number: 'asc' }, include: { items: { orderBy: { sortOrder: 'asc' } } } },
} satisfies Prisma.ProposalInclude;

function mapSnapshot(item: ProposalVersionItem): ProposalItemSnapshot {
  return {
    itemId: item.itemId, ownerId: item.ownerId, itemVersion: item.itemVersion,
    title: item.title, description: item.description, condition: item.condition,
    referenceValueFen: item.referenceValueFen, wantedText: item.wantedText, imageUrls: item.imageUrls,
  };
}

export function mapProposal(proposal: Prisma.ProposalGetPayload<{ include: typeof proposalInclude }>): ProposalView {
  return {
    id: proposal.id, initiatorId: proposal.initiatorId, recipientId: proposal.recipientId,
    responderId: proposal.responderId, status: proposal.status, version: proposal.version,
    orderId: proposal.order?.id ?? null,
    currentVersion: proposal.currentVersion, expiresAt: proposal.expiresAt.toISOString(),
    confirmedAt: proposal.confirmedAt?.toISOString() ?? null,
    reservationExpiresAt: proposal.reservationExpiresAt?.toISOString() ?? null,
    createdAt: proposal.createdAt.toISOString(), updatedAt: proposal.updatedAt.toISOString(),
    versions: proposal.versions.map(version => {
      const target = version.items.find(item => item.side === 'RECIPIENT');
      if (!target) throw new Error('Proposal version is missing its target snapshot');
      return {
        id: version.id, number: version.number, authorId: version.authorId,
        createdAt: version.createdAt.toISOString(), differenceFen: version.differenceFen,
        payer: version.payer, deliveryMode: version.deliveryMode,
        initiatorShippingFen: version.initiatorShippingFen, recipientShippingFen: version.recipientShippingFen,
        offeredItems: version.items.filter(item => item.side === 'INITIATOR').map(mapSnapshot),
        targetItem: mapSnapshot(target),
      };
    }),
  };
}
