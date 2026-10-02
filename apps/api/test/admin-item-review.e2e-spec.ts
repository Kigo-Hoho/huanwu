import { createHmac, randomUUID } from 'node:crypto';

import type { Role } from '@barter/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { configureApp } from '../src/main.js';

const jwtSecret = 'task-6-e2e-jwt-secret-with-sufficient-entropy';
const fixtureMarker = 'task-6-review-e2e';

function signToken(
  userId: string,
  roles: Role[],
  type: 'CUSTOMER' | 'OPERATOR',
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, roles, type, iat: now, exp: now + 900 }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', jwtSecret)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

describe('operator item review', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let customerId: string;
  let reviewerOneId: string;
  let reviewerTwoId: string;
  let superAdminId: string;
  let reviewerOneToken: string;
  let reviewerTwoToken: string;
  let superAdminToken: string;
  let operationsToken: string;
  let customerToken: string;
  const originalJwtSecret = process.env.JWT_SECRET;

  async function createOperator(role: 'REVIEWER' | 'SUPER_ADMIN' | 'OPERATIONS') {
    return await prisma.user.create({
      data: {
        displayName: `${role} fixture`,
        roles: { create: { role } },
        adminCredential: {
          create: {
            email: `${fixtureMarker}-${role.toLowerCase()}-${randomUUID()}@example.test`,
            passwordHash: 'unused',
          },
        },
      },
    });
  }

  async function createItem(
    status: 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' = 'PENDING_REVIEW',
  ) {
    return await prisma.item.create({
      data: {
        ownerId: customerId,
        title: `审核物品 ${randomUUID().slice(0, 8)}`,
        description: '正常使用痕迹，拉链和内衬完好，细节均已拍照。',
        referenceValueFen: 25_000,
        condition: 'GOOD',
        status,
        wantedText: '希望交换小型咖啡机',
        images: {
          create: [
            { url: 'https://images.test/review-1.jpg', sortOrder: 0 },
            { url: 'https://images.test/review-2.jpg', sortOrder: 1 },
            { url: 'https://images.test/review-3.jpg', sortOrder: 2 },
          ],
        },
      },
      include: { images: true },
    });
  }

  function review(
    itemId: string,
    token: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .post(`/api/admin/items/${itemId}/reviews`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'task-6-review-request')
      .send(body);
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = jwtSecret;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const customer = await prisma.user.create({
      data: {
        wechatOpenid: `${fixtureMarker}-customer-${randomUUID()}`,
        displayName: '测试物主',
        roles: { create: { role: 'CUSTOMER' } },
      },
    });
    const reviewerOne = await createOperator('REVIEWER');
    const reviewerTwo = await createOperator('REVIEWER');
    const superAdmin = await createOperator('SUPER_ADMIN');
    const operations = await createOperator('OPERATIONS');
    customerId = customer.id;
    reviewerOneId = reviewerOne.id;
    reviewerTwoId = reviewerTwo.id;
    superAdminId = superAdmin.id;
    customerToken = signToken(customerId, ['CUSTOMER'], 'CUSTOMER');
    reviewerOneToken = signToken(reviewerOneId, ['REVIEWER'], 'OPERATOR');
    reviewerTwoToken = signToken(reviewerTwoId, ['REVIEWER'], 'OPERATOR');
    superAdminToken = signToken(superAdminId, ['SUPER_ADMIN'], 'OPERATOR');
    operationsToken = signToken(operations.id, ['OPERATIONS'], 'OPERATOR');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('lists only pending items and returns owner, images, and audit history in detail', async () => {
    const pending = await createItem('PENDING_REVIEW');
    const draft = await createItem('DRAFT');
    await prisma.auditLog.create({
      data: {
        actorId: customerId,
        action: 'ITEM_SUBMITTED',
        entityType: 'Item',
        entityId: pending.id,
        before: { status: 'DRAFT', version: 0 },
        after: { status: 'PENDING_REVIEW', version: 1 },
      },
    });

    await request(app.getHttpServer())
      .get('/api/admin/items?status=PENDING_REVIEW')
      .set('Authorization', `Bearer ${reviewerOneToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.some((item: { id: string }) => item.id === pending.id)).toBe(true);
        expect(body.some((item: { id: string }) => item.id === draft.id)).toBe(false);
        const listed = body.find((item: { id: string }) => item.id === pending.id);
        expect(listed).toMatchObject({
          owner: { id: customerId, displayName: '测试物主' },
          referenceValueFen: 25_000,
          status: 'PENDING_REVIEW',
          version: 1,
          imageUrls: [
            'https://images.test/review-1.jpg',
            'https://images.test/review-2.jpg',
            'https://images.test/review-3.jpg',
          ],
        });
        expect(listed.updatedAt).toMatch(/Z$/);
      });

    await request(app.getHttpServer())
      .get(`/api/admin/items/${pending.id}`)
      .set('Authorization', `Bearer ${reviewerOneToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.owner).toEqual({ id: customerId, displayName: '测试物主' });
        expect(body.imageUrls).toHaveLength(3);
        expect(body.auditHistory).toEqual([
          expect.objectContaining({
            actorId: customerId,
            action: 'ITEM_SUBMITTED',
            entityType: 'Item',
            entityId: pending.id,
            before: { status: 'DRAFT', version: 0 },
            after: { status: 'PENDING_REVIEW', version: 1 },
          }),
        ]);
        expect(body.auditHistory[0].createdAt).toMatch(/Z$/);
      });

    await request(app.getHttpServer())
      .get('/api/admin/items?status=ACTIVE')
      .set('Authorization', `Bearer ${reviewerOneToken}`)
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
  });

  it('approves a pending item and writes reviewer attribution in the audit log', async () => {
    const item = await createItem();

    await review(item.id, reviewerOneToken, {
      decision: 'APPROVE',
      expectedVersion: 1,
    })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: item.id,
          status: 'ACTIVE',
          version: 2,
          rejectReason: null,
        });
      });

    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'ITEM_APPROVED', entityId: item.id },
      }),
    ).resolves.toMatchObject({
      actorId: reviewerOneId,
      reason: null,
      requestId: 'task-6-review-request',
      before: { status: 'PENDING_REVIEW', version: 1, rejectReason: null },
      after: { status: 'ACTIVE', version: 2, rejectReason: null },
    });

    await request(app.getHttpServer())
      .get(`/api/admin/items/${item.id}`)
      .set('Authorization', `Bearer ${reviewerOneToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.auditHistory).toEqual([
          expect.objectContaining({
            actorId: reviewerOneId,
            action: 'ITEM_APPROVED',
          }),
        ]);
      });
  });

  it('validates and persists a rejection reason', async () => {
    const item = await createItem();

    await review(item.id, reviewerOneToken, {
      decision: 'REJECT',
      expectedVersion: 1,
    })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));

    await review(item.id, reviewerOneToken, {
      decision: 'REJECT',
      expectedVersion: 1,
      reason: '图片信息不足',
    })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'REJECTED',
          version: 2,
          rejectReason: '图片信息不足',
        });
      });

    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'ITEM_REJECTED', entityId: item.id },
      }),
    ).resolves.toMatchObject({
      actorId: reviewerOneId,
      reason: '图片信息不足',
      before: { status: 'PENDING_REVIEW', version: 1, rejectReason: null },
      after: { status: 'REJECTED', version: 2, rejectReason: '图片信息不足' },
    });
  });

  it('rejects a stale review without a second state change or audit row', async () => {
    const item = await createItem();

    await review(item.id, reviewerOneToken, {
      decision: 'APPROVE',
      expectedVersion: 1,
    }).expect(200);
    await review(item.id, reviewerTwoToken, {
      decision: 'REJECT',
      expectedVersion: 1,
      reason: '图片信息不足',
    })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ITEM_VERSION_CONFLICT'));

    await expect(
      prisma.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).resolves.toMatchObject({ status: 'ACTIVE', version: 2, rejectReason: null });
    expect(
      await prisma.auditLog.count({
        where: { entityType: 'Item', entityId: item.id },
      }),
    ).toBe(1);
  });

  it('allows exactly one of two simultaneous reviews for the same version', async () => {
    const item = await createItem();

    const responses = await Promise.all([
      review(item.id, reviewerOneToken, {
        decision: 'APPROVE',
        expectedVersion: 1,
      }),
      review(item.id, reviewerTwoToken, {
        decision: 'REJECT',
        expectedVersion: 1,
        reason: '图片信息不足',
      }),
    ]);

    const successResponses = responses.filter(({ status }) => status === 200);
    const conflictResponses = responses.filter(({ status }) => status === 409);
    expect(successResponses).toHaveLength(1);
    expect(conflictResponses).toHaveLength(1);
    expect(conflictResponses[0]?.body).toMatchObject({
      code: 'ITEM_VERSION_CONFLICT',
    });

    await expect(
      prisma.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).resolves.toMatchObject({ version: 2 });
    expect(
      await prisma.auditLog.count({
        where: { entityType: 'Item', entityId: item.id },
      }),
    ).toBe(1);
  });

  it('rejects review of a non-pending item as an invalid state', async () => {
    const item = await createItem('DRAFT');

    await review(item.id, reviewerOneToken, {
      decision: 'APPROVE',
      expectedVersion: 1,
    })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ITEM_INVALID_STATE'));

    expect(
      await prisma.auditLog.count({ where: { entityId: item.id } }),
    ).toBe(0);
  });

  it('forbids operations and customer roles from review APIs', async () => {
    const item = await createItem();

    await request(app.getHttpServer())
      .get('/api/admin/items?status=PENDING_REVIEW')
      .set('Authorization', `Bearer ${operationsToken}`)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    await review(item.id, operationsToken, {
      decision: 'APPROVE',
      expectedVersion: 1,
    })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    await review(item.id, customerToken, {
      decision: 'APPROVE',
      expectedVersion: 1,
    })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
  });

  it('allows a super admin to review', async () => {
    const item = await createItem();

    await review(item.id, superAdminToken, {
      decision: 'APPROVE',
      expectedVersion: 1,
    })
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('ACTIVE'));

    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'ITEM_APPROVED', entityId: item.id },
      }),
    ).resolves.toMatchObject({ actorId: superAdminId });
  });

  it('applies a persisted reviewer role revocation immediately', async () => {
    const item = await createItem();
    await prisma.userRole.delete({
      where: { userId_role: { userId: reviewerTwoId, role: 'REVIEWER' } },
    });
    try {
      await review(item.id, reviewerTwoToken, {
        decision: 'APPROVE',
        expectedVersion: 1,
      })
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    } finally {
      await prisma.userRole.create({
        data: { userId: reviewerTwoId, role: 'REVIEWER' },
      });
    }

    await expect(
      prisma.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).resolves.toMatchObject({ status: 'PENDING_REVIEW', version: 1 });
  });
});
