import { createHash } from 'node:crypto';
import type { CounterProposalInput, CreateProposalInput, ProposalCommandInput, ProposalView } from '@barter/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { IdempotencyRecord, Prisma } from '../generated/prisma/client.js';
import { mapProposal, proposalInclude } from './proposal.mapper.js';

const commandName = 'CREATE_PROPOSAL';
const pendingLifetimeMs = 7 * 24 * 60 * 60 * 1000;

// Object key order is immaterial; array order remains part of the saved offer.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function replay(previous: IdempotencyRecord, requestHash: string): ProposalView {
  if (previous.requestHash !== requestHash) {
    throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was used with different content' });
  }
  return previous.response as unknown as ProposalView;
}

function unavailable(): ConflictException {
  return new ConflictException({ code: 'ITEM_UNAVAILABLE', message: 'A proposal item is unavailable or not owned by the required participant' });
}

@Injectable()
export class ProposalsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(actorId: string, input: CreateProposalInput, key: string, requestId?: string): Promise<ProposalView> {
    const requestHash = createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
    const identity = { actorId, commandName, key };
    const where = { actorId_commandName_key: identity };
    try {
      return await this.prisma.$transaction(async tx => {
        const previous = await tx.idempotencyRecord.findUnique({ where });
        if (previous) return replay(previous, requestHash);
        // Claim the key before business writes: concurrent retries wait on its unique constraint.
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: {} } });

        const itemIds = [...input.offeredItemIds, input.targetItemId];
        // Same deterministic lock order as reservation commands; reread after acquiring all locks.
        for (const id of [...itemIds].sort()) {
          await tx.$queryRaw`SELECT "id" FROM "Item" WHERE "id" = ${id}::uuid FOR UPDATE`;
        }
        const now = new Date();
        const items = await tx.item.findMany({
          where: { id: { in: itemIds } },
          include: { images: { orderBy: { sortOrder: 'asc' } }, reservation: true },
        });
        const target = items.find(item => item.id === input.targetItemId);
        if (!target || target.ownerId === actorId || items.length !== itemIds.length) throw unavailable();
        for (const item of items) {
          if (item.status !== 'ACTIVE' || (item.reservation && item.reservation.expiresAt > now) ||
              (item.id !== target.id && item.ownerId !== actorId)) throw unavailable();
        }
        const snapshots = itemIds.map((id, index) => {
          const item = items.find(candidate => candidate.id === id)!;
          return {
            itemId: item.id, ownerId: item.ownerId, itemVersion: item.version,
            side: id === target.id ? 'RECIPIENT' as const : 'INITIATOR' as const,
            sortOrder: id === target.id ? 0 : index,
            title: item.title, description: item.description, condition: item.condition,
            referenceValueFen: item.referenceValueFen, wantedText: item.wantedText,
            imageUrls: item.images.map(image => image.url),
          };
        });
        const proposal = await tx.proposal.create({
          data: {
            initiatorId: actorId, recipientId: target.ownerId, responderId: target.ownerId,
            expiresAt: new Date(now.getTime() + pendingLifetimeMs),
            versions: { create: {
              number: 1, authorId: actorId, differenceFen: input.differenceFen, payer: input.payer,
              deliveryMode: input.deliveryMode, initiatorShippingFen: input.initiatorShippingFen,
              recipientShippingFen: input.recipientShippingFen, items: { create: snapshots },
            } },
          },
          include: proposalInclude,
        });
        const response = mapProposal(proposal);
        await this.audit.record(tx, {
          actorId, action: 'PROPOSAL_CREATED', entityType: 'Proposal', entityId: proposal.id,
          requestId, after: response as unknown as Prisma.InputJsonValue,
        });
        await tx.idempotencyRecord.update({ where, data: { response: response as unknown as Prisma.InputJsonValue } });
        return response;
      });
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') throw error;
      const previous = await this.prisma.idempotencyRecord.findUnique({ where });
      if (!previous) throw error;
      return replay(previous, requestHash);
    }
  }

  async list(actorId: string, direction: 'sent' | 'received'): Promise<ProposalView[]> {
    const proposals = await this.prisma.proposal.findMany({
      where: direction === 'sent' ? { initiatorId: actorId } : { recipientId: actorId },
      include: proposalInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return proposals.map(mapProposal);
  }

  async command(actorId: string, id: string, action: 'counter', input: CounterProposalInput, key: string, requestId?: string): Promise<ProposalView>;
  async command(actorId: string, id: string, action: 'accept' | 'reject' | 'cancel', input: ProposalCommandInput, key: string, requestId?: string): Promise<ProposalView>;
  async command(actorId: string, id: string, action: 'counter' | 'accept' | 'reject' | 'cancel', input: CounterProposalInput | ProposalCommandInput, key: string, requestId?: string): Promise<ProposalView> {
    const requestHash = createHash('sha256').update(JSON.stringify(canonicalize({ id, input }))).digest('hex');
    const identity = { actorId, commandName: `${action.toUpperCase()}_PROPOSAL`, key };
    const where = { actorId_commandName_key: identity };
    try {
      return await this.prisma.$transaction(async tx => {
        // All transitions lock the proposal before rereading it. Version and turn checks
        // therefore see the preceding committed command, including concurrent counters.
        await tx.$queryRaw`SELECT "id" FROM "Proposal" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const proposal = await tx.proposal.findUnique({ where: { id }, include: proposalInclude });
        if (!proposal || (proposal.initiatorId !== actorId && proposal.recipientId !== actorId)) {
          throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Proposal was not found' });
        }
        const previous = await tx.idempotencyRecord.findUnique({ where });
        if (previous) return replay(previous, requestHash);
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: {} } });
        if (proposal.version !== input.expectedVersion) {
          throw new ConflictException({ code: 'PROPOSAL_VERSION_CONFLICT', message: 'Proposal has changed' });
        }
        if (proposal.status !== 'PENDING' && !(action === 'cancel' && proposal.status === 'CONFIRMED')) {
          throw new ConflictException({ code: 'PROPOSAL_INVALID_STATE', message: 'Command is not allowed in this state' });
        }
        const now = new Date();
        const deadline = proposal.status === 'CONFIRMED' ? proposal.reservationExpiresAt : proposal.expiresAt;
        if (deadline && deadline <= now) {
          // Task 5 adds shared audited expiration and its scheduler. No expired command
          // is allowed to revive or otherwise successfully change a proposal meanwhile.
          throw new ConflictException({ code: 'PROPOSAL_EXPIRED', message: 'Proposal has expired' });
        }
        if (action !== 'cancel' && proposal.responderId !== actorId) {
          throw new ForbiddenException({ code: 'PROPOSAL_WRONG_TURN', message: 'Only the current responder may perform this command' });
        }
        if (action === 'accept') {
          // Fail closed until Task 5 installs reservation validation/writes in this transaction.
          throw new ConflictException({ code: 'PROPOSAL_INVALID_STATE', message: 'Acceptance is unavailable until atomic reservations are enabled' });
        }
        const before = mapProposal(proposal);
        if (action === 'counter') {
          const offer = input as CounterProposalInput;
          const current = before.versions.find(version => version.number === proposal.currentVersion)!;
          const initiator = actorId === proposal.initiatorId;
          if ((initiator && offer.targetItemId !== current.targetItem.itemId) ||
              (!initiator && JSON.stringify(offer.offeredItemIds) !== JSON.stringify(current.offeredItems.map(item => item.itemId)))) {
            throw new ForbiddenException({ code: 'PROPOSAL_SIDE_FORBIDDEN', message: 'Only your own side items may change' });
          }
          const itemIds = [...offer.offeredItemIds, offer.targetItemId];
          for (const itemId of [...itemIds].sort()) {
            await tx.$queryRaw`SELECT "id" FROM "Item" WHERE "id" = ${itemId}::uuid FOR UPDATE`;
          }
          const items = await tx.item.findMany({ where: { id: { in: itemIds } }, include: { images: { orderBy: { sortOrder: 'asc' } }, reservation: true } });
          if (items.length !== itemIds.length) throw unavailable();
          const snapshotTime = new Date();
          // Waiting for an item lock must not let a now-expired offer be renewed.
          if (proposal.expiresAt <= snapshotTime) throw new ConflictException({ code: 'PROPOSAL_EXPIRED', message: 'Proposal has expired' });
          const snapshots = itemIds.map((itemId, index) => {
            const item = items.find(candidate => candidate.id === itemId)!;
            const target = itemId === offer.targetItemId;
            if (item.ownerId !== (target ? proposal.recipientId : proposal.initiatorId) || item.status !== 'ACTIVE' || (item.reservation && item.reservation.expiresAt > snapshotTime)) throw unavailable();
            return {
              itemId, ownerId: item.ownerId, itemVersion: item.version, side: target ? 'RECIPIENT' as const : 'INITIATOR' as const,
              sortOrder: target ? 0 : index, title: item.title, description: item.description, condition: item.condition,
              referenceValueFen: item.referenceValueFen, wantedText: item.wantedText, imageUrls: item.images.map(image => image.url),
            };
          });
          await tx.proposalVersion.create({ data: {
            proposalId: id, number: proposal.currentVersion + 1, authorId: actorId,
            differenceFen: offer.differenceFen, payer: offer.payer, deliveryMode: offer.deliveryMode,
            initiatorShippingFen: offer.initiatorShippingFen, recipientShippingFen: offer.recipientShippingFen,
            items: { create: snapshots },
          } });
          await tx.proposal.update({ where: { id }, data: {
            version: { increment: 1 }, currentVersion: { increment: 1 },
            responderId: initiator ? proposal.recipientId : proposal.initiatorId,
            expiresAt: new Date(snapshotTime.getTime() + pendingLifetimeMs),
          } });
        } else {
          await tx.proposal.update({ where: { id }, data: { status: action === 'reject' ? 'REJECTED' : 'CANCELLED', version: { increment: 1 } } });
          if (action === 'cancel') await tx.itemReservation.deleteMany({ where: { proposalId: id } });
        }
        const response = mapProposal(await tx.proposal.findUniqueOrThrow({ where: { id }, include: proposalInclude }));
        await this.audit.record(tx, {
          actorId, action: action === 'counter' ? 'PROPOSAL_COUNTERED' : action === 'reject' ? 'PROPOSAL_REJECTED' : 'PROPOSAL_CANCELLED',
          entityType: 'Proposal', entityId: id, requestId,
          before: before as unknown as Prisma.InputJsonValue, after: response as unknown as Prisma.InputJsonValue,
        });
        await tx.idempotencyRecord.update({ where, data: { response: response as unknown as Prisma.InputJsonValue } });
        return response;
      });
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') throw error;
      const previous = await this.prisma.idempotencyRecord.findUnique({ where });
      if (!previous) throw error;
      return replay(previous, requestHash);
    }
  }

  async detail(actorId: string, id: string): Promise<ProposalView> {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, OR: [{ initiatorId: actorId }, { recipientId: actorId }] }, include: proposalInclude,
    });
    if (!proposal) throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Proposal was not found' });
    return mapProposal(proposal);
  }
}
