import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());

// Rollback keeps append-only history intact and leaves no fixtures behind.
async function inRollback(run: (tx: Prisma.TransactionClient) => Promise<void>) {
  const rollback = new Error('fixture rollback');
  try {
    await prisma.$transaction(async (tx) => { await run(tx); throw rollback; });
  } catch (error) { if (error !== rollback) throw error; }
}

async function fixture(tx: Prisma.TransactionClient) {
  const a = await tx.user.create({ data: {} });
  const b = await tx.user.create({ data: {} });
  const itemData = { title: '历史快照原始标题', description: '原始完整物品描述', referenceValueFen: 1000, condition: 'GOOD' as const, wantedText: '书', status: 'ACTIVE' as const };
  const item = await tx.item.create({ data: { ...itemData, ownerId: a.id } });
  const target = await tx.item.create({ data: { ...itemData, title: '对方历史目标物品', ownerId: b.id } });
  const proposal = await tx.proposal.create({ data: { initiatorId: a.id, recipientId: b.id, responderId: b.id, expiresAt: new Date('2030-01-01T00:00:00Z') } });
  const version = await tx.proposalVersion.create({ data: {
    proposalId: proposal.id, number: 1, authorId: a.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0,
    items: { create: [{ itemId: item.id, ownerId: a.id, side: 'INITIATOR', sortOrder: 0, itemVersion: 1,
      title: item.title, description: item.description, referenceValueFen: item.referenceValueFen, condition: item.condition, wantedText: item.wantedText,
      imageUrls: ['https://img.test/1', 'https://img.test/2', 'https://img.test/3'] },
    { itemId: target.id, ownerId: b.id, side: 'RECIPIENT', sortOrder: 0, itemVersion: 1,
      title: target.title, description: target.description, referenceValueFen: target.referenceValueFen, condition: target.condition, wantedText: target.wantedText,
      imageUrls: ['https://img.test/4', 'https://img.test/5', 'https://img.test/6'] }] },
  } });
  return { a, b, item, target, proposal, version };
}

describe('proposal persistence on PostgreSQL', () => {
  it('installs proposal persistence tables', async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string | null }>>`SELECT to_regclass('"ProposalVersion"')::text AS name`;
    expect(rows[0]?.name).toBe('"ProposalVersion"');
  });
  it('reconstructs the original offer independently of later item edits', async () => {
    await inRollback(async (tx) => {
      const { item, target, version } = await fixture(tx);
      await tx.item.update({ where: { id: item.id }, data: { title: '现在已经修改的标题', referenceValueFen: 2000, version: 2 } });
      await tx.item.update({ where: { id: target.id }, data: { title: '对方已经修改标题', referenceValueFen: 3000, version: 3 } });
      const saved = await tx.proposalVersion.findUniqueOrThrow({ where: { id: version.id }, include: { items: true } });
      expect(saved.items).toHaveLength(2);
      expect(saved.items.find((snapshot) => snapshot.side === 'INITIATOR')).toMatchObject({ title: '历史快照原始标题', referenceValueFen: 1000, itemVersion: 1, imageUrls: ['https://img.test/1', 'https://img.test/2', 'https://img.test/3'] });
      expect(saved.items.find((snapshot) => snapshot.side === 'RECIPIENT')).toMatchObject({ title: '对方历史目标物品', referenceValueFen: 1000, itemVersion: 1, imageUrls: ['https://img.test/4', 'https://img.test/5', 'https://img.test/6'] });
      expect(saved).toMatchObject({ number: 1, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON' });
    });
  });
  it.each(['version update', 'version delete', 'item update', 'item delete'])('rejects immutable history mutation: %s', async (operation) => {
    await expect(inRollback(async (tx) => {
      const { version } = await fixture(tx);
      if (operation === 'version update') await tx.proposalVersion.update({ where: { id: version.id }, data: { differenceFen: 10, payer: 'INITIATOR' } });
      if (operation === 'version delete') await tx.proposalVersion.delete({ where: { id: version.id } });
      if (operation === 'item update') await tx.proposalVersionItem.updateMany({ where: { proposalVersionId: version.id }, data: { title: '篡改' } });
      if (operation === 'item delete') await tx.proposalVersionItem.deleteMany({ where: { proposalVersionId: version.id } });
    })).rejects.toThrow(/immutable/i);
  });
  it('enforces one reservation per item across competing proposals', async () => {
    await expect(inRollback(async (tx) => {
      const { a, b, item, proposal, version } = await fixture(tx);
      const second = await tx.proposal.create({ data: { initiatorId: a.id, recipientId: b.id, responderId: b.id, expiresAt: new Date('2030-01-01T00:00:00Z') } });
      await tx.itemReservation.create({ data: { itemId: item.id, proposalId: proposal.id, proposalVersionId: version.id, expiresAt: new Date('2030-01-01T00:00:00Z') } });
      await tx.itemReservation.create({ data: { itemId: item.id, proposalId: second.id, proposalVersionId: version.id, expiresAt: new Date('2030-01-01T00:00:00Z') } });
    })).rejects.toMatchObject({ code: 'P2002' });
  });
  it('rejects duplicated version numbers and invalid persisted monetary terms', async () => {
    await expect(inRollback(async (tx) => {
      const { proposal, a } = await fixture(tx);
      await tx.proposalVersion.create({ data: { proposalId: proposal.id, number: 1, authorId: a.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 } });
    })).rejects.toMatchObject({ code: 'P2002' });
    await expect(inRollback(async (tx) => {
      const { proposal, a } = await fixture(tx);
      await tx.proposalVersion.create({ data: { id: randomUUID(), proposalId: proposal.id, number: 2, authorId: a.id, differenceFen: 20001, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 1, recipientShippingFen: 0 } });
    })).rejects.toThrow(/check constraint/i);
  });
});
