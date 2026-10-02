import { type PublicItemList, type PublicItemView } from '@barter/contracts';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.string().uuid() });
type PublicItem = Prisma.ItemGetPayload<{ include: { images: true; reservation: true } }>;

function invalidCursor(): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid item cursor' });
}

function decodeCursor(value: string) {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw invalidCursor();
    return cursorSchema.parse(JSON.parse(decoded));
  } catch { throw invalidCursor(); }
}

function mapPublicItem(item: PublicItem, now: Date): PublicItemView {
  return {
    id: item.id, ownerId: item.ownerId, status: 'ACTIVE', version: item.version,
    title: item.title, description: item.description, referenceValueFen: item.referenceValueFen,
    condition: item.condition, wantedText: item.wantedText,
    imageUrls: [...item.images].sort((a, b) => a.sortOrder - b.sortOrder).map(({ url }) => url),
    availableForProposal: !item.reservation || item.reservation.expiresAt <= now,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
}

@Injectable()
export class PublicItemsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(cursorValue?: string, limitValue?: string): Promise<PublicItemList> {
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid page limit' });
    }
    const cursor = cursorValue === undefined ? undefined : decodeCursor(cursorValue);
    const now = new Date();
    const items = await this.prisma.item.findMany({
      where: {
        status: 'ACTIVE',
        ...(cursor ? { OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ] } : {}),
      },
      include: { images: true, reservation: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((item) => mapPublicItem(item, now)),
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null,
    };
  }

  async get(itemId: string): Promise<PublicItemView> {
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, status: 'ACTIVE' },
      include: { images: true, reservation: true },
    });
    if (!item) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Item was not found' });
    return mapPublicItem(item, new Date());
  }
}
