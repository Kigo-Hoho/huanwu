import { describe, expect, it } from 'vitest';
import { OrderViewSchema, type OrderView } from '@barter/contracts';
import { dueDeadline } from './order-policy.js';
import { testOrderRules } from './order-rules.js';
import { CLOCK, SystemClock, type Clock } from '../common/clock.js';
import { ClockModule } from '../common/clock.module.js';
import { Test } from '@nestjs/testing';

const deadline = '2026-10-03T00:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policyOrder = (status: OrderView['status']): OrderView => OrderViewSchema.parse({
  id: id(1), proposalId: id(2), proposalVersionId: id(3), initiatorId: id(8), recipientId: id(9), version: 1,
  rules: { version: 'phase3-test-v1', depositFen: 1000, feeFen: 0, detailsHours: 24, paymentHours: 24, fulfillmentHours: 72, inspectionHours: 72 },
  terms: { differenceFen: 0, payer: 'NONE', deliveryMode: 'COURIER', initiatorShippingFen: 0, recipientShippingFen: 0 },
  items: (['INITIATOR', 'RECIPIENT'] as const).map((side, i) => ({
    itemId: id(i + 4), ownerId: id(i + 8), itemVersion: 1, side,
    title: '通勤背包', description: '保存完好正常使用痕迹', referenceValueFen: 1000, condition: 'GOOD',
    imageUrls: ['https://img.test/1', 'https://img.test/2', 'https://img.test/3'], wantedText: '',
  })),
  status, detailsDeadline: deadline, paymentDeadline: deadline, fulfillmentDeadline: deadline,
  parties: (['INITIATOR', 'RECIPIENT'] as const).map((side, i) => ({
    side, userId: id(i + 8), addressReady: true, payments: [], outgoingShipment: null,
    incomingDeliveredAt: i === 0 ? deadline : null, acceptanceDeadline: i === 0 ? deadline : null, acceptedAt: null,
  })),
  cancellation: null, holdReason: null, simulation: true, createdAt: deadline, updatedAt: deadline,
});

describe('order deadline policy', () => {
  it('snapshots independent test rules with the approved durations', () => {
    const rules = testOrderRules();
    expect(rules).toEqual({ version: 'phase3-test-v1', depositFen: 1000, feeFen: 0, detailsHours: 24, paymentHours: 24, fulfillmentHours: 72, inspectionHours: 72 });
    rules.depositFen = 1;
    expect(testOrderRules().depositFen).toBe(1000);
  });
  it.each([
    ['AWAITING_DETAILS', 'DETAILS'], ['AWAITING_PAYMENT', 'PAYMENT'],
    ['AWAITING_FULFILLMENT', 'FULFILLMENT'], ['IN_TRANSIT', 'INSPECTION'], ['AWAITING_ACCEPTANCE', 'INSPECTION'],
  ] as const)('checks only %s deadlines at the exact boundary', (status, expected) => {
    expect(dueDeadline(policyOrder(status), new Date('2026-10-02T23:59:59.999Z'))).toBeNull();
    expect(dueDeadline(policyOrder(status), new Date(deadline))).toBe(expected);
  });
  it.each(['SETTLING', 'COMPLETED', 'CANCEL_PENDING', 'CANCELLED', 'ON_HOLD'] as const)('ignores expired historical deadlines in %s', status => {
    expect(dueDeadline(policyOrder(status), new Date('2030-01-01T00:00:00.000Z'))).toBeNull();
  });
  it('ignores old phase deadlines when the current deadline is absent or future', () => {
    const order = policyOrder('AWAITING_PAYMENT');
    expect(dueDeadline({ ...order, paymentDeadline: null }, new Date(deadline))).toBeNull();
    expect(dueDeadline({ ...order, paymentDeadline: '2026-10-04T00:00:00.000Z' }, new Date(deadline))).toBeNull();
  });
  it('checks the second party inspection and ignores accepted party deadlines', () => {
    const order = policyOrder('IN_TRANSIT');
    expect(dueDeadline({ ...order, parties: order.parties.map(p => ({ ...p, acceptedAt: deadline })) }, new Date(deadline))).toBeNull();
    expect(dueDeadline({ ...order, parties: [
      { ...order.parties[0]!, acceptedAt: deadline }, { ...order.parties[1]!, acceptanceDeadline: deadline },
    ] }, new Date(deadline))).toBe('INSPECTION');
  });
  it('provides the system clock by default and allows isolated injected clocks', async () => {
    const before = Date.now();
    expect(new SystemClock().now().getTime()).toBeGreaterThanOrEqual(before);
    const module = await Test.createTestingModule({ imports: [ClockModule] }).compile();
    expect(module.get<Clock>(CLOCK).now()).toBeInstanceOf(Date);
    await module.close();
    const fixed: Clock = { now: () => new Date(deadline) };
    const overridden = await Test.createTestingModule({ imports: [ClockModule] }).overrideProvider(CLOCK).useValue(fixed).compile();
    expect(overridden.get<Clock>(CLOCK).now().toISOString()).toBe(deadline);
    await overridden.close();
  });
});
