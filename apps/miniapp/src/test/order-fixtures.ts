import type { OrderView } from '@barter/contracts';
export const orderId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-10-07T00:00:00.000Z';
export function orderFixture(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: orderId(20), proposalId: orderId(5), proposalVersionId: orderId(6), initiatorId: orderId(10), recipientId: orderId(11),
    status: 'AWAITING_DETAILS', version: 1,
    rules: { version: 'phase3-test-v1', depositFen: 1000, feeFen: 0, detailsHours: 24, paymentHours: 24, fulfillmentHours: 72, inspectionHours: 72 },
    terms: { differenceFen: 500, payer: 'INITIATOR', deliveryMode: 'COURIER', initiatorShippingFen: 500, recipientShippingFen: 600 },
    items: ['INITIATOR', 'RECIPIENT'].map((side, i) => ({ side: side as 'INITIATOR' | 'RECIPIENT', itemId: orderId(i + 1), ownerId: orderId(i + 10), itemVersion: 1, title: i ? '户外背包' : '家用咖啡机', description: '保存完好，功能正常', referenceValueFen: 2000, condition: 'GOOD', imageUrls: [1, 2, 3].map(n => `https://images.example.test/${n}.jpg`), wantedText: '' })),
    parties: ['INITIATOR', 'RECIPIENT'].map((side, i) => ({ side: side as 'INITIATOR' | 'RECIPIENT', userId: orderId(i + 10), addressReady: false, payments: [], outgoingShipment: null, handedOverAt: null, incomingDeliveredAt: null, acceptanceDeadline: null, acceptedAt: null })),
    cancellation: null, holdReason: null, simulation: true, detailsDeadline: '2099-10-08T00:00:00.000Z', paymentDeadline: null, fulfillmentDeadline: null, createdAt: date, updatedAt: date,
    ...overrides,
  };
}
