import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const offer = {
  offeredItemIds: [id(1)], targetItemId: id(2), differenceFen: 0,
  payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0,
};

describe('proposal boundary contracts', () => {
  it('exports usable schemas through the shared public package', () => {
    expect(contracts).toHaveProperty('CreateProposalSchema');
    expect(contracts).toHaveProperty('PublicItemViewSchema');
    expect(contracts).toHaveProperty('ProposalVersionViewSchema');
  });

  it('allows one through five offered items and integer difference up to 20000 fen', () => {
    expect(contracts.CreateProposalSchema.parse(offer)).toEqual(offer);
    expect(contracts.CreateProposalSchema.safeParse({ ...offer, offeredItemIds: [1, 3, 4, 5, 6].map(id), differenceFen: 20000, payer: 'INITIATOR' }).success).toBe(true);
    expect(contracts.CreateProposalSchema.safeParse({ ...offer, deliveryMode: 'COURIER', initiatorShippingFen: 100, recipientShippingFen: 500 }).success).toBe(true);
  });

  it.each([
    { offeredItemIds: [] }, { offeredItemIds: [1, 3, 4, 5, 6, 7].map(id) },
    { offeredItemIds: [id(1), id(1)] }, { offeredItemIds: [id(2)] },
    { differenceFen: -1 }, { differenceFen: 1.5 }, { differenceFen: 20001 },
    { differenceFen: 1, payer: 'NONE' }, { payer: 'RECIPIENT' },
    { initiatorShippingFen: 1 }, { deliveryMode: 'COURIER', recipientShippingFen: -1 },
    { deliveryMode: 'COURIER', initiatorShippingFen: 1.5 }, { targetItemId: 'bad' },
    { recipientId: id(9) },
  ])('rejects invalid or client-controlled fields: %j', (patch) => {
    expect(contracts.CreateProposalSchema.safeParse({ ...offer, ...patch }).success).toBe(false);
  });

  it('requires expectedVersion on every command after create and rejects extra fields', () => {
    expect(contracts.CounterProposalSchema.safeParse(offer).success).toBe(false);
    expect(contracts.CounterProposalSchema.safeParse({ ...offer, expectedVersion: 2 }).success).toBe(true);
    for (const schema of [contracts.AcceptProposalSchema, contracts.RejectProposalSchema, contracts.CancelProposalSchema]) {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ expectedVersion: 0 }).success).toBe(false);
      expect(schema.parse({ expectedVersion: 2 })).toEqual({ expectedVersion: 2 });
      expect(schema.safeParse({ expectedVersion: 2, actorId: id(1) }).success).toBe(false);
    }
    expect(contracts.ProposalIdempotencyKeySchema.safeParse(' ').success).toBe(false);
  });

  it('treats differently cased UUIDs as the same item', () => {
    const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(contracts.CreateProposalSchema.safeParse({ ...offer, offeredItemIds: [itemId, itemId.toUpperCase()] }).success).toBe(false);
    expect(contracts.CreateProposalSchema.safeParse({ ...offer, offeredItemIds: [itemId], targetItemId: itemId.toUpperCase() }).success).toBe(false);
  });

  it('projects safe public fields and validates UTC timestamps', () => {
    const item = { id: id(1), ownerId: id(3), title: '旧款通勤背包', description: '保存完好有正常使用痕迹',
      referenceValueFen: 1000, condition: 'GOOD', imageUrls: ['https://img.test/1', 'https://img.test/2', 'https://img.test/3'],
      wantedText: '', status: 'ACTIVE', version: 1, availableForProposal: true,
      createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', rejectReason: 'private', wechatOpenid: 'private' };
    const result = contracts.PublicItemViewSchema.parse(item);
    expect(result).not.toHaveProperty('rejectReason');
    expect(result).not.toHaveProperty('wechatOpenid');
    expect(contracts.PublicItemViewSchema.safeParse({ ...item, status: 'DRAFT' }).success).toBe(false);
    expect(contracts.PublicItemViewSchema.safeParse({ ...item, createdAt: '2026-09-29T08:00:00+08:00' }).success).toBe(false);
  });
});
