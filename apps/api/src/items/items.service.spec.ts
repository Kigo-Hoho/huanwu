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

  it('rejects a late edit after a concurrent submit without changing content or images', async () => {
    const timestamp = new Date('2026-09-22T02:03:04.567Z');
    const originalImages = [
      { url: 'https://images.test/original-1.jpg', sortOrder: 0 },
      { url: 'https://images.test/original-2.jpg', sortOrder: 1 },
      { url: 'https://images.test/original-3.jpg', sortOrder: 2 },
    ];
    const state = {
      id: 'f6165af4-602a-47fd-9ac4-dcb86aa4b5e5',
      ownerId: 'b7aeb96b-21f0-4148-8604-7acac785e948',
      title: '提交前标题',
      description: '正常使用痕迹，所有细节均已拍照说明。',
      referenceValueFen: 25_000,
      condition: 'GOOD' as const,
      status: 'DRAFT' as string,
      wantedText: '希望交换小型咖啡机',
      rejectReason: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      images: originalImages.map((image) => ({ ...image })),
    };
    let observedResolve!: () => void;
    let continueResolve!: () => void;
    const observed = new Promise<void>((resolve) => {
      observedResolve = resolve;
    });
    const continueAfterSubmit = new Promise<void>((resolve) => {
      continueResolve = resolve;
    });
    let readCount = 0;
    const tx = {
      item: {
        findFirst: vi.fn(async () => {
          readCount += 1;
          const snapshot = { ...state, images: state.images.map((image) => ({ ...image })) };
          if (readCount === 1) {
            observedResolve();
            await continueAfterSubmit;
          }
          return snapshot;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const allowedStatuses =
            typeof where.status === 'string'
              ? [where.status]
              : (where.status.in as string[]);
          if (
            (where.ownerId !== undefined && state.ownerId !== where.ownerId) ||
            (where.version !== undefined && state.version !== where.version) ||
            !allowedStatuses.includes(state.status)
          ) {
            return { count: 0 };
          }
          Object.assign(state, data, {
            version:
              typeof data.version === 'object' && data.version.increment
                ? state.version + data.version.increment
                : data.version,
          });
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }) => {
          Object.assign(state, data, { version: state.version + 1 });
          if (data.images?.create) {
            state.images = data.images.create;
          }
          return state;
        }),
        findUniqueOrThrow: vi.fn(async () => state),
      },
      itemImage: {
        deleteMany: vi.fn(async () => {
          state.images = [];
          return { count: originalImages.length };
        }),
        createMany: vi.fn(async ({ data }) => {
          state.images = data;
          return { count: data.length };
        }),
      },
      idempotencyRecord: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }) => data),
        update: vi.fn(async ({ data }) => data),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const auditService = { record: vi.fn(async () => undefined) };
    const service = new ItemsService(prisma as never, auditService as never);
    const lateEdit = service.update(state.ownerId, state.id, {
      title: '不应覆盖提交结果的新标题',
      imageUrls: [
        'https://images.test/new-1.jpg',
        'https://images.test/new-2.jpg',
        'https://images.test/new-3.jpg',
      ],
    });

    await observed;
    const submitted = await service.submit(
      state.ownerId,
      state.id,
      'interleaved-submit-command',
    );
    expect(submitted).toMatchObject({ status: 'PENDING_REVIEW', version: 2 });
    expect(auditService.record).toHaveBeenCalledOnce();
    continueResolve();
    const outcome = await lateEdit.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    expect(outcome.error).toMatchObject({ status: 409 });
    expect(outcome.value).toBeUndefined();
    expect(state).toMatchObject({
      status: 'PENDING_REVIEW',
      version: 2,
      title: '提交前标题',
      images: originalImages,
    });
    expect(tx.itemImage.deleteMany).not.toHaveBeenCalled();
    expect(tx.itemImage.createMany).not.toHaveBeenCalled();
  });
});
