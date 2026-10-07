import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { SimulatedPaymentAdapter } from '../../src/integrations/simulated-payment.adapter.js';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { PaymentEventsService } from '../../src/payments/payment-events.service.js';
import type { PaymentIntent } from '../../src/generated/prisma/client.js';
import { PaymentOutboxHandler } from '../../src/payments/payment-outbox.handler.js';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

let h: OrderHarness;
const signingKey = randomBytes(32); const environment = new Map<string, string | undefined>();
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'simulated', LOGISTICS_PROVIDER: 'disabled', SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: signingKey.toString('base64') })) {
    environment.set(key, process.env[key]); process.env[key] = value;
  }
  h = await createOrderHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.prisma.outboxCommand.updateMany({ where: { status: { in: ['PENDING', 'UNKNOWN', 'PROCESSING'] } }, data: { status: 'UNKNOWN', availableAt: new Date('2099-01-01'), leaseOwner: null, leaseExpiresAt: null } });
});
afterAll(async () => { await h?.close(); for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const driver = (id: string) => `/api/testing/payments/${id}/complete`;
async function pendingPair() {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  const first = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const second = await h.command(h.actors.recipient, `/api/orders/${order.id}/payments`, { expectedVersion: 2, purpose: 'DEPOSIT' }).expect(202);
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  await worker.tick(); await worker.tick();
  return { order, first: first.body.paymentIntentId as string, second: second.body.paymentIntentId as string, worker };
}
it('only advances to shared 72-hour fulfillment after both trusted deposits, never from pending provider creation', async () => {
  const { order, first, second } = await pendingPair();
  const before = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(before.status).toBe('AWAITING_PAYMENT');
  const paidFirst = await h.command(h.actors.initiator, driver(first), { expectedVersion: before.version }).expect(200);
  expect(paidFirst.body.order.status).toBe('AWAITING_PAYMENT');
  const paidSecond = await h.command(h.actors.recipient, driver(second), { expectedVersion: paidFirst.body.order.version }).expect(200);
  expect(paidSecond.body.order.status).toBe('AWAITING_FULFILLMENT');
  expect(paidSecond.body.order.fulfillmentDeadline).toBe('2026-10-06T00:00:00.000Z');
  expect(await h.prisma.financialEntry.count({ where: { intentId: { in: [first, second] }, entryType: 'PAYMENT' } })).toBe(2);
  expect((await h.prisma.orderPartyProgress.findMany({ where: { orderId: order.id } })).every(party => party.fundsReady)).toBe(true);
});
it('requires own pure customer, fixed server amount, current version and stable resource-bound driver key', async () => {
  const { order, first, second } = await pendingPair();
  const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  for (const actor of [h.actors.recipient, h.actors.outsider, h.actors.operator, h.actors.mixed]) {
    await h.command(actor, driver(first), { expectedVersion: version }).expect(actor === h.actors.outsider ? 404 : 403);
  }
  await h.command(h.actors.initiator, driver(first), { expectedVersion: version, amountFen: 1 }).expect(400);
  await h.command(h.actors.initiator, driver(first), { expectedVersion: 1 }).expect(409);
  const key = randomUUID(); const result = await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).expect(200);
  expect((await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).expect(200)).body).toEqual(result.body);
  await h.command(h.actors.initiator, driver(second), { expectedVersion: version }, key).expect(403);
  const another = await pendingPair();
  await h.command(h.actors.initiator, driver(another.first), { expectedVersion: version }, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
});
it('keeps external success after event audit insertion fails and same-key retry reconciles one ledger fact', async () => {
  const { order, first } = await pendingPair(); const key = randomUUID();
  const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  const audit = h.app.get(AuditService); const record = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, value) => {
    const row = await record(tx, value);
    if (value.action === 'ORDER_PAYMENT_CONFIRMED') throw new Error('Injected financial audit failure');
    return row;
  });
  await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).expect(500);
  const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(1);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first } })).toBe(0);
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_PAYMENT_CONFIRMED', entityId: first } })).toBe(0);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('AWAITING_PAYMENT');
  vi.restoreAllMocks();
  await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).expect(200);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
  expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(1);
});
it('authenticates bounded foreign-currency evidence without accepting an invalid signature', async () => {
  const event = { provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo: randomUUID(), occurredAt: h.clock.now().toISOString(), externalTransactionId: randomUUID(), amountFen: 1000, currency: 'USD' };
  const raw = JSON.stringify(event); const adapter = h.app.get(SimulatedPaymentAdapter);
  expect(() => adapter.verifySignedEvent(raw, '00'.repeat(32))).toThrow();
  expect(adapter.verifySignedEvent(raw, createHmac('sha256', signingKey).update(raw).digest('hex'))).toEqual(event);
});
function signed(intent: PaymentIntent, overrides: object = {}) {
  const raw = JSON.stringify({ provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo: intent.businessNo, occurredAt: h.clock.now().toISOString(), externalTransactionId: randomUUID(), amountFen: intent.amountFen, currency: 'CNY', ...overrides });
  return h.app.get(SimulatedPaymentAdapter).verifySignedEvent(raw, createHmac('sha256', signingKey).update(raw).digest('hex'));
}
it.each(['amount', 'oversizedAmount', 'currency', 'business', 'kind'] as const)('quarantines signed %s mismatches with immutable evidence, no ledger or funding', async mismatch => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  const changes = { amount: { amountFen: 999 }, oversizedAmount: { amountFen: Number.MAX_SAFE_INTEGER }, currency: { currency: 'USD' }, business: { businessNo: randomUUID() }, kind: { kind: 'REFUND_SUCCEEDED' } };
  const event = signed(intent, changes[mismatch]); await h.app.get(PaymentEventsService).applyVerified(event);
  const record = await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, include: { receipt: true } });
  expect(record.receipt?.status).toBe('REJECTED'); expect(record.payload).toEqual(event);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first } })).toBe(0);
  expect((await h.prisma.orderPartyProgress.findMany({ where: { orderId: order.id } })).some(party => party.fundsReady)).toBe(false);
  await expect(h.prisma.integrationEvent.update({ where: { id: record.id }, data: { currency: 'CNY' } })).rejects.toThrow();
});
it('deduplicates event identity and different event IDs reporting one transaction without extra versions', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  const event = signed(intent); const events = h.app.get(PaymentEventsService);
  await Promise.all([events.applyVerified(event), events.applyVerified(event)]);
  const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  await events.applyVerified({ ...event, eventId: randomUUID() });
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(version);
});
async function cancel(orderId: string) {
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const request = await h.command(h.actors.initiator, `/api/orders/${orderId}/cancellation`, { expectedVersion: current.version, reason: '双方同意取消并全额退还' }).expect(200);
  return (await h.command(h.actors.recipient, `/api/orders/${orderId}/cancellation/respond`, { expectedVersion: request.body.order.version, cancellationId: request.body.order.cancellation.id, decision: 'AGREE' }).expect(200)).body.order;
}
it('closes unpaid payment and refunds paid deposit once before safely releasing cancelled order', async () => {
  const { order, first, second, worker } = await pendingPair();
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }).expect(200);
  expect((await cancel(order.id)).status).toBe('CANCEL_PENDING');
  for (let i = 0; i < 5; i++) await worker.tick();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  expect((await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } })).status).toBe('REFUNDED');
  expect((await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: second } })).status).toBe('CLOSED');
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'REFUND' } })).toBe(1);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(0);
  expect(await h.app.get(SimulatedProviderStore).successCount(`refund:${first}`)).toBe(1);
});
it('records payment arriving in cancel-pending, queues original refund and never revives fulfillment', async () => {
  const { order, first, worker } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  await cancel(order.id);
  const event = signed(intent); await h.app.get(SimulatedProviderStore).recordEvent(event); await h.app.get(PaymentEventsService).applyVerified(event);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCEL_PENDING');
  expect(await h.prisma.outboxCommand.count({ where: { businessNo: `refund:${first}` } })).toBe(1);
  for (let i = 0; i < 6; i++) await worker.tick();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'REFUND' } })).toBe(1);
});
it('at the inclusive payment deadline records the fact and begins refund cancellation instead of fulfillment', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  const now = h.clock.now(); h.clock.set(order.paymentDeadline);
  try {
    await h.app.get(PaymentEventsService).applyVerified(signed(intent));
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCEL_PENDING');
    expect(await h.prisma.outboxCommand.count({ where: { businessNo: `refund:${first}` } })).toBe(1);
    expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  } finally { h.clock.set(now); }
});
it('preserves held order funds facts and occupancy without funding release or automatic refund', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD', holdPreviousStatus: 'AWAITING_PAYMENT', heldAt: h.clock.now() } });
  await h.app.get(PaymentEventsService).applyVerified(signed(intent));
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
  expect(await h.prisma.outboxCommand.count({ where: { businessNo: `refund:${first}` } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  const event = await h.prisma.integrationEvent.findFirstOrThrow({ where: { businessNo: intent.businessNo }, include: { receipt: true } });
  expect(event.receipt?.reason).toBe('ORDER_ON_HOLD');
});
it('safely closes a never-dispatched intent using audited absence proof without a fake provider event', async () => {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  const started = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  await cancel(order.id);
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry)); await worker.tick(); await worker.tick();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  expect(await h.prisma.financialEntry.count({ where: { intentId: started.body.paymentIntentId } })).toBe(0);
  expect(await h.prisma.integrationEvent.count({ where: { businessNo: `close:${started.body.paymentIntentId}` } })).toBe(0);
  expect(await h.prisma.auditLog.count({ where: { entityId: started.body.paymentIntentId, action: 'ORDER_PAYMENT_CLOSED_WITHOUT_EXTERNAL_INTENT' } })).toBe(1);
});
it('keeps an admitted but delayed create reconcilable when original query is NOT_FOUND', async () => {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  const started = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.body.paymentIntentId } });
  const operation = { orderId: order.id, businessNo: intent.businessNo, kind: 'CREATE_PAYMENT' as const, payload: { amountFen: 1000, currency: 'CNY' } };
  expect(await h.app.get(PaymentOutboxHandler).authorize(operation)).toBe(true);
  await cancel(order.id);
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry)); await worker.tick(); await worker.tick();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCEL_PENDING');
  const close = await h.prisma.outboxCommand.findUniqueOrThrow({ where: { businessNo: `close:${intent.id}` } });
  expect(['UNKNOWN', 'PENDING']).toContain(close.status);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  await h.app.get(SimulatedPaymentAdapter).createPayment(operation);
  h.clock.advance(30000); for (let i = 0; i < 4; i++) await worker.tick();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  expect(await h.prisma.outboxCommand.count({ where: { businessNo: `close:${intent.id}` } })).toBe(1);
});
it('retains contradictory success after confirmed closure as an anomaly without changing cancelled history or new occupancy', async () => {
  const { order, first, worker } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  await cancel(order.id); for (let i = 0; i < 4; i++) await worker.tick();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  const offer = await h.command(h.actors.initiator, '/api/proposals', { offeredItemIds: order.items.filter((item: { side: string }) => item.side === 'INITIATOR').map((item: { itemId: string }) => item.itemId), targetItemId: order.items.find((item: { side: string }) => item.side === 'RECIPIENT').itemId, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).expect(201);
  const newer = (await h.command(h.actors.recipient, `/api/proposals/${offer.body.id}/accept`, { expectedVersion: offer.body.version }).expect(200)).body;
  const reservation = await h.prisma.itemReservation.findFirstOrThrow({ where: { proposalId: newer.id } });
  const event = signed(intent); await h.app.get(PaymentEventsService).applyVerified(event);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  expect((await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } })).status).toBe('CLOSED');
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(0);
  expect(await h.prisma.itemReservation.findUniqueOrThrow({ where: { itemId: reservation.itemId } })).toEqual(reservation);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, include: { receipt: true } })).receipt).toMatchObject({ status: 'REJECTED', reason: 'PAYMENT_AFTER_CLOSED' });
});
it('reconciles refund after real audit failure without sending a second refund', async () => {
  const { order, first, worker } = await pendingPair();
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }).expect(200); await cancel(order.id);
  const audit = h.app.get(AuditService); const record = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, value) => { const saved = await record(tx, value); if (value.action === 'ORDER_REFUND_CONFIRMED') throw new Error('Injected refund audit failure'); return saved; });
  for (let i = 0; i < 4; i++) await worker.tick();
  expect(await h.app.get(SimulatedProviderStore).successCount(`refund:${first}`)).toBe(1);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'REFUND' } })).toBe(0);
  vi.restoreAllMocks(); let executions = 0; const adapter = h.app.get(SimulatedPaymentAdapter); const original = adapter.refundPayment.bind(adapter);
  vi.spyOn(adapter, 'refundPayment').mockImplementation(operation => { executions++; return original(operation); });
  h.clock.advance(30000); for (let i = 0; i < 4; i++) await worker.tick();
  expect(executions).toBe(0); expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'REFUND' } })).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
});
it('defers a trusted refund received before its original payment and replays the same immutable receipt afterward', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  await cancel(order.id);
  // An already-issued external refund may be delivered before the original local payment receipt.
  await h.prisma.outboxCommand.create({ data: { orderId: order.id, businessNo: `refund:${intent.id}`, kind: 'REFUND_PAYMENT', payload: { paymentBusinessNo: intent.businessNo, amountFen: 1000, currency: 'CNY' } } });
  const refund = signed(intent, { kind: 'REFUND_SUCCEEDED', businessNo: `refund:${intent.id}` }); const events = h.app.get(PaymentEventsService);
  await events.applyVerified(refund);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first } })).toBe(0);
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: refund.provider, eventId: refund.eventId } }, include: { receipt: true } })).receipt?.status).toBe('PENDING');
  await events.applyVerified(signed(intent));
  expect((await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } })).status).toBe('REFUNDED');
  expect(await h.prisma.financialEntry.count({ where: { intentId: first } })).toBe(2);
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: refund.provider, eventId: refund.eventId } }, include: { receipt: true } })).receipt?.status).toBe('PROCESSED');
});
it('starts the common fulfillment deadline at funding during cancellation negotiation without resetting it on rejection', async () => {
  const { order, first, second } = await pendingPair();
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const requested = await h.command(h.actors.initiator, `/api/orders/${order.id}/cancellation`, { expectedVersion: current.version, reason: '需要再讨论是否继续交换' }).expect(200);
  const paid = await h.command(h.actors.initiator, driver(first), { expectedVersion: requested.body.order.version }).expect(200);
  const funded = await h.command(h.actors.recipient, driver(second), { expectedVersion: paid.body.order.version }).expect(200);
  expect(funded.body.order).toMatchObject({ status: 'AWAITING_FULFILLMENT', fulfillmentDeadline: new Date(h.clock.now().getTime() + 72 * 3600000).toISOString(), paymentDeadline: null });
  h.clock.advance(3600000);
  const rejected = await h.command(h.actors.recipient, `/api/orders/${order.id}/cancellation/respond`, { expectedVersion: funded.body.order.version, cancellationId: requested.body.order.cancellation.id, decision: 'REJECT' }).expect(200);
  expect(rejected.body.order.fulfillmentDeadline).toBe(funded.body.order.fulfillmentDeadline);
});
it('requires the nonzero difference as well as both deposits before funding becomes ready', async () => {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON', differenceFen: 2700, payer: 'RECIPIENT' })).expect(201)).body.order;
  const first = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const second = await h.command(h.actors.recipient, `/api/orders/${order.id}/payments`, { expectedVersion: 2, purpose: 'DEPOSIT' }).expect(202);
  const third = await h.command(h.actors.recipient, `/api/orders/${order.id}/payments`, { expectedVersion: 3, purpose: 'DIFFERENCE' }).expect(202);
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry)); await worker.tick(); await worker.tick(); await worker.tick();
  let current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const paidFirst = await h.command(h.actors.initiator, driver(first.body.paymentIntentId), { expectedVersion: current.version }).expect(200);
  const paidSecond = await h.command(h.actors.recipient, driver(second.body.paymentIntentId), { expectedVersion: paidFirst.body.order.version }).expect(200);
  expect(paidSecond.body.order.status).toBe('AWAITING_PAYMENT');
  expect((await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } } })).fundsReady).toBe(false);
  const funded = await h.command(h.actors.recipient, driver(third.body.paymentIntentId), { expectedVersion: paidSecond.body.order.version }).expect(200);
  expect(funded.body.order.status).toBe('AWAITING_FULFILLMENT');
  current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(current.paymentDeadline).toBeNull();
  expect(await h.prisma.financialEntry.count({ where: { intentId: third.body.paymentIntentId, amountFen: 2700, entryType: 'PAYMENT' } })).toBe(1);
});
it('concurrent retries complete the same external fact and cache one immutable successful response', async () => {
  const { order, first } = await pendingPair(); const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  let entered!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const release = new Promise<void>(resolve => { resume = resolve; });
  const store = h.app.get(SimulatedProviderStore); const record = store.recordEvent.bind(store);
  vi.spyOn(store, 'recordEvent').mockImplementationOnce(async event => { entered(); await release; await record(event); });
  const key = randomUUID(); const firstRequest = h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).then(response => response);
  await waiting;
  let second;
  try { second = await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).expect(200); }
  finally { resume(); }
  const original = await firstRequest; expect(original.status).toBe(200); expect(original.body).toEqual(second!.body);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'SIMULATED_PAYMENT_COMPLETION_ADMITTED' } })).toBe(1);
});
it('serializes a shared external transaction across different orders and quarantines the second association', async () => {
  const a = await pendingPair(); const b = await pendingPair();
  const first = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: a.first } }); const second = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: b.first } });
  const externalTransactionId = randomUUID(); const events = h.app.get(PaymentEventsService);
  await Promise.all([events.applyVerified(signed(first, { externalTransactionId })), events.applyVerified(signed(second, { externalTransactionId }))]);
  expect(await h.prisma.financialEntry.count({ where: { externalTransactionId, entryType: 'PAYMENT' } })).toBe(1);
  expect(await h.prisma.integrationEventReceipt.count({ where: { reason: 'TRANSACTION_CONFLICT', event: { externalTransactionId } } })).toBe(1);
});
it('rechecks payment expiry after waiting for a financial row lock', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect(); const before = h.clock.now();
  let applied: Promise<void> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM "PaymentIntent" WHERE id = $1::uuid FOR UPDATE', [first]);
    const identity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    applied = h.app.get(PaymentEventsService).applyVerified(signed(intent));
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await h.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${identity.rows[0].pid} = ANY(pg_blocking_pids(pid))`;
      if (rows[0].waiting > 0) { blocked = true; break; } await delay(10);
    }
    expect(blocked).toBe(true); h.clock.set(order.paymentDeadline); await blocker.query('COMMIT'); await applied;
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCEL_PENDING');
    expect(await h.prisma.outboxCommand.count({ where: { businessNo: `refund:${first}` } })).toBe(1);
  } finally { await blocker.query('ROLLBACK'); await applied; await blocker.end(); h.clock.set(before); }
});
it('holds contradictory successful closure after a paid fact instead of automatically releasing the order', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  await cancel(order.id); const events = h.app.get(PaymentEventsService);
  await events.applyVerified(signed(intent));
  const closed = signed(intent, { kind: 'PAYMENT_CLOSED', businessNo: `close:${first}` }); await events.applyVerified(closed);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: closed.provider, eventId: closed.eventId } }, include: { receipt: true } })).receipt?.reason).toBe('CLOSE_CONTRADICTS_PAYMENT');
});
it('refuses a worker result for another valid payment instead of marking either obligation funded', async () => {
  const a = await pendingPair(); const b = await pendingPair();
  const first = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: a.first } }); const second = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: b.first } });
  const event = signed(second); if (event.kind === 'SHIPMENT_PROGRESS') throw new Error('Expected financial fixture');
  await expect(h.app.get(PaymentOutboxHandler).apply({ orderId: a.order.id, businessNo: first.businessNo, kind: 'CREATE_PAYMENT', payload: { amountFen: 1000, currency: 'CNY' } }, { status: 'SUCCESS', event, externalTransactionId: event.externalTransactionId })).rejects.toThrow();
  expect(await h.prisma.financialEntry.count({ where: { intentId: { in: [first.id, second.id] } } })).toBe(0);
});
it('rolls back local no-op closure when its real audit fails and retries the same durable close command', async () => {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  const started = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  await cancel(order.id); const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  const audit = h.app.get(AuditService); const record = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, value) => { const row = await record(tx, value); if (value.action === 'ORDER_PAYMENT_CLOSED_WITHOUT_EXTERNAL_INTENT') throw new Error('Injected local close audit failure'); return row; });
  await worker.tick(); await worker.tick();
  expect((await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.body.paymentIntentId } })).status).toBe('CREATED');
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_PAYMENT_CLOSED_WITHOUT_EXTERNAL_INTENT', entityId: started.body.paymentIntentId } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCEL_PENDING');
  vi.restoreAllMocks(); h.clock.advance(30000); for (let i = 0; i < 4; i++) await worker.tick();
  const saved = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(saved.status).toBe('CANCELLED'); expect(saved.version).toBeGreaterThan(version);
  expect(await h.prisma.outboxCommand.count({ where: { businessNo: `close:${started.body.paymentIntentId}` } })).toBe(1);
});
it('rechecks persisted customer authorization before replaying a successful simulated completion', async () => {
  const { order, first } = await pendingPair(); const key = randomUUID();
  const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, '').expect(400);
  await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).expect(200);
  await h.prisma.userRole.create({ data: { userId: h.actors.initiator.id, role: 'OPERATIONS' } });
  try { await h.command(h.actors.initiator, driver(first), { expectedVersion: version }, key).expect(403); }
  finally { await h.prisma.userRole.deleteMany({ where: { userId: h.actors.initiator.id, role: 'OPERATIONS' } }); }
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
});
it.each(['ON_HOLD', 'CANCEL_PENDING', 'EXPIRED'] as const)('does not create a fresh payment on an admitted pre-effect retry after %s', async restriction => {
  const { order, first } = await pendingPair(); const key = randomUUID();
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  vi.spyOn(h.app.get(SimulatedPaymentAdapter), 'queryPayment').mockRejectedValueOnce(new Error('Injected query failure before external completion'));
  await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }, key).expect(500);
  expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(0);
  expect((await h.prisma.idempotencyRecord.findFirstOrThrow({ where: { key } })).response).toMatchObject({ status: 'IN_PROGRESS' });
  const now = h.clock.now();
  if (restriction === 'CANCEL_PENDING') await cancel(order.id);
  else if (restriction === 'ON_HOLD') await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD', holdPreviousStatus: 'AWAITING_PAYMENT', heldAt: now } });
  else h.clock.set(order.paymentDeadline);
  try {
    await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }, key).expect(409);
    expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(0);
    expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(0);
    expect(await h.prisma.integrationEvent.count({ where: { businessNo: intent.businessNo, kind: 'PAYMENT_SUCCEEDED' } })).toBe(0);
  } finally { h.clock.set(now); }
});
it.each(['ON_HOLD', 'CANCEL_PENDING'] as const)('preserves a genuinely in-flight completion that was dispatched before %s', async restriction => {
  const { order, first } = await pendingPair(); const key = randomUUID();
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const store = h.app.get(SimulatedProviderStore); const record = store.recordEvent.bind(store);
  let entered!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const release = new Promise<void>(resolve => { resume = resolve; });
  vi.spyOn(store, 'recordEvent').mockImplementationOnce(async event => { entered(); await release; await record(event); });
  const completion = h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }, key).then(response => response);
  await waiting;
  try {
    if (restriction === 'CANCEL_PENDING') await cancel(order.id);
    else await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD', holdPreviousStatus: 'AWAITING_PAYMENT', heldAt: h.clock.now() } });
  } finally { resume(); }
  const result = await completion; expect(result.status).toBe(200); expect(result.body.order.status).toBe(restriction);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
  expect((await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }, key).expect(200)).body).toEqual(result.body);
});
it.each(['ON_HOLD', 'CANCEL_PENDING'] as const)('reconciles already-saved success after local event audit rollback and later %s', async restriction => {
  const { order, first } = await pendingPair(); const key = randomUUID(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const audit = h.app.get(AuditService); const record = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, value) => { const row = await record(tx, value); if (value.action === 'ORDER_PAYMENT_CONFIRMED') throw new Error('Injected post-effect event audit failure'); return row; });
  await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }, key).expect(500);
  expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(1);
  vi.restoreAllMocks();
  if (restriction === 'CANCEL_PENDING') await cancel(order.id);
  else await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD', holdPreviousStatus: 'AWAITING_PAYMENT', heldAt: h.clock.now() } });
  let completions = 0; const store = h.app.get(SimulatedProviderStore); const save = store.recordEvent.bind(store);
  vi.spyOn(store, 'recordEvent').mockImplementation(event => { completions++; return save(event); });
  const result = await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }, key).expect(200);
  expect(result.body.order.status).toBe(restriction); expect(completions).toBe(0);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
});
it.each(['ON_HOLD', 'EXPIRED', 'ROLE_REVOKED'] as const)('rechecks %s after the pending external query before dispatch', async restriction => {
  const { order, first } = await pendingPair(); const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const adapter = h.app.get(SimulatedPaymentAdapter); const query = adapter.queryPayment.bind(adapter); const now = h.clock.now();
  vi.spyOn(adapter, 'queryPayment').mockImplementationOnce(async businessNo => {
    const pending = await query(businessNo);
    if (restriction === 'ON_HOLD') await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD', holdPreviousStatus: 'AWAITING_PAYMENT', heldAt: now } });
    else if (restriction === 'EXPIRED') h.clock.set(order.paymentDeadline);
    else await h.prisma.userRole.create({ data: { userId: h.actors.initiator.id, role: 'OPERATIONS' } });
    return pending;
  });
  try {
    await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }).expect(restriction === 'ROLE_REVOKED' ? 403 : 409);
    const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
    expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(0);
    expect(await h.prisma.financialEntry.count({ where: { intentId: first } })).toBe(0);
  } finally { h.clock.set(now); await h.prisma.userRole.deleteMany({ where: { userId: h.actors.initiator.id, role: 'OPERATIONS' } }); }
});
it('reconciles success saved during a stale pending query even when fresh dispatch is now held', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const adapter = h.app.get(SimulatedPaymentAdapter); const query = adapter.queryPayment.bind(adapter);
  vi.spyOn(adapter, 'queryPayment').mockImplementationOnce(async businessNo => {
    const pending = await query(businessNo);
    await h.app.get(SimulatedProviderStore).recordEvent(signed(intent));
    await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD', holdPreviousStatus: 'AWAITING_PAYMENT', heldAt: h.clock.now() } });
    return pending;
  });
  const result = await h.command(h.actors.initiator, driver(first), { expectedVersion: current.version }).expect(200);
  expect(result.body.order.status).toBe('ON_HOLD');
  expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(1);
  expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(1);
});
it('samples the fresh completion deadline after waiting for the intent lock', async () => {
  const { order, first } = await pendingPair(); const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: first } });
  const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect(); const before = h.clock.now();
  let response: Promise<{ status: number; body: { code: string } }> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM "PaymentIntent" WHERE id = $1::uuid FOR UPDATE', [first]);
    const identity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    response = h.command(h.actors.initiator, driver(first), { expectedVersion: version }).then(result => result);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await h.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${identity.rows[0].pid} = ANY(pg_blocking_pids(pid))`;
      if (rows[0].waiting > 0) { blocked = true; break; } await delay(10);
    }
    expect(blocked).toBe(true); h.clock.set(order.paymentDeadline); await blocker.query('COMMIT');
    expect((await response).status).toBe(409);
    expect(await h.app.get(SimulatedProviderStore).successCount(intent.businessNo)).toBe(0);
    expect(await h.prisma.financialEntry.count({ where: { intentId: first, entryType: 'PAYMENT' } })).toBe(0);
  } finally { await blocker.query('ROLLBACK'); await response; await blocker.end(); h.clock.set(before); }
});
