import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { PaymentEventsService } from '../../src/payments/payment-events.service.js';
import { SimulatedPaymentAdapter } from '../../src/integrations/simulated-payment.adapter.js';

let h: OrderHarness;
const environment = new Map<string, string | undefined>();
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'simulated', LOGISTICS_PROVIDER: 'simulated', SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: randomBytes(32).toString('base64'), ADDRESS_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), ADDRESS_ENCRYPTION_KEY_VERSION: 'fulfillment-test' })) { environment.set(key, process.env[key]); process.env[key] = value; }
  h = await createOrderHarness();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await h?.close(); for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
async function order(mode: 'COURIER' | 'IN_PERSON' = 'COURIER', funded = true) {
  const created = (await h.convert(await h.confirmedProposal({ mode, offeredCount: 3 })).expect(201)).body.order;
  if (mode === 'COURIER') for (const actor of [h.actors.initiator, h.actors.recipient]) {
    const current = (await h.get(actor, `/api/orders/${created.id}`).expect(200)).body;
    await h.command(actor, `/api/orders/${created.id}/address`, { expectedVersion: current.version, recipientName: '测试收件', phone: '13800000000', region: '测试地区', detail: '测试详细收货地址' }).expect(200);
  }
  if (funded) for (const actor of [h.actors.initiator, h.actors.recipient]) {
    const current = (await h.get(actor, `/api/orders/${created.id}`).expect(200)).body;
    const start = await h.command(actor, `/api/orders/${created.id}/payments`, { expectedVersion: current.version, purpose: 'DEPOSIT' }).expect(202);
    const intent = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: start.body.paymentIntentId } });
    const raw = JSON.stringify({ provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo: intent.businessNo, occurredAt: h.clock.now().toISOString(), externalTransactionId: randomUUID(), amountFen: 1000, currency: 'CNY' });
    await h.app.get(PaymentEventsService).applyVerified(h.app.get(SimulatedPaymentAdapter).verifySignedEvent(raw, createHmac('sha256', Buffer.from(process.env.SIMULATED_INTEGRATION_SIGNING_KEY_BASE64!, 'base64')).update(raw).digest('hex')));
  }
  return (await h.get(h.actors.initiator, `/api/orders/${created.id}`).expect(200)).body;
}
const path = (id: string) => `/api/orders/${id}/shipments`;
const input = (version: number, trackingNumber: string = randomUUID()) => ({ expectedVersion: version, carrier: ' sf ', trackingNumber });
it('registers the complete own side with frozen address references without claiming pickup', async () => {
  const created = await order(); const submitted = await h.command(h.actors.initiator, path(created.id), input(created.version)).expect(200);
  expect(submitted.body.order.status).toBe('AWAITING_FULFILLMENT');
  expect(submitted.body.order.parties.find((p: { side: string }) => p.side === 'INITIATOR').outgoingShipment.status).toBe('REGISTERED');
  const outbox = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: created.id, kind: 'VERIFY_SHIPMENT' } });
  expect(Object.keys(outbox.payload as object).sort()).toEqual(['carrier', 'shipmentId', 'trackingNumber']);
  const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { entityId: created.id, action: 'ORDER_SHIPMENT_SUBMITTED' } });
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: created.id, side: 'INITIATOR' } });
  const address = await h.prisma.orderAddress.findUniqueOrThrow({ where: { orderId_side: { orderId: created.id, side: 'RECIPIENT' } } });
  expect((audit.after as { metadata: object }).metadata).toEqual({ shipmentId: (outbox.payload as { shipmentId: string }).shipmentId, side: 'INITIATOR', snapshotIds: snapshots.map(s => s.id).sort(), addressId: address.id, addressVersion: address.version });
  expect(JSON.stringify(audit)).not.toContain('13800000000');
  expect(await h.prisma.shipment.count({ where: { orderId: created.id } })).toBe(1);
  await h.command(h.actors.recipient, `/api/orders/${created.id}/cancellation`, { expectedVersion: submitted.body.order.version, reason: '请求取消交换' }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_FULFILLMENT_STARTED'));
});
it('blocks missing funds, pending cancellation, wrong mode and unauthorized identities', async () => {
  const unpaid = await order('COURIER', false); await h.command(h.actors.initiator, path(unpaid.id), input(unpaid.version)).expect(409);
  const pending = await order(); const requested = await h.command(h.actors.recipient, `/api/orders/${pending.id}/cancellation`, { expectedVersion: pending.version, reason: '请求取消交换' }).expect(200);
  await h.command(h.actors.initiator, path(pending.id), input(requested.body.order.version)).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_CANCELLATION_PENDING'));
  const inPerson = await order('IN_PERSON'); await h.command(h.actors.initiator, path(inPerson.id), input(inPerson.version)).expect(409);
  for (const actor of [h.actors.outsider, h.actors.operator, h.actors.mixed]) await h.command(actor, path(pending.id), input(requested.body.order.version)).expect(actor === h.actors.outsider ? 404 : 403);
});
it('normalizes and rejects cross-task duplicate tracking and partial/client-selected bindings', async () => {
  const first = await order(); const second = await order(); const tracking = randomUUID();
  await h.command(h.actors.initiator, path(first.id), input(first.version, tracking.toLowerCase())).expect(200);
  await h.command(h.actors.initiator, path(second.id), input(second.version, tracking.toUpperCase())).expect(409).expect(({ body }) => expect(body.code).toBe('TRACKING_NUMBER_IN_USE'));
  for (const extra of [{ itemIds: [first.items[0].itemId] }, { side: 'RECIPIENT' }, { addressId: randomUUID() }]) await h.command(h.actors.recipient, path(first.id), { ...input(first.version + 1), ...extra }).expect(400);
});
it('rolls back registration/outbox/cache/revision after an inserted audit fails', async () => {
  const created = await order(); const key = randomUUID(); const count = await h.prisma.auditLog.count(); h.faultAuditOnce(true);
  await h.command(h.actors.initiator, path(created.id), input(created.version), key).expect(500);
  expect(await h.prisma.shipment.count({ where: { orderId: created.id } })).toBe(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id, kind: 'VERIFY_SHIPMENT' } })).toBe(0);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0); expect(await h.prisma.auditLog.count()).toBe(count);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).version).toBe(created.version);
});
it('same-key concurrent registration replays once and binds the full order resource', async () => {
  const created = await order(); const another = await order(); const key = randomUUID(); const body = input(created.version);
  const results = await Promise.all([h.command(h.actors.initiator, path(created.id), body, key), h.command(h.actors.initiator, path(created.id), body, key)]);
  expect(results.map(result => result.status)).toEqual([200, 200]); expect(results[0]!.body).toEqual(results[1]!.body);
  await h.command(h.actors.initiator, path(another.id), body, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  expect(await h.prisma.auditLog.count({ where: { entityId: created.id, action: 'ORDER_SHIPMENT_SUBMITTED' } })).toBe(1);
});
it('records independent in-person handovers and starts both incoming deadlines only after both', async () => {
  const created = await order('IN_PERSON');
  const first = await h.command(h.actors.initiator, `/api/orders/${created.id}/handover`, { expectedVersion: created.version }).expect(200);
  expect(first.body.order.status).toBe('AWAITING_FULFILLMENT'); expect(first.body.order.parties.every((p: { incomingDeliveredAt: string | null }) => p.incomingDeliveredAt === null)).toBe(true);
  await h.command(h.actors.recipient, `/api/orders/${created.id}/cancellation`, { expectedVersion: first.body.order.version, reason: '请求取消交换' }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_FULFILLMENT_STARTED'));
  h.clock.advance(1000);
  const second = await h.command(h.actors.recipient, `/api/orders/${created.id}/handover`, { expectedVersion: first.body.order.version }).expect(200);
  expect(second.body.order.status).toBe('AWAITING_ACCEPTANCE');
  for (const p of second.body.order.parties) { expect(p.incomingDeliveredAt).toBe(h.clock.now().toISOString()); expect(Date.parse(p.acceptanceDeadline) - Date.parse(p.incomingDeliveredAt)).toBe(72 * 3600000); }
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id, kind: { in: ['VERIFY_SHIPMENT', 'QUERY_SHIPMENT'] } } })).toBe(0);
});
it('rejects handover for courier, pending cancellation, deadline boundary and client side', async () => {
  const courier = await order(); await h.command(h.actors.initiator, `/api/orders/${courier.id}/handover`, { expectedVersion: courier.version }).expect(409);
  const created = await order('IN_PERSON'); await h.command(h.actors.initiator, `/api/orders/${created.id}/handover`, { expectedVersion: created.version, side: 'RECIPIENT' }).expect(400);
  h.clock.set(created.fulfillmentDeadline); await h.command(h.actors.initiator, `/api/orders/${created.id}/handover`, { expectedVersion: created.version }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_EXPIRED'));
});
it('blocks pending in-person cancellation and atomically rolls back its own handover after an inserted audit failure', async () => {
  const created = await order('IN_PERSON');
  const requested = await h.command(h.actors.recipient, `/api/orders/${created.id}/cancellation`, { expectedVersion: created.version, reason: '请求取消交换' }).expect(200);
  await h.command(h.actors.initiator, `/api/orders/${created.id}/handover`, { expectedVersion: requested.body.order.version }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_CANCELLATION_PENDING'));
  const withdrawn = await h.command(h.actors.recipient, `/api/orders/${created.id}/cancellation/withdraw`, { expectedVersion: requested.body.order.version, cancellationId: requested.body.order.cancellation.id }).expect(200);
  const key = randomUUID(); h.faultAuditOnce(true);
  await h.command(h.actors.initiator, `/api/orders/${created.id}/handover`, { expectedVersion: withdrawn.body.order.version }, key).expect(500);
  expect((await h.prisma.orderPartyProgress.findMany({ where: { orderId: created.id } })).every(p => p.handedOverAt === null)).toBe(true);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).version).toBe(withdrawn.body.order.version);
  const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_CANCELLATION_WITHDRAWN', entityId: created.id } });
  expect(audit.after).toEqual(withdrawn.body.order);
});
