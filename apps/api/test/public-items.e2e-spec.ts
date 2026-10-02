import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { configureApp } from '../src/main.js';

const prefix = 'task-2-public-items';
const imageUrls = ['https://example.test/1.jpg', 'https://example.test/2.jpg', 'https://example.test/3.jpg'];

describe('public item discovery', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerId: string;
  let hiddenId: string;
  let activeIds: string[];

  async function cleanup() {
    const users = await prisma.user.findMany({ where: { wechatOpenid: { startsWith: prefix } }, select: { id: true } });
    const userIds = users.map(({ id }) => id);
    if (!userIds.length) return;
    const items = await prisma.item.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersion" DISABLE TRIGGER "ProposalVersion_immutable"');
      await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersionItem" DISABLE TRIGGER "ProposalVersionItem_immutable"');
      try {
        await tx.itemReservation.deleteMany({ where: { itemId: { in: items.map(({ id }) => id) } } });
        await tx.proposalVersionItem.deleteMany({ where: { itemId: { in: items.map(({ id }) => id) } } });
        await tx.proposalVersion.deleteMany({ where: { proposal: { initiatorId: { in: userIds } } } });
        await tx.proposal.deleteMany({ where: { initiatorId: { in: userIds } } });
        await tx.item.deleteMany({ where: { ownerId: { in: userIds } } });
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      } finally {
        await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersionItem" ENABLE TRIGGER "ProposalVersionItem_immutable"');
        await tx.$executeRawUnsafe('ALTER TABLE "ProposalVersion" ENABLE TRIGGER "ProposalVersion_immutable"');
      }
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    const owner = await prisma.user.create({ data: { wechatOpenid: `${prefix}-owner`, roles: { create: { role: 'CUSTOMER' } } } });
    const recipient = await prisma.user.create({ data: { wechatOpenid: `${prefix}-recipient`, roles: { create: { role: 'CUSTOMER' } } } });
    ownerId = owner.id;
    const createItem = (title: string, status: 'ACTIVE' | 'DRAFT', createdAt: Date, itemOwnerId = owner.id) => prisma.item.create({
      data: { ownerId: itemOwnerId, title, description: '公开描述应能显示', referenceValueFen: 12000, condition: 'GOOD', wantedText: '小型咖啡机', status, rejectReason: 'private moderation reason', createdAt, images: { create: imageUrls.map((url, sortOrder) => ({ url, sortOrder })) } },
    });
    const created = await Promise.all([
      createItem('较新物品', 'ACTIVE', new Date('2026-09-20T00:00:00Z')),
      createItem('同一时间 A', 'ACTIVE', new Date('2026-09-19T00:00:00Z')),
      createItem('同一时间 B', 'ACTIVE', new Date('2026-09-19T00:00:00Z')),
      createItem('草稿秘密', 'DRAFT', new Date('2026-09-21T00:00:00Z')),
    ]);
    activeIds = created.slice(0, 3).map(({ id }) => id);
    hiddenId = created[3]!.id;
    const proposal = await prisma.proposal.create({ data: { initiatorId: owner.id, recipientId: recipient.id, responderId: recipient.id, expiresAt: new Date('2030-01-01T00:00:00Z') } });
    const version = await prisma.proposalVersion.create({ data: { proposalId: proposal.id, authorId: owner.id, number: 1, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    await prisma.itemReservation.createMany({ data: [
      { itemId: activeIds[0]!, proposalId: proposal.id, proposalVersionId: version.id, expiresAt: new Date('2030-01-01T00:00:00Z') },
      { itemId: activeIds[1]!, proposalId: proposal.id, proposalVersionId: version.id, expiresAt: new Date('2020-01-01T00:00:00Z') },
    ] });
  });

  afterAll(async () => { if (prisma) await cleanup(); if (app) await app.close(); });

  it('lists only active items with explicit safe fields and availability based on live reservations', async () => {
    // Browser runs leave newer reviewed items in the same dedicated test database.
    // Start at this fixture's time window instead of assuming it is in the newest 20 rows.
    const start = Buffer.from(JSON.stringify({ createdAt: '2026-09-21T00:00:00.000Z', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toString('base64url');
    const { body } = await request(app.getHttpServer()).get('/api/items').query({ cursor: start }).expect(200);
    const ownItems = body.items.filter((item: { ownerId: string }) => item.ownerId === ownerId);
    expect(ownItems).toHaveLength(3);
    expect(ownItems.map((item: { availableForProposal: boolean }) => item.availableForProposal)).toEqual([false, true, true]);
    for (const item of ownItems) {
      expect(Object.keys(item).sort()).toEqual(['availableForProposal', 'condition', 'createdAt', 'description', 'id', 'imageUrls', 'ownerId', 'referenceValueFen', 'status', 'title', 'updatedAt', 'version', 'wantedText']);
      expect(item.imageUrls).toEqual(imageUrls);
    }
    expect(JSON.stringify(body)).not.toContain('草稿秘密');
    expect(JSON.stringify(body)).not.toContain('private moderation reason');
  });

  it('uses a stable descending createdAt/id cursor and rejects malformed cursors', async () => {
    const start = Buffer.from(JSON.stringify({ createdAt: '2026-09-21T00:00:00.000Z', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toString('base64url');
    const first = await request(app.getHttpServer()).get('/api/items').query({ limit: 2, cursor: start }).expect(200);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app.getHttpServer()).get('/api/items').query({ limit: 2, cursor: first.body.nextCursor }).expect(200);
    const all = [...first.body.items, ...second.body.items];
    expect(new Set(all.map((item: { id: string }) => item.id)).size).toBe(all.length);
    expect(all.map((item: { id: string }) => item.id)).toEqual([activeIds[0], ...activeIds.slice(1).sort().reverse()]);
    expect(second.body.nextCursor).toBeNull();
    await request(app.getHttpServer()).get('/api/items?cursor=garbage').expect(400);
  });

  it('defaults to a twenty-item page and returns a continuation cursor', async () => {
    const extras = await prisma.item.createManyAndReturn({ data: Array.from({ length: 21 }, (_, index) => ({
      ownerId, title: `额外物品 ${index}`, description: '用于检查公开列表默认分页', referenceValueFen: 12000,
      condition: 'GOOD', wantedText: '咖啡机', status: 'ACTIVE', createdAt: new Date('2026-09-18T00:00:00Z'),
    })) });
    try {
      const start = Buffer.from(JSON.stringify({ createdAt: '2026-09-19T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000000' })).toString('base64url');
      const { body } = await request(app.getHttpServer()).get('/api/items').query({ cursor: start }).expect(200);
      expect(body.items).toHaveLength(20);
      expect(body.nextCursor).toEqual(expect.any(String));
    } finally {
      await prisma.item.deleteMany({ where: { id: { in: extras.map(({ id }) => id) } } });
    }
  });

  it('hides drafts in detail and returns the public projection for active items', async () => {
    await request(app.getHttpServer()).get(`/api/items/${hiddenId}`).expect(404).expect(({ body }) => expect(body.code).toBe('ITEM_NOT_FOUND'));
    const { body } = await request(app.getHttpServer()).get(`/api/items/${activeIds[0]}`).expect(200);
    expect(body).toMatchObject({ id: activeIds[0], status: 'ACTIVE', availableForProposal: false });
    expect(body).not.toHaveProperty('rejectReason');
    expect(body).not.toHaveProperty('wechatOpenid');
  });
});
