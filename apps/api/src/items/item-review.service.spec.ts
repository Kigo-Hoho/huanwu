import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ItemReviewService } from './item-review.service.js';
import { phase3DatabaseName, validateDatabaseName } from '../../test/phase3/support/database-fixtures.js';

describe('ItemReviewService', () => {
  let service: ItemReviewService;
  let prisma: PrismaService;
  const auditService = { record: vi.fn() };
  const fixtureMarker = 'task-6-service-fixture';
  let ownerId: string;
  let reviewerId: string;

  beforeAll(async () => {
    const name = phase3DatabaseName(process.env.DATABASE_URL!);
    expect(name.startsWith('barter_p3_')).toBe(true);
    validateDatabaseName(name, process.env.PHASE3_NAMESPACE!);
    expect(name).not.toBe(process.env.PHASE3_TEMPLATE);
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
