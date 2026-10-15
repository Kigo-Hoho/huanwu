import {
  CreateItemSchema,
  type ItemView,
  UpdateItemSchema,
} from '@barter/contracts';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { z } from 'zod';
import { createHash } from 'node:crypto';

import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { IdempotencyRecord, Prisma } from '../generated/prisma/client.js';
import { mapItem } from './item.mapper.js';
import { TradingRestrictionsService } from '../risk/trading-restrictions.service.js';

type CreateItemInput = z.infer<typeof CreateItemSchema>;
type UpdateItemInput = z.infer<typeof UpdateItemSchema>;

const submitCommandName = 'SUBMIT_ITEM';

function itemNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'ITEM_NOT_FOUND',
    message: 'Item was not found',
  });
}

function invalidState(message: string): ConflictException {
  return new ConflictException({ code: 'ITEM_INVALID_STATE', message });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class ItemsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(AuditService)
    private readonly auditService: AuditService,
    @Inject(TradingRestrictionsService) private readonly restrictions: TradingRestrictionsService,
  ) {}

  async create(ownerId: string, input: CreateItemInput): Promise<ItemView> {
    const item = await this.prisma.$transaction(async tx => {
      await this.restrictions.lockAndAssert(tx, [ownerId]);
      return tx.item.create({
      data: {
        ownerId,
        title: input.title,
        description: input.description,
        referenceValueFen: input.referenceValueFen,
        condition: input.condition,
        wantedText: input.wantedText,
        images: {
          create: input.imageUrls.map((url, sortOrder) => ({ url, sortOrder })),
        },
      },
      include: { images: true },
      });
    });
    return mapItem(item);
  }

  async update(
    ownerId: string,
    itemId: string,
    input: UpdateItemInput,
  ): Promise<ItemView> {
    return await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${itemId}::uuid FOR UPDATE`;
      const existing = await tx.item.findFirst({
        where: { id: itemId, ownerId },
      });
      if (!existing) throw itemNotFound();
      await this.restrictions.assertItemClear(tx, itemId);
      const clearedRisk = existing.status === 'INACTIVE' && Boolean(await tx.riskTask.findFirst({ where: { sourceKey: `item:${itemId}`, kind: 'ITEM_UNPUBLISHED', status: 'RESOLVED' } }));
      if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED' && !clearedRisk) {
        throw invalidState('Only draft or rejected items can be edited');
      }

      const update = await tx.item.updateMany({
        where: {
          id: itemId,
          ownerId,
          status: existing.status,
          version: existing.version,
        },
        data: {
          title: input.title,
          description: input.description,
          referenceValueFen: input.referenceValueFen,
          condition: input.condition,
          wantedText: input.wantedText,
          status: existing.status === 'REJECTED' || clearedRisk ? 'DRAFT' : undefined,
          rejectReason: existing.status === 'REJECTED' ? null : undefined,
          version: { increment: 1 },
        },
      });
      if (update.count !== 1) {
        const current = await tx.item.findFirst({
          where: { id: itemId, ownerId },
          select: { id: true },
        });
        if (!current) throw itemNotFound();
        throw invalidState('Only draft or rejected items can be edited');
      }

      if (input.imageUrls) {
        await tx.itemImage.deleteMany({ where: { itemId } });
        await tx.itemImage.createMany({
          data: input.imageUrls.map((url, sortOrder) => ({
            itemId,
            url,
            sortOrder,
          })),
        });
      }
      const item = await tx.item.findUniqueOrThrow({
        where: { id: itemId },
        include: { images: true },
      });
      return mapItem(item);
    });
  }

  async listOwned(ownerId: string): Promise<ItemView[]> {
    const items = await this.prisma.item.findMany({
      where: { ownerId },
      include: { images: true },
      orderBy: { updatedAt: 'desc' },
    });
    return items.map(mapItem);
  }

  async getOwned(ownerId: string, itemId: string): Promise<ItemView> {
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, ownerId },
      include: { images: true },
    });
    if (!item) throw itemNotFound();
    return mapItem(item);
  }

  async submit(
    ownerId: string,
    itemId: string,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<ItemView> {
    const requestHash = createHash('sha256').update(itemId.toLowerCase()).digest('hex');
    const replay = (previous: IdempotencyRecord): ItemView => {
      const saved = previous.response as unknown as ItemView;
      // Phase1 records have a null hash; their immutable saved resource still
      // binds the command. Never replay one owned item's key onto another item.
      if (saved.id?.toLowerCase() !== itemId.toLowerCase() || (previous.requestHash !== null && previous.requestHash !== requestHash)) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was used with different content' });
      return saved;
    };
    const run = async (tx: Prisma.TransactionClient) => {
        await this.restrictions.lock(tx, [ownerId]);
        await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${itemId}::uuid FOR UPDATE`;
        const existing = await tx.item.findFirst({ where: { id: itemId, ownerId }, include: { images: true } });
        if (!existing) throw itemNotFound();
        const previous = await tx.idempotencyRecord.findUnique({
          where: {
            actorId_commandName_key: {
              actorId: ownerId,
              commandName: submitCommandName,
              key: idempotencyKey,
            },
          },
        });
        if (previous) return replay(previous);
        await this.restrictions.assertAllowed(tx, [ownerId]);

        await tx.idempotencyRecord.create({
          data: {
            actorId: ownerId,
            commandName: submitCommandName,
            key: idempotencyKey,
            requestHash,
            response: {},
          },
        });

        await this.restrictions.assertItemClear(tx, itemId);
        if (existing.status !== 'DRAFT') {
          throw invalidState('Only draft items can be submitted');
        }
        if (existing.images.length < 3) {
          throw invalidState('At least three persisted images are required');
        }

        const transition = await tx.item.updateMany({
          where: { id: itemId, ownerId, status: 'DRAFT' },
          data: { status: 'PENDING_REVIEW', version: { increment: 1 } },
        });
        if (transition.count !== 1) {
          throw invalidState('Only draft items can be submitted');
        }
        const updated = await tx.item.findUniqueOrThrow({
          where: { id: itemId },
          include: { images: true },
        });
        const response = mapItem(updated);
        await this.auditService.record(tx, {
          actorId: ownerId,
          action: 'ITEM_SUBMITTED',
          entityType: 'Item',
          entityId: itemId,
          requestId,
          before: { status: existing.status, version: existing.version },
          after: { status: updated.status, version: updated.version },
        });
        await tx.idempotencyRecord.update({
          where: {
            actorId_commandName_key: {
              actorId: ownerId,
              commandName: submitCommandName,
              key: idempotencyKey,
            },
          },
          data: { response: response as unknown as Prisma.InputJsonValue },
        });
        return response;
    };
    try {
      return await this.prisma.$transaction(run);
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      // Re-enter ownership/locking/replay together after a unique-key race.
      return this.prisma.$transaction(run);
    }
  }
}
