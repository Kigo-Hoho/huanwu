import { createHmac, randomUUID } from 'node:crypto';
import { ProposalViewSchema } from '@barter/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  afterEach(async () => { await prisma.itemReservation.deleteMany({ where: { proposal: { initiatorId: users[0] } } }); });

  const command = (id: string, action: string, body: object, actor = 1, key: string = randomUUID()) =>
    request(app.getHttpServer()).post(`/api/proposals/${id}/${action}`).set('Authorization', `Bearer ${tokens[actor]}`).set('Idempotency-Key', key).send(body);

  it('negotiates complete immutable revisions with alternating turns and own-side changes', async () => {
    const original = (await create().expect(201)).body;
    const replacement = await prisma.item.create({ data: { ownerId: users[1]!, status: 'ACTIVE', title: '替换目标', description: '替换目标的完整描述', condition: 'GOOD', referenceValueFen: 1000, wantedText: '换物', images: { create: images.map((url, sortOrder) => ({ url, sortOrder })) } } });
    const before = Date.now();
    const second = (await command(original.id, 'counter', { ...input(), targetItemId: replacement.id, differenceFen: 200, expectedVersion: 1 }).expect(200)).body;
    expect(second).toMatchObject({ version: 2, currentVersion: 2, responderId: users[0], status: 'PENDING' });
    expect(second.versions[0]).toEqual(original.versions[0]);
    expect(second.versions[1]).toMatchObject({ number: 2, authorId: users[1], differenceFen: 200, targetItem: { itemId: replacement.id, imageUrls: images } });
    expect(second.versions[1].offeredItems).toEqual(original.versions[0].offeredItems);
    expect(new Date(second.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 7 * 86400000);
    const third = (await command(original.id, 'counter', { ...input(), offeredItemIds: [offered[1]], targetItemId: replacement.id, expectedVersion: 2 }, 0).expect(200)).body;
    expect(third).toMatchObject({ version: 3, currentVersion: 3, responderId: users[1] });
    expect(third.versions.slice(0, 2)).toEqual(second.versions);
    expect(third.versions[2].offeredItems).toHaveLength(1);
    expect(ProposalViewSchema.safeParse(third).success).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: original.id, action: 'PROPOSAL_COUNTERED' } })).toBe(2);
  });

  it('enforces turn, side, participant, role and version boundaries on commands', async () => {
    const { id } = (await create().expect(201)).body;
    const counter = { ...input(), expectedVersion: 1 };
    for (const action of ['counter', 'accept', 'reject']) {
      await command(id, action, action === 'counter' ? counter : { expectedVersion: 1 }, 0).expect(403).expect(({ body }) => expect(body.code).toBe('PROPOSAL_WRONG_TURN'));
    }
    await command(id, 'counter', { ...counter, offeredItemIds: [offered[0]] }).expect(403).expect(({ body }) => expect(body.code).toBe('PROPOSAL_SIDE_FORBIDDEN'));
    await command(id, 'counter', { ...counter, targetItemId: hidden }).expect(409).expect(({ body }) => expect(body.code).toBe('ITEM_UNAVAILABLE'));
    for (const action of ['counter', 'accept', 'reject', 'cancel']) {
      const body = action === 'counter' ? counter : { expectedVersion: 1 };
      await command(id, action, body, 2).expect(404);
      await request(app.getHttpServer()).post(`/api/proposals/${id}/${action}`).set('Authorization', `Bearer ${operatorToken}`).set('Idempotency-Key', randomUUID()).send(body).expect(403);
      await command(id, action, { ...body, expectedVersion: 9 }).expect(409).expect(({ body: error }) => expect(error.code).toBe('PROPOSAL_VERSION_CONFLICT'));
      await command(id, action, { ...body, unexpected: true }).expect(400);
      await command(id, action, body, 1, ' ').expect(400);
    }
    await command(id, 'counter', counter).expect(200);
    await command(id, 'counter', { ...counter, expectedVersion: 2, targetItemId: randomUUID() }, 0).expect(403).expect(({ body }) => expect(body.code).toBe('PROPOSAL_SIDE_FORBIDDEN'));
  });

  it('serializes concurrent counters, including both participants, and replays original results', async () => {
    const { id } = (await create().expect(201)).body;
    const body = { ...input(), expectedVersion: 1 };
    const key = randomUUID();
    const same = await Promise.all([command(id, 'counter', body, 1, key), command(id, 'counter', body, 1, key)]);
    expect(same.map(r => r.status)).toEqual([200, 200]);
    expect(same[0]!.body).toEqual(same[1]!.body);
    await command(id, 'counter', { ...body, differenceFen: 101 }, 1, key).expect(409).expect(({ body: error }) => expect(error.code).toBe('IDEMPOTENCY_CONFLICT'));
    const other = (await create().expect(201)).body;
    await command(other.id, 'counter', body, 1, key).expect(409).expect(({ body: error }) => expect(error.code).toBe('IDEMPOTENCY_CONFLICT'));
    const concurrent = await Promise.all([command(id, 'counter', { ...body, expectedVersion: 2 }, 0), command(id, 'counter', { ...body, expectedVersion: 2 }, 1)]);
    expect(concurrent.filter(r => r.status === 200)).toHaveLength(1);
    expect([403, 409]).toContain(concurrent.find(r => r.status !== 200)!.status);
    expect((await command(id, 'counter', body, 1, key).expect(200)).body).toEqual(same[0]!.body);
    expect(await prisma.proposalVersion.count({ where: { proposalId: id } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'PROPOSAL_COUNTERED' } })).toBe(2);
    const race = (await create().expect(201)).body;
    const competing = await Promise.all([command(race.id, 'counter', body), command(race.id, 'counter', { ...body, differenceFen: 101 })]);
    expect(competing.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it('rejects or cancels once, allows either participant cancellation, and blocks terminated commands', async () => {
    for (const [action, actor, status] of [['reject', 1, 'REJECTED'], ['cancel', 0, 'CANCELLED'], ['cancel', 1, 'CANCELLED']] as const) {
      const original = (await create().expect(201)).body;
      const key = randomUUID();
      const result = (await command(original.id, action, { expectedVersion: 1 }, actor, key).expect(200)).body;
      expect(result).toMatchObject({ status, version: 2, currentVersion: 1, versions: original.versions });
      expect((await command(original.id, action, { expectedVersion: 1 }, actor, key).expect(200)).body).toEqual(result);
      await command(original.id, action, { expectedVersion: 2 }, actor, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
      for (const next of ['accept', 'reject', 'cancel', 'counter']) {
        await command(original.id, next, next === 'counter' ? { ...input(), expectedVersion: 2 } : { expectedVersion: 2 }).expect(409).expect(({ body }) => expect(body.code).toBe('PROPOSAL_INVALID_STATE'));
      }
      expect(await prisma.auditLog.count({ where: { entityId: original.id } })).toBe(2);
    }
  });

  it('cancels confirmed proposals and releases reservations in the audit transaction', async () => {
    const original = (await create().expect(201)).body;
    await prisma.proposal.update({ where: { id: original.id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), reservationExpiresAt: new Date(Date.now() + 60000) } });
    await prisma.itemReservation.create({ data: { itemId: target, proposalId: original.id, proposalVersionId: original.versions[0].id, expiresAt: new Date(Date.now() + 60000) } });
    const spy = vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('cancel audit failure'));
    try { await command(original.id, 'cancel', { expectedVersion: 1 }).expect(500); } finally { spy.mockRestore(); }
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('CONFIRMED');
    expect(await prisma.itemReservation.count({ where: { proposalId: original.id } })).toBe(1);
    await command(original.id, 'cancel', { expectedVersion: 1 }).expect(200);
    expect(await prisma.itemReservation.count({ where: { proposalId: original.id } })).toBe(0);
  });

  it('rolls back counter and rejection on audit failure and never confirms without reservations', async () => {
    const original = (await create().expect(201)).body;
    for (const action of ['counter', 'reject']) {
      const key = randomUUID();
      const spy = vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('negotiation audit failure'));
      try { await command(original.id, action, action === 'counter' ? { ...input(), expectedVersion: 1 } : { expectedVersion: 1 }, 1, key).expect(500); } finally { spy.mockRestore(); }
      expect((await get(`/api/proposals/${original.id}`).expect(200)).body).toEqual(original);
      expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
    }
    await command(original.id, 'accept', { expectedVersion: 1 }).expect(409).expect(({ body }) => expect(body.code).toBe('PROPOSAL_INVALID_STATE'));
    expect((await get(`/api/proposals/${original.id}`).expect(200)).body).toEqual(original);
    expect(await prisma.itemReservation.count({ where: { proposalId: original.id } })).toBe(0);
    await prisma.proposal.update({ where: { id: original.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    for (const action of ['counter', 'accept', 'reject', 'cancel']) {
      await command(original.id, action, action === 'counter' ? { ...input(), expectedVersion: 1 } : { expectedVersion: 1 }).expect(409).expect(({ body }) => expect(body.code).toBe('PROPOSAL_EXPIRED'));
    }
  });

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
