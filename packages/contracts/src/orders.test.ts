import { describe, expect, it } from 'vitest';
import * as c from './index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-02T00:00:00.000Z';
const item = (n: number, side: 'INITIATOR' | 'RECIPIENT') => ({
  itemId: id(n), ownerId: id(side === 'INITIATOR' ? 8 : 9), itemVersion: 1, side,
  title: '通勤背包', description: '保存完好正常使用痕迹', referenceValueFen: 1000,
  condition: 'GOOD', imageUrls: ['https://img.test/1', 'https://img.test/2', 'https://img.test/3'], wantedText: '',
});
const party = (side: 'INITIATOR' | 'RECIPIENT', userId: string) => ({
  side, userId, addressReady: false, payments: [], outgoingShipment: null,
  incomingDeliveredAt: null, acceptanceDeadline: null, acceptedAt: null,
});
const order = () => ({
  id: id(1), proposalId: id(2), proposalVersionId: id(3), initiatorId: id(8), recipientId: id(9),
  status: 'AWAITING_DETAILS', version: 1,
  rules: { version: 'phase3-test-v1', depositFen: 1000, feeFen: 0, detailsHours: 24, paymentHours: 24, fulfillmentHours: 72, inspectionHours: 72 },
  terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'COURIER', initiatorShippingFen: 0, recipientShippingFen: 0 },
  items: [item(4, 'INITIATOR'), item(5, 'RECIPIENT')],
  parties: [party('INITIATOR', id(8)), party('RECIPIENT', id(9))], cancellation: null,
  holdReason: null, simulation: true, detailsDeadline: time, paymentDeadline: null,
  fulfillmentDeadline: null, createdAt: time, updatedAt: time,
});

describe('order boundary contracts', () => {
  it('projects persisted handover timestamps while allowing old immutable success summaries', () => {
    const base = party('INITIATOR', id(8));
    expect(c.OrderPartyViewSchema.safeParse({ ...base, handedOverAt: time }).success).toBe(true);
    expect(c.OrderPartyViewSchema.safeParse({ ...base, handedOverAt: null }).success).toBe(true);
    expect(c.OrderPartyViewSchema.safeParse(base).success).toBe(true);
    expect(c.OrderPartyViewSchema.safeParse({ ...base, handedOverAt: '2026-10-02T08:00:00+08:00' }).success).toBe(false);
  });
  it.each([0, -1, 1.5, '1', undefined])('requires a positive integer version: %s', (expectedVersion) => {
    expect(c.OrderCommandSchema.safeParse({ expectedVersion }).success).toBe(false);
  });
  it('accepts only a version for simple commands', () => {
    expect(c.OrderCommandSchema.parse({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 });
    expect(c.OrderCommandSchema.safeParse({ expectedVersion: 1, side: 'INITIATOR' }).success).toBe(false);
  });
  it.each(['amountFen', 'side', 'beneficiaryId', 'currency', 'orderId'])('rejects client-controlled payment %s', (key) => {
    expect(c.OrderPaymentSchema.safeParse({ expectedVersion: 1, purpose: 'DEPOSIT', [key]: 1 }).success).toBe(false);
  });
  it('limits payment purposes to deposit and difference', () => {
    expect(c.OrderPaymentSchema.parse({ expectedVersion: 1, purpose: 'DIFFERENCE' }).purpose).toBe('DIFFERENCE');
    expect(c.OrderPaymentSchema.safeParse({ expectedVersion: 1, purpose: 'FEE' }).success).toBe(false);
  });
  it('normalizes address whitespace and enforces field lengths', () => {
    const address = { expectedVersion: 1, recipientName: ' 张三 ', phone: ' 12345 ', region: ' 上海 ', detail: ' 测试街道123号 ' };
    expect(c.OrderAddressSchema.parse(address)).toMatchObject({ recipientName: '张三', phone: '12345', region: '上海', detail: '测试街道123号' });
    for (const [key, min, max] of [['recipientName', 1, 80], ['phone', 5, 32], ['region', 1, 200], ['detail', 4, 500]] as const) {
      expect(c.OrderAddressSchema.safeParse({ ...address, [key]: 'x'.repeat(min - 1) }).success).toBe(false);
      expect(c.OrderAddressSchema.safeParse({ ...address, [key]: 'x'.repeat(max + 1) }).success).toBe(false);
      expect(c.OrderAddressSchema.safeParse({ ...address, [key]: 'x'.repeat(max) }).success).toBe(true);
    }
    expect(c.OrderAddressSchema.safeParse({ ...address, side: 'RECIPIENT' }).success).toBe(false);
  });
  it('normalizes shipment identifiers and rejects item selection', () => {
    expect(c.OrderShipmentSchema.parse({ expectedVersion: 1, carrier: ' sf ', trackingNumber: ' ab123 ' })).toEqual({ expectedVersion: 1, carrier: 'SF', trackingNumber: 'AB123' });
    for (const key of ['itemIds', 'items', 'side', 'addressId']) {
      expect(c.OrderShipmentSchema.safeParse({ expectedVersion: 1, carrier: 'SF', trackingNumber: 'AB123', [key]: [] }).success).toBe(false);
    }
    for (const patch of [{ carrier: 'x' }, { carrier: 'x'.repeat(33) }, { trackingNumber: 'xx' }, { trackingNumber: 'x'.repeat(65) }]) {
      expect(c.OrderShipmentSchema.safeParse({ expectedVersion: 1, carrier: 'SF', trackingNumber: 'AB123', ...patch }).success).toBe(false);
    }
  });
  it('requires bounded normalized reasons', () => {
    for (const [schema, max] of [[c.OrderCancellationSchema, 300], [c.OrderIssueSchema, 1000]] as const) {
      expect(schema.parse({ expectedVersion: 1, reason: ' 测试原因 ' }).reason).toBe('测试原因');
      expect(schema.safeParse({ expectedVersion: 1, reason: 'abc' }).success).toBe(false);
      expect(schema.safeParse({ expectedVersion: 1, reason: 'x'.repeat(max + 1) }).success).toBe(false);
      expect(schema.safeParse({ expectedVersion: 1, reason: 'x'.repeat(max), side: 'INITIATOR' }).success).toBe(false);
    }
  });
  it('requires an explicit cancellation history ID on responses and withdrawals', () => {
    expect(c.OrderCancellationRespondSchema.parse({ expectedVersion: 1, cancellationId: id(7), decision: 'AGREE' })).toHaveProperty('cancellationId', id(7));
    expect(c.OrderCancellationWithdrawSchema.parse({ expectedVersion: 1, cancellationId: id(7) })).toHaveProperty('cancellationId', id(7));
    for (const schema of [c.OrderCancellationRespondSchema, c.OrderCancellationWithdrawSchema]) {
      expect(schema.safeParse({ expectedVersion: 1, decision: 'AGREE' }).success).toBe(false);
      expect(schema.safeParse({ expectedVersion: 1, cancellationId: 'bad' }).success).toBe(false);
    }
    expect(c.OrderCancellationRespondSchema.safeParse({ expectedVersion: 1, cancellationId: id(7), decision: 'WITHDRAW' }).success).toBe(false);
  });
  it('validates safe command results and paginated views', () => {
    expect(c.OrderCommandResultSchema.parse({ order: order(), paymentIntentId: id(6) }).order.id).toBe(id(1));
    expect(c.OrderListViewSchema.parse({ items: [order()], nextCursor: null }).items).toHaveLength(1);
    expect(c.OrderViewSchema.safeParse({ ...order(), phone: 'private' }).success).toBe(false);
    expect(c.OrderViewSchema.safeParse({ ...order(), parties: [{ ...party('INITIATOR', id(8)), address: 'private' }, party('RECIPIENT', id(9))] }).success).toBe(false);
    expect(c.OrderCommandResultSchema.safeParse({ order: order(), params: { token: 'private' } }).success).toBe(false);
  });
  it('rejects non-UTC timestamps and missing nullable progress times', () => {
    expect(c.OrderViewSchema.safeParse({ ...order(), paymentDeadline: '2026-10-02T08:00:00+08:00' }).success).toBe(false);
    expect(c.OrderViewSchema.safeParse({ ...order(), createdAt: 'yesterday' }).success).toBe(false);
    expect(c.OrderViewSchema.safeParse({ ...order(), parties: [{ ...party('INITIATOR', id(8)), acceptedAt: undefined }, party('RECIPIENT', id(9))] }).success).toBe(false);
  });
  it('keeps checkout and address details outside payment and shipment summaries', () => {
    const payment = { id: id(6), purpose: 'DEPOSIT', amountFen: 1000, currency: 'CNY', status: 'PENDING' };
    const shipment = { id: id(7), carrier: 'SF', trackingNumber: 'AB123', status: 'REGISTERED', registeredAt: time, collectedAt: null, deliveredAt: null };
    expect(c.OrderPaymentViewSchema.parse(payment).amountFen).toBe(1000);
    expect(c.OrderShipmentViewSchema.parse(shipment).status).toBe('REGISTERED');
    for (const amountFen of [0, -1, 1.5]) expect(c.OrderPaymentViewSchema.safeParse({ ...payment, amountFen }).success).toBe(false);
    expect(c.OrderPaymentViewSchema.safeParse({ ...payment, currency: 'USD' }).success).toBe(false);
    expect(c.OrderPaymentViewSchema.safeParse({ ...payment, params: { token: 'private' } }).success).toBe(false);
    expect(c.OrderShipmentViewSchema.safeParse({ ...shipment, phone: 'private' }).success).toBe(false);
    expect(c.OrderItemSnapshotSchema.safeParse({ ...item(4, 'INITIATOR'), wechatOpenid: 'private' }).success).toBe(false);
    expect(c.OrderPartyViewSchema.safeParse({ ...party('INITIATOR', id(8)), payments: [payment, payment] }).success).toBe(false);
    expect(c.CheckoutViewSchema.parse({ status: 'PENDING', paymentIntentId: id(6) })).not.toHaveProperty('params');
    expect(c.CheckoutViewSchema.safeParse({ status: 'PENDING', paymentIntentId: id(6), params: { token: 'private' } }).success).toBe(false);
    expect(c.CheckoutViewSchema.safeParse({ status: 'READY', paymentIntentId: id(6) }).success).toBe(false);
    expect(c.CheckoutViewSchema.parse({ status: 'READY', paymentIntentId: id(6), provider: 'simulated', params: { token: 'temporary' } }).status).toBe('READY');
    expect(c.OrderAddressViewSchema.parse({ orderId: id(1), side: 'INITIATOR', version: 1, recipientName: '张三', phone: '12345', region: '上海', detail: '测试街道' }).side).toBe('INITIATOR');
  });
  it('enforces full distinct snapshots, side counts and participant ownership', () => {
    expect(c.OrderViewSchema.safeParse({ ...order(), items: [1, 2, 3, 4, 5].map(n => item(n, 'INITIATOR')).concat(item(6, 'RECIPIENT')) }).success).toBe(true);
    for (const patch of [
      { items: [item(4, 'INITIATOR')] },
      { items: [item(4, 'INITIATOR'), item(5, 'RECIPIENT'), item(6, 'RECIPIENT')] },
      { items: [item(4, 'INITIATOR'), item(4, 'RECIPIENT')] },
      { items: [1, 2, 3, 4, 5, 6].map(n => item(n, 'INITIATOR')).concat(item(7, 'RECIPIENT')) },
      { items: [{ ...item(4, 'INITIATOR'), ownerId: id(9) }, item(5, 'RECIPIENT')] },
      { parties: [party('INITIATOR', id(8)), party('INITIATOR', id(9))] },
      { recipientId: id(8) },
    ]) expect(c.OrderViewSchema.safeParse({ ...order(), ...patch }).success).toBe(false);
  });
  it('preserves legacy proposals but requires an order link after conversion', () => {
    const snapshot = item(4, 'INITIATOR');
    const offeredItem = c.ProposalItemSnapshotSchema.parse(snapshot);
    const targetItem = c.ProposalItemSnapshotSchema.parse(item(5, 'RECIPIENT'));
    const proposal = { id: id(2), initiatorId: id(8), recipientId: id(9), responderId: id(9), status: 'CONFIRMED', version: 2, currentVersion: 1,
      expiresAt: time, confirmedAt: time, reservationExpiresAt: time, createdAt: time, updatedAt: time,
      versions: [{ id: id(3), number: 1, authorId: id(8), createdAt: time, offeredItems: [offeredItem], targetItem, ...order().terms }] };
    expect(c.ProposalViewSchema.safeParse(proposal).success).toBe(true);
    expect(c.ProposalViewSchema.safeParse({ ...proposal, status: 'CONVERTED' }).success).toBe(false);
    expect(c.ProposalViewSchema.safeParse({ ...proposal, status: 'CONVERTED', orderId: null }).success).toBe(false);
    expect(c.ProposalViewSchema.parse({ ...proposal, status: 'CONVERTED', orderId: id(1) }).orderId).toBe(id(1));
  });
});
