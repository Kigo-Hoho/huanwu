import { ReviewItemSchema, type ItemView, type Role } from '@barter/contracts';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { mapItem } from './item.mapper.js';

type ReviewItemInput = z.infer<typeof ReviewItemSchema>;
type OperatorItem = Prisma.ItemGetPayload<{
  include: {
    images: true;
    owner: { select: { id: true; displayName: true } };
  };
}>;

const reviewerRoles: readonly Role[] = ['REVIEWER', 'SUPER_ADMIN'];

function itemNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'ITEM_NOT_FOUND',
    message: 'Item was not found',
  });
}

function invalidState(): ConflictException {
  return new ConflictException({
    code: 'ITEM_INVALID_STATE',
    message: 'Only pending items can be reviewed',
  });
}

function versionConflict(): ConflictException {
  return new ConflictException({
    code: 'ITEM_VERSION_CONFLICT',
    message: 'Item version has changed',
  });
}

function mapOperatorItem(item: OperatorItem): ItemView & {
  owner: { id: string; displayName: string | null };
} {
  return {
    ...mapItem(item),
    owner: item.owner,
  };
}

@Injectable()
export class ItemReviewService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
  ) {}

  async listPending() {
    const items = await this.prisma.item.findMany({
      where: { status: 'PENDING_REVIEW' },
      include: {
        images: true,
        owner: { select: { id: true, displayName: true } },
      },
      orderBy: { updatedAt: 'asc' },
    });
    return items.map(mapOperatorItem);
  }

  async getDetail(itemId: string) {
    return await this.prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({
        where: { id: itemId },
        include: {
          images: true,
          owner: { select: { id: true, displayName: true } },
        },
      });
      if (!item) throw itemNotFound();

      const auditHistory = await tx.auditLog.findMany({
        where: { entityType: 'Item', entityId: itemId },
        include: {
          actor: { select: { id: true, displayName: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return {
        ...mapOperatorItem(item),
        auditHistory: auditHistory.map((entry) => ({
          id: entry.id,
          actorId: entry.actorId,
          actor: entry.actor,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          reason: entry.reason,
          requestId: entry.requestId,
          before: entry.before,
          after: entry.after,
          createdAt: entry.createdAt.toISOString(),
        })),
      };
    });
  }

  async review(
    itemId: string,
    reviewer: AuthenticatedUser,
    input: ReviewItemInput,
    requestId?: string,
  ) {
    if (!reviewer.roles.some((role) => reviewerRoles.includes(role))) {
      throw new ForbiddenException('Review permission is required');
    }

    return await this.prisma.$transaction(async (tx) => {
      const existing = await tx.item.findUnique({
        where: { id: itemId },
        include: {
          images: true,
          owner: { select: { id: true, displayName: true } },
        },
      });
      if (!existing) throw itemNotFound();
      if (existing.version !== input.expectedVersion) throw versionConflict();
      if (existing.status !== 'PENDING_REVIEW') throw invalidState();

      const status = input.decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED';
      const rejectReason = input.decision === 'REJECT' ? input.reason : null;
      const transition = await tx.item.updateMany({
        where: {
          id: itemId,
          status: 'PENDING_REVIEW',
          version: input.expectedVersion,
        },
        data: {
          status,
          rejectReason,
          version: { increment: 1 },
        },
      });
      if (transition.count !== 1) {
        const current = await tx.item.findUnique({
          where: { id: itemId },
          select: { status: true, version: true },
        });
        if (!current) throw itemNotFound();
        if (current.version !== input.expectedVersion) throw versionConflict();
        throw invalidState();
      }

      const updated = await tx.item.findUniqueOrThrow({
        where: { id: itemId },
        include: {
          images: true,
          owner: { select: { id: true, displayName: true } },
        },
      });
      await this.auditService.record(tx, {
        actorId: reviewer.id,
        action: input.decision === 'APPROVE' ? 'ITEM_APPROVED' : 'ITEM_REJECTED',
        entityType: 'Item',
        entityId: itemId,
        reason: rejectReason,
        requestId,
        before: {
          status: existing.status,
          version: existing.version,
          rejectReason: existing.rejectReason,
        },
        after: {
          status: updated.status,
          version: updated.version,
          rejectReason: updated.rejectReason,
        },
      });
      return mapOperatorItem(updated);
    });
  }
}
