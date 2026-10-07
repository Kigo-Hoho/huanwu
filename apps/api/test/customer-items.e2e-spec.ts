import { createHmac } from 'node:crypto';

import type { Role } from '@barter/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { configureApp } from '../src/main.js';

const jwtSecret = 'task-5-e2e-jwt-secret-with-sufficient-entropy';
const identityPrefix = 'task-5-items-e2e';

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

const validItem = {
  title: '九成新通勤双肩包',
  description: '正常使用痕迹，拉链和内衬完好，细节均已拍照。',
  referenceValueFen: 25_000,
  condition: 'GOOD' as const,
  imageUrls: [
    'http://images.example.test/items/1.jpg',
    'http://images.example.test/items/2.jpg',
    'http://images.example.test/items/3.jpg',
  ],
  wantedText: '希望交换小型咖啡机',
};

describe('customer item drafts and submission', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let customerId: string;
  let otherCustomerId: string;
  let operatorId: string;
  let customerToken: string;
  let otherCustomerToken: string;
  let operatorToken: string;
  const originalJwtSecret = process.env.JWT_SECRET;

  async function createDraft(
    token = customerToken,
    item = validItem,
  ): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${token}`)
      .send(item)
      .expect(201);
    return response.body as Record<string, unknown>;
  }

  function submit(itemId: string, key: string, token = customerToken) {
    return request(app.getHttpServer())
      .post(`/api/items/${itemId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key);
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
        wechatOpenid: `${identityPrefix}-owner`,
        roles: { create: { role: 'CUSTOMER' } },
      },
    });
    const otherCustomer = await prisma.user.create({
      data: {
        wechatOpenid: `${identityPrefix}-other`,
        roles: { create: { role: 'CUSTOMER' } },
      },
    });
    const operator = await prisma.user.create({
      data: {
        roles: { create: { role: 'OPERATIONS' } },
        adminCredential: {
          create: {
            email: `${identityPrefix}@example.test`,
            passwordHash: 'not-used-by-this-test',
          },
        },
      },
    });
    customerId = customer.id;
    otherCustomerId = otherCustomer.id;
    operatorId = operator.id;
    customerToken = signToken(customerId, ['CUSTOMER'], 'CUSTOMER');
    otherCustomerToken = signToken(otherCustomerId, ['CUSTOMER'], 'CUSTOMER');
    operatorToken = signToken(operatorId, ['OPERATIONS'], 'OPERATOR');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('creates a draft with persisted ordered images and UTC ISO timestamps', async () => {
    const body = await createDraft();

    expect(body).toMatchObject({
      ...validItem,
      ownerId: customerId,
      status: 'DRAFT',
      version: 1,
      rejectReason: null,
    });
    expect(body.id).toEqual(expect.any(String));
    expect(body.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(body.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    const images = await prisma.itemImage.findMany({
      where: { itemId: body.id as string },
      orderBy: { sortOrder: 'asc' },
    });
    expect(images.map(({ url, sortOrder }) => ({ url, sortOrder }))).toEqual(
      validItem.imageUrls.map((url, sortOrder) => ({ url, sortOrder })),
    );
  });

  it('rejects operator tokens on customer item routes', async () => {
    await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(validItem)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
  });

  it('does not reveal another user draft', async () => {
    const otherDraft = await createDraft(otherCustomerToken);

    await request(app.getHttpServer())
      .get(`/api/me/items/${otherDraft.id as string}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('ITEM_NOT_FOUND'));

    await request(app.getHttpServer())
      .patch(`/api/items/${otherDraft.id as string}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ title: '不应成功修改的标题' })
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('ITEM_NOT_FOUND'));
  });

  it('lists only the current customer items and reads an owned item', async () => {
    const ownDraft = await createDraft();
    await createDraft(otherCustomerToken);

    await request(app.getHttpServer())
      .get('/api/me/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.length).toBeGreaterThan(0);
        expect(body.every((item: { ownerId: string }) => item.ownerId === customerId)).toBe(true);
      });

    await request(app.getHttpServer())
      .get(`/api/me/items/${ownDraft.id as string}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(200)
      .expect(({ body }) => expect(body.id).toBe(ownDraft.id));
  });

  it('updates a draft, replaces image rows, and increments its version', async () => {
    const draft = await createDraft();
    const imageUrls = [
      'https://cdn.example.test/new/1.webp',
      'https://cdn.example.test/new/2.webp',
      'https://cdn.example.test/new/3.webp',
    ];
    const response = await request(app.getHttpServer())
      .patch(`/api/items/${draft.id as string}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ title: '更新后的通勤双肩包', imageUrls })
      .expect(200);

    expect(response.body).toMatchObject({
      title: '更新后的通勤双肩包',
      imageUrls,
      status: 'DRAFT',
      version: 2,
    });
    const images = await prisma.itemImage.findMany({
      where: { itemId: draft.id as string },
      orderBy: { sortOrder: 'asc' },
    });
    expect(images.map(({ url }) => url)).toEqual(imageUrls);
  });

  it('editing a rejected item clears the reason and returns it to draft', async () => {
    const draft = await createDraft();
    await prisma.item.update({
      where: { id: draft.id as string },
      data: { status: 'REJECTED', rejectReason: '图片细节不足', version: 7 },
    });

    await request(app.getHttpServer())
      .patch(`/api/items/${draft.id as string}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ description: '补充了更多使用痕迹说明和对应细节照片。' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('DRAFT');
        expect(body.rejectReason).toBeNull();
        expect(body.version).toBe(8);
      });
  });

  it('requires at least three persisted image rows before submission', async () => {
    const draft = await createDraft();
    await prisma.itemImage.deleteMany({
      where: { itemId: draft.id as string, sortOrder: { gte: 2 } },
    });

    await submit(draft.id as string, 'too-few-images')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ITEM_INVALID_STATE'));
  });

  it('does not reveal another user item during submission', async () => {
    const otherDraft = await createDraft(otherCustomerToken);

    await submit(otherDraft.id as string, 'submit-other-users-item')
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('ITEM_NOT_FOUND'));
  });

  it('rolls back state and idempotency when the audit write fails', async () => {
    const draft = await createDraft();
    const itemId = draft.id as string;
    const auditService = app.get(AuditService);
    const record = vi
      .spyOn(auditService, 'record')
      .mockRejectedValueOnce(new Error('simulated audit failure'));
    try {
      await submit(itemId, 'audit-failure-rollback').expect(500);
    } finally {
      record.mockRestore();
    }

    await expect(
      prisma.item.findUniqueOrThrow({ where: { id: itemId } }),
    ).resolves.toMatchObject({ status: 'DRAFT', version: 1 });
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          actorId: customerId,
          commandName: 'SUBMIT_ITEM',
          key: 'audit-failure-rollback',
        },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ITEM_SUBMITTED', entityId: itemId },
      }),
    ).toBe(0);
  });

  it('submits once when the same command id is retried', async () => {
    const draft = await createDraft();
    const itemId = draft.id as string;
    const commandId = 'submit-item-retry-001';

    const first = await submit(itemId, commandId).expect(200);
    const second = await submit(itemId, commandId).expect(200);

    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({ status: 'PENDING_REVIEW', version: 2 });
    expect(
      await prisma.auditLog.count({
        where: { action: 'ITEM_SUBMITTED', entityType: 'Item', entityId: itemId },
      }),
    ).toBe(1);
  });

  it('handles concurrent retries without duplicate state or audit writes', async () => {
    const draft = await createDraft();
    const itemId = draft.id as string;
    const [first, second] = await Promise.all([
      submit(itemId, 'submit-item-concurrent-001'),
      submit(itemId, 'submit-item-concurrent-001'),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body).toEqual(first.body);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ITEM_SUBMITTED', entityType: 'Item', entityId: itemId },
      }),
    ).toBe(1);
    await expect(prisma.item.findUniqueOrThrow({ where: { id: itemId } })).resolves.toMatchObject({
      status: 'PENDING_REVIEW',
      version: 2,
    });
  });

  it('allows only one state transition for concurrent distinct submit commands', async () => {
    const draft = await createDraft();
    const itemId = draft.id as string;
    const responses = await Promise.all([
      submit(itemId, 'submit-item-distinct-a'),
      submit(itemId, 'submit-item-distinct-b'),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ITEM_SUBMITTED', entityType: 'Item', entityId: itemId },
      }),
    ).toBe(1);
    await expect(
      prisma.item.findUniqueOrThrow({ where: { id: itemId } }),
    ).resolves.toMatchObject({ status: 'PENDING_REVIEW', version: 2 });
  });

  it('rejects submission without a command key and a new command in an invalid state', async () => {
    const draft = await createDraft();
    const itemId = draft.id as string;
    await request(app.getHttpServer())
      .post(`/api/items/${itemId}/submit`)
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));

    await submit(itemId, 'first-submit').expect(200);
    await submit(itemId, 'different-command')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ITEM_INVALID_STATE'));
  });
});
