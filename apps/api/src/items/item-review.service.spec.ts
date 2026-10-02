import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ItemReviewService } from './item-review.service.js';

describe('ItemReviewService', () => {
  let service: ItemReviewService;
  let prisma: PrismaService;
  const auditService = { record: vi.fn() };
  const fixtureMarker = 'task-6-service-fixture';
  let ownerId: string;
  let reviewerId: string;

  async function cleanup(): Promise<void> {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { wechatOpenid: { startsWith: fixtureMarker } },
          { adminCredential: { email: { startsWith: fixtureMarker } } },
        ],
      },
      select: { id: true },
    });
    const userIds = users.map(({ id }) => id);
    if (userIds.length === 0) return;
    const itemIds = (
      await prisma.item.findMany({
        where: { ownerId: { in: userIds } },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: { in: userIds } },
          { entityType: 'Item', entityId: { in: itemIds } },
        ],
      },
    });
    await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ItemReviewService,
        PrismaService,
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(ItemReviewService);
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
    await cleanup();

    const owner = await prisma.user.create({
      data: {
        wechatOpenid: `${fixtureMarker}-owner-${randomUUID()}`,
        roles: { create: { role: 'CUSTOMER' } },
      },
    });
    const reviewer = await prisma.user.create({
      data: {
        roles: { create: { role: 'REVIEWER' } },
        adminCredential: {
          create: {
            email: `${fixtureMarker}-${randomUUID()}@example.test`,
            passwordHash: 'unused',
          },
        },
      },
    });
    ownerId = owner.id;
    reviewerId = reviewer.id;
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  it('rolls back approval when audit creation fails', async () => {
    const item = await prisma.item.create({
      data: {
        ownerId,
        title: '待审核通勤双肩包',
        description: '正常使用痕迹，所有细节均已拍照说明。',
        referenceValueFen: 25_000,
        condition: 'GOOD',
        status: 'PENDING_REVIEW',
        wantedText: '希望交换小型咖啡机',
      },
    });
    auditService.record.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      service.review(
        item.id,
        { id: reviewerId, roles: ['REVIEWER'] },
        { decision: 'APPROVE', expectedVersion: 1 },
      ),
    ).rejects.toThrow('audit unavailable');

    await expect(
      prisma.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).resolves.toMatchObject({
      status: 'PENDING_REVIEW',
      version: 1,
      rejectReason: null,
    });
  });
});
