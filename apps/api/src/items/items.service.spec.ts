import { describe, expect, it, vi } from 'vitest';

import { ItemsService } from './items.service.js';

describe('ItemsService', () => {
  it('maps database dates to UTC ISO strings after creating a draft', async () => {
    const createdAt = new Date('2026-09-22T02:03:04.567Z');
    const prisma = {
      item: {
        create: vi.fn().mockResolvedValue({
          id: 'f6165af4-602a-47fd-9ac4-dcb86aa4b5e5',
          ownerId: 'b7aeb96b-21f0-4148-8604-7acac785e948',
          title: '九成新通勤双肩包',
          description: '正常使用痕迹，所有细节均已拍照说明。',
          referenceValueFen: 25_000,
          condition: 'GOOD',
          status: 'DRAFT',
          wantedText: '希望交换小型咖啡机',
          rejectReason: null,
          version: 1,
          createdAt,
          updatedAt: createdAt,
          images: [
            { url: 'https://images.test/1.jpg', sortOrder: 0 },
            { url: 'https://images.test/2.jpg', sortOrder: 1 },
            { url: 'https://images.test/3.jpg', sortOrder: 2 },
          ],
        }),
      },
    };
    const service = new ItemsService(prisma as never, {} as never);

    const result = await service.create('b7aeb96b-21f0-4148-8604-7acac785e948', {
      title: '九成新通勤双肩包',
      description: '正常使用痕迹，所有细节均已拍照说明。',
      referenceValueFen: 25_000,
      condition: 'GOOD',
      imageUrls: [
        'https://images.test/1.jpg',
        'https://images.test/2.jpg',
        'https://images.test/3.jpg',
      ],
      wantedText: '希望交换小型咖啡机',
    });

    expect(result.createdAt).toBe('2026-09-22T02:03:04.567Z');
    expect(result.updatedAt).toBe('2026-09-22T02:03:04.567Z');
    expect(result.imageUrls).toEqual([
      'https://images.test/1.jpg',
      'https://images.test/2.jpg',
      'https://images.test/3.jpg',
    ]);
  });

  it('maps the database inactive status to the public unpublished status', async () => {
    const timestamp = new Date('2026-09-22T02:03:04.567Z');
    const prisma = {
      item: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'f6165af4-602a-47fd-9ac4-dcb86aa4b5e5',
          ownerId: 'b7aeb96b-21f0-4148-8604-7acac785e948',
          title: '九成新通勤双肩包',
          description: '正常使用痕迹，所有细节均已拍照说明。',
          referenceValueFen: 25_000,
          condition: 'GOOD',
          status: 'INACTIVE',
          wantedText: '希望交换小型咖啡机',
          rejectReason: null,
          version: 3,
          createdAt: timestamp,
          updatedAt: timestamp,
          images: [],
        }),
      },
    };
    const service = new ItemsService(prisma as never, {} as never);

    const result = await service.getOwned(
      'b7aeb96b-21f0-4148-8604-7acac785e948',
      'f6165af4-602a-47fd-9ac4-dcb86aa4b5e5',
    );

    expect(result.status).toBe('UNPUBLISHED');
  });
});
