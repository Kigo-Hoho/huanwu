import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';

function unavailable(): ConflictException {
  return new ConflictException({ code: 'ITEM_UNAVAILABLE', message: 'The full proposal lease is not available for handoff' });
}

@Injectable()
export class ReservationsService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async lockItems(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) {
      await tx.$queryRaw`SELECT "id" FROM "Item" WHERE "id" = ${id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "itemId" FROM "ItemReservation" WHERE "itemId" = ${id}::uuid FOR UPDATE`;
    }
  }

  async assertProposalLease(tx: Prisma.TransactionClient, proposalId: string, proposalVersionId: string, itemIds: string[], now: Date): Promise<void> {
    if (itemIds.length < 2 || itemIds.length > 6 || new Set(itemIds).size !== itemIds.length) throw unavailable();
    const proposal = await tx.proposal.findUnique({
      where: { id: proposalId },
      select: { currentVersion: true, reservationExpiresAt: true, versions: { where: { id: proposalVersionId }, select: { number: true } } },
    });
    if (!proposal?.reservationExpiresAt || proposal.versions[0]?.number !== proposal.currentVersion) throw unavailable();
    const leases = await tx.itemReservation.findMany({ where: { proposalId } });
    if (leases.length !== itemIds.length || leases.some(lease => !itemIds.includes(lease.itemId) ||
        lease.proposalVersionId !== proposalVersionId || lease.orderId !== null ||
        lease.expiresAt === null || lease.expiresAt <= now ||
        lease.expiresAt.getTime() !== proposal.reservationExpiresAt!.getTime())) throw unavailable();
  }

  async handoffToOrder(tx: Prisma.TransactionClient, proposalId: string, orderId: string, itemIds: string[]): Promise<void> {
    await this.lockItems(tx, itemIds);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.proposalId !== proposalId) throw unavailable();
    await this.assertProposalLease(tx, proposalId, order.proposalVersionId, itemIds, this.clock.now());
    const result = await tx.itemReservation.updateMany({
      where: { itemId: { in: itemIds }, proposalId, proposalVersionId: order.proposalVersionId, orderId: null },
      data: { proposalId: null, proposalVersionId: null, expiresAt: null, orderId },
    });
    if (result.count !== itemIds.length) throw unavailable();
  }

  async releaseOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const leases = await tx.itemReservation.findMany({ where: { orderId }, select: { itemId: true } });
    await this.lockItems(tx, leases.map(lease => lease.itemId));
    await tx.itemReservation.deleteMany({ where: { orderId, proposalId: null, proposalVersionId: null } });
  }
}
