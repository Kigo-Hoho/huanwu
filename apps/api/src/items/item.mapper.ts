import type { ItemView } from '@barter/contracts';

import type { Prisma } from '../generated/prisma/client.js';

export type ItemWithImages = Prisma.ItemGetPayload<{
  include: { images: true };
}>;

export function mapItem(item: ItemWithImages): ItemView {
  return {
    id: item.id,
    ownerId: item.ownerId,
    title: item.title,
    description: item.description,
    referenceValueFen: item.referenceValueFen,
    condition: item.condition,
    imageUrls: [...item.images]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(({ url }) => url),
    wantedText: item.wantedText,
    status: item.status === 'INACTIVE' ? 'UNPUBLISHED' : item.status,
    version: item.version,
    rejectReason: item.rejectReason,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
