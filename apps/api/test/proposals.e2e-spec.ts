import { createHmac, randomUUID } from 'node:crypto';
import { ProposalViewSchema } from '@barter/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { configureApp } from '../src/main.js';

const prefix = 'task-3-proposals';
const images = ['https://example.test/2.jpg', 'https://example.test/1.jpg', 'https://example.test/3.jpg'];
const terms = { differenceFen: 100, payer: 'INITIATOR', deliveryMode: 'COURIER', initiatorShippingFen: 500, recipientShippingFen: 600 };

describe('proposal creation and participant queries', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: string[];
  let tokens: string[];
  let offered: string[];
  let target: string;
  let hidden: string;
  let operatorToken: string;
  const token = (id: string, operator = false) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [ { alg: 'HS256', typ: 'JWT' }, { sub: id, roles: [operator ? 'REVIEWER' : 'CUSTOMER'], type: operator ? 'OPERATOR' : 'CUSTOMER', iat: now, exp: now + 900 } ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${unsigned}.${createHmac('sha256', process.env.JWT_SECRET!).update(unsigned).digest('base64url')}`;
  };
  const input = () => ({ offeredItemIds: offered, targetItemId: target, ...terms });
  const create = (body: object = input(), key: string = randomUUID(), auth = tokens[0]!) => request(app.getHttpServer()).post('/api/proposals').set('Authorization', `Bearer ${auth}`).set('Idempotency-Key', key).send(body);
  const get = (path: string, auth = tokens[0]!) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${auth}`);

  async function cleanup() {
    const ids = (await prisma.user.findMany({ where: { OR: [{ wechatOpenid: { startsWith: prefix } }, { adminCredential: { email: `${prefix}@example.test` } }] } })).map(user => user.id);
    if (!ids.length) return;
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersion" DISABLE TRIGGER "ProposalVersion_immutable"');
      await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersionItem" DISABLE TRIGGER "ProposalVersionItem_immutable"');
      try {
        await tx.itemReservation.deleteMany({ where: { proposal: { initiatorId: { in: ids } } } });
        await tx.proposalVersionItem.deleteMany({ where: { proposalVersion: { proposal: { initiatorId: { in: ids } } } } });
        await tx.proposalVersion.deleteMany({ where: { proposal: { initiatorId: { in: ids } } } });
        await tx.proposal.deleteMany({ where: { initiatorId: { in: ids } } });
        await tx.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await tx.item.deleteMany({ where: { ownerId: { in: ids } } });
        await tx.user.deleteMany({ where: { id: { in: ids } } });
      } finally {
        await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersionItem" ENABLE TRIGGER "ProposalVersionItem_immutable"');
        await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersion" ENABLE TRIGGER "ProposalVersion_immutable"');
      }
    });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    users = [];
    for (const name of ['initiator', 'recipient', 'outsider']) {
      users.push((await prisma.user.create({ data: { wechatOpenid: `${prefix}-${name}`, roles: { create: { role: 'CUSTOMER' } } } })).id);
    }
    tokens = users.map(id => token(id));
    const operator = await prisma.user.create({ data: { roles: { create: { role: 'REVIEWER' } }, adminCredential: { create: { email: `${prefix}@example.test`, passwordHash: 'unused' } } } });
    operatorToken = token(operator.id, true);
    const makeItem = async (ownerId: string, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE') => (await prisma.item.create({ data: {
      ownerId, status, title: '保存完整物品标题', description: '这是必须独立保存的完整物品描述', condition: 'GOOD', referenceValueFen: 2000, wantedText: '想换咖啡机', version: 3,
      images: { create: images.map((url, sortOrder) => ({ url, sortOrder })) },
    } })).id;
    offered = [await makeItem(users[0]!), await makeItem(users[0]!)];
    target = await makeItem(users[1]!);
    hidden = await makeItem(users[0]!, 'DRAFT');
  });
  afterAll(async () => { if (prisma) await cleanup(); if (app) await app.close(); });

  it('creates a complete immutable version, recipient turn, seven-day expiry and one audit', async () => {
    const before = Date.now();
    const { body } = await create().expect(201);
    expect(ProposalViewSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ initiatorId: users[0], recipientId: users[1], responderId: users[1], status: 'PENDING', version: 1, currentVersion: 1, confirmedAt: null, reservationExpiresAt: null });
    expect(new Date(body.expiresAt).getTime() - before).toBeGreaterThanOrEqual(7 * 86400000);
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(7 * 86400000);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ ...terms, number: 1, authorId: users[0] });
    expect(body.versions[0].offeredItems.map((item: { itemId: string }) => item.itemId)).toEqual(offered);
    expect(body.versions[0].targetItem).toMatchObject({ itemId: target, ownerId: users[1], itemVersion: 3, imageUrls: images });
    await prisma.item.update({ where: { id: offered[0] }, data: { title: '后来的新标题', description: '后来的新描述', version: 4, images: { deleteMany: {} } } });
    expect((await get(`/api/proposals/${body.id}`).expect(200)).body.versions).toEqual(body.versions);
    await prisma.item.update({ where: { id: offered[0] }, data: { title: '保存完整物品标题', description: '这是必须独立保存的完整物品描述', version: 3, images: { create: images.map((url, sortOrder) => ({ url, sortOrder })) } } });
    expect(await prisma.auditLog.count({ where: { entityId: body.id, action: 'PROPOSAL_CREATED' } })).toBe(1);
    expect(await prisma.itemReservation.count({ where: { proposalId: body.id } })).toBe(0);
  });

  it('lists sent/received only for the actor and hides detail from outsiders', async () => {
    const { body } = await create().expect(201);
    for (const [index, direction] of [[0, 'sent'], [1, 'received']] as const) {
      const list = await get(`/api/me/proposals?direction=${direction}`, tokens[index]).expect(200);
      expect(list.body.some((p: { id: string }) => p.id === body.id)).toBe(true);
      expect((await get(`/api/proposals/${body.id}`, tokens[index]).expect(200)).body).toEqual(body);
    }
    expect((await get('/api/me/proposals?direction=received').expect(200)).body).toEqual([]);
    expect((await get('/api/me/proposals?direction=sent', tokens[2]).expect(200)).body).toEqual([]);
    await get(`/api/proposals/${body.id}`, tokens[2]).expect(404).expect(({ body: error }) => expect(error.code).toBe('PROPOSAL_NOT_FOUND'));
    await get(`/api/proposals/${randomUUID()}`).expect(404);
    await get('/api/me/proposals?direction=other').expect(400);
  });

  it('requires a customer session and valid idempotency key on creation and query', async () => {
    await request(app.getHttpServer()).post('/api/proposals').send(input()).expect(401);
    await create(input(), randomUUID(), operatorToken).expect(403);
    await get('/api/me/proposals?direction=sent', operatorToken).expect(403);
    await request(app.getHttpServer()).post('/api/proposals').set('Authorization', `Bearer ${tokens[0]}`).send(input()).expect(400);
    await create(input(), 'x'.repeat(201)).expect(400);
    await create(input(), ' ').expect(400);
  });

  it('rejects invalid quantities, duplicates, amounts, payer, shipping and unknown identity fields', async () => {
    const invalid = [
      { offeredItemIds: [] }, { offeredItemIds: Array.from({ length: 6 }, () => randomUUID()) },
      { offeredItemIds: [offered[0], offered[0]] }, { targetItemId: offered[0] },
      { differenceFen: -1 }, { differenceFen: 20001 }, { differenceFen: 1.5 },
      { differenceFen: 0 }, { payer: 'NONE' }, { initiatorShippingFen: -1 }, { recipientShippingFen: 1.5 },
      { initiatorShippingFen: 2147483648 }, { deliveryMode: 'IN_PERSON' }, { recipientId: users[2] },
    ];
    for (const changes of invalid) await create({ ...input(), ...changes }).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
  });

  it('rejects non-owned, missing, inactive, self-target and reserved items', async () => {
    for (const changes of [ { offeredItemIds: [target], targetItemId: offered[0] }, { offeredItemIds: [randomUUID()] }, { offeredItemIds: [hidden] }, { targetItemId: hidden }, { offeredItemIds: [offered[0]], targetItemId: offered[1] } ]) {
      await create({ ...input(), ...changes }).expect(409).expect(({ body }) => expect(body.code).toBe('ITEM_UNAVAILABLE'));
    }
    const { body } = await create().expect(201);
    for (const itemId of [offered[0]!, target]) {
      await prisma.itemReservation.create({ data: { itemId, proposalId: body.id, proposalVersionId: body.versions[0].id, expiresAt: new Date(Date.now() + 60000) } });
      await create().expect(409).expect(({ body: error }) => expect(error.code).toBe('ITEM_UNAVAILABLE'));
      await prisma.itemReservation.delete({ where: { itemId } });
    }
  });

  it('replays normalized identical requests, rejects changed content, and preserves original responses', async () => {
    const key = randomUUID();
    const first = await create(input(), key).expect(201);
    const reordered = { ...terms, targetItemId: target.toUpperCase(), offeredItemIds: offered.map(id => id.toUpperCase()) };
    expect((await create(reordered, key).expect(201)).body).toEqual(first.body);
    await create({ ...input(), differenceFen: 101 }, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
    await create({ ...input(), offeredItemIds: [...offered].reverse() }, key).expect(409);
    await prisma.proposal.update({ where: { id: first.body.id }, data: { status: 'EXPIRED' } });
    expect((await create(input(), key).expect(201)).body).toEqual(first.body);
    expect(await prisma.auditLog.count({ where: { entityId: first.body.id } })).toBe(1);
    expect((await prisma.idempotencyRecord.findFirstOrThrow({ where: { actorId: users[0], key } })).requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles concurrent identical and conflicting retries atomically', async () => {
    const key = randomUUID();
    const same = await Promise.all([create(input(), key), create(input(), key)]);
    expect(same.map(r => r.status)).toEqual([201, 201]);
    expect(same[1]!.body).toEqual(same[0]!.body);
    expect(await prisma.auditLog.count({ where: { entityId: same[0]!.body.id } })).toBe(1);
    const otherKey = randomUUID();
    const changed = await Promise.all([create(input(), otherKey), create({ ...input(), differenceFen: 200 }, otherKey)]);
    expect(changed.map(r => r.status).sort()).toEqual([201, 409]);
    expect(changed.find(r => r.status === 409)!.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rolls back proposal, versions, snapshots, audit and idempotency on audit failure', async () => {
    const countOwned = () => Promise.all([
      prisma.proposal.count({ where: { initiatorId: users[0] } }),
      prisma.proposalVersion.count({ where: { proposal: { initiatorId: users[0] } } }),
      prisma.proposalVersionItem.count({ where: { proposalVersion: { proposal: { initiatorId: users[0] } } } }),
      prisma.auditLog.count({ where: { actorId: users[0] } }),
    ]);
    const counts = await countOwned();
    const key = randomUUID();
    const spy = vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    try { await create(input(), key).expect(500); } finally { spy.mockRestore(); }
    expect(await countOwned()).toEqual(counts);
    expect(await prisma.idempotencyRecord.count({ where: { actorId: users[0], key } })).toBe(0);
    await create(input(), key).expect(201);
  });
});
