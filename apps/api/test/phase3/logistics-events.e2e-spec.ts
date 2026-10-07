import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { LogisticsEventsService } from '../../src/logistics/logistics-events.service.js';
import { SimulatedLogisticsAdapter } from '../../src/integrations/simulated-logistics.adapter.js';
import type { Shipment } from '../../src/generated/prisma/client.js';
import type { VerifiedIntegrationEvent } from '../../src/integrations/integration.types.js';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import { LogisticsOutboxHandler } from '../../src/logistics/logistics-outbox.handler.js';
import { AppModule } from '../../src/app.module.js';
import { Test } from '@nestjs/testing';
import { LocalImageStorageAdapter } from '../../src/storage/local-image-storage.adapter.js';
import { ProposalExpiryScheduler } from '../../src/proposals/proposal-expiry.scheduler.js';
import { OrderExpiryScheduler } from '../../src/orders/order-expiry.scheduler.js';
import { configureApp } from '../../src/main.js';
import request from 'supertest';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
let h: OrderHarness;
const environment = new Map<string, string | undefined>();
beforeAll(async () => { for (const [key, value] of Object.entries({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'disabled', LOGISTICS_PROVIDER: 'simulated', SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: randomBytes(32).toString('base64') })) { environment.set(key, process.env[key]); process.env[key] = value; } h = await createOrderHarness(); });
afterAll(async () => { await h?.close(); for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
afterEach(() => vi.restoreAllMocks());
async function registered() {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  // Fixture establishes already-confirmed funding, not the behavior under test.
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'AWAITING_FULFILLMENT', detailsDeadline: null, fulfillmentDeadline: new Date(h.clock.now().getTime() + 72 * 3600000) } });
  await h.prisma.orderPartyProgress.updateMany({ where: { orderId: order.id }, data: { fundsReady: true } });
  const shipments: Shipment[] = [];
  for (const side of ['INITIATOR', 'RECIPIENT'] as const) { const id = randomUUID(); shipments.push(await h.prisma.shipment.create({ data: { id, orderId: order.id, side, carrier: 'SF', trackingNumber: randomUUID(), businessNo: `shipment:${id}`, registeredAt: h.clock.now() } })); }
  return { order, shipments, first: shipments[0]!, second: shipments[1]! };
}
function verified(shipment: Shipment, progress: Shipment['status'], changes: object = {}): VerifiedIntegrationEvent {
  const raw = JSON.stringify({ provider: 'simulated', eventId: randomUUID(), kind: 'SHIPMENT_PROGRESS', businessNo: shipment.businessNo, shipmentId: shipment.id, progress, occurredAt: h.clock.now().toISOString(), ...changes });
  return h.app.get(SimulatedLogisticsAdapter).verifySignedEvent(raw, createHmac('sha256', Buffer.from(process.env.SIMULATED_INTEGRATION_SIGNING_KEY_BASE64!, 'base64')).update(raw).digest('hex'));
}
const apply = (event: VerifiedIntegrationEvent) => h.app.get(LogisticsEventsService).applyVerified(event);
it('requires both trusted collections, creates a separate incoming deadline and uses server acceptance time', async () => {
  const { order, first, second } = await registered();
  await apply(verified(first, 'REGISTERED')); expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('AWAITING_FULFILLMENT');
  await apply(verified(first, 'COLLECTED')); expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('AWAITING_FULFILLMENT');
  await apply(verified(second, 'COLLECTED')); expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('IN_TRANSIT');
  h.clock.advance(1000); const accepted = h.clock.now(); await apply(verified(first, 'DELIVERED', { occurredAt: '2099-01-01T00:00:00.000Z' }));
  const parties = await h.prisma.orderPartyProgress.findMany({ where: { orderId: order.id } });
  expect(parties.find(p => p.side === 'RECIPIENT')).toMatchObject({ incomingDeliveredAt: accepted, acceptanceDeadline: new Date(accepted.getTime() + 72 * 3600000) });
  expect(parties.find(p => p.side === 'INITIATOR')!.acceptanceDeadline).toBeNull();
  h.clock.advance(2000); await apply(verified(second, 'DELIVERED'));
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('AWAITING_ACCEPTANCE');
  expect((await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } } })).incomingDeliveredAt).toEqual(h.clock.now());
});
it('keeps immutable out-of-order history without regressing progress or adding progress audits on replay', async () => {
  const { order, first } = await registered(); const delivered = verified(first, 'DELIVERED'); await apply(delivered);
  const version = (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  const count = await h.prisma.auditLog.count({ where: { action: 'ORDER_SHIPMENT_PROGRESS_CONFIRMED', entityId: order.id } });
  await apply(delivered); await apply(verified(first, 'COLLECTED')); await apply(verified(first, 'DELIVERED'));
  expect((await h.prisma.shipment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('DELIVERED');
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(version);
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_SHIPMENT_PROGRESS_CONFIRMED', entityId: order.id } })).toBe(count);
  expect(await h.prisma.shipmentEvent.count({ where: { shipmentId: first.id } })).toBe(3);
});
it('holds at inclusive fulfillment expiry before applying late facts and retains every reservation', async () => {
  const { order, first } = await registered(); const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } }); h.clock.set(current.fulfillmentDeadline!);
  await apply(verified(first, 'COLLECTED'));
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'ON_HOLD', holdReason: 'FULFILLMENT_TIMEOUT', holdPreviousStatus: 'AWAITING_FULFILLMENT', heldAt: h.clock.now(), version: 2 });
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_HELD', entityId: order.id } })).toBe(1);
});
it('makes exceptions sticky while preserving later delivery evidence without reviving order', async () => {
  const { order, first } = await registered(); await apply(verified(first, 'EXCEPTION')); await apply(verified(first, 'DELIVERED'));
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
  expect((await h.prisma.shipment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('EXCEPTION');
  expect(await h.prisma.shipmentEvent.count({ where: { shipmentId: first.id } })).toBe(2);
});
it('quarantines unknown/mismatched association, rejects conflicting identity and rolls back inserted evidence on audit failure', async () => {
  const { order, first, second } = await registered(); const mismatch = verified(first, 'COLLECTED', { shipmentId: second.id }); await apply(mismatch);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(1);
  const receipt = await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: mismatch.provider, eventId: mismatch.eventId } }, include: { receipt: true } }); expect(receipt.receipt!.status).toBe('REJECTED');
  await expect(apply({ ...mismatch, occurredAt: '2026-01-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 400 });
  const event = verified(first, 'COLLECTED'); h.faultAuditOnce(true); await expect(apply(event)).rejects.toThrow('Injected audit failure');
  expect(await h.prisma.integrationEvent.count({ where: { eventId: event.eventId } })).toBe(0); expect((await h.prisma.shipment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('REGISTERED');
  await apply(event); expect((await h.prisma.shipment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('COLLECTED');
});
it('registers only the selected logistics driver, with authentication before own-side progression', async () => {
  await h.command(h.actors.initiator, `/api/testing/shipments/${randomUUID()}/progress`, { expectedVersion: 1, progress: 'COLLECTED' }).expect(404).expect(({ body }) => expect(body.code).toBe('ORDER_NOT_FOUND'));
  const response = await h.command(h.actors.initiator, `/api/testing/payments/${randomUUID()}/complete`, { expectedVersion: 1 });
  expect(response.status).toBe(404);
});
const driver = (id: string) => `/api/testing/shipments/${id}/progress`;
const operation = (s: Shipment) => ({ orderId: s.orderId, businessNo: s.businessNo, kind: 'VERIFY_SHIPMENT' as const, payload: { shipmentId: s.id, carrier: s.carrier, trackingNumber: s.trackingNumber } });
async function pending() { const result = await registered(); await h.app.get(SimulatedProviderStore).execute(operation(result.first)); return result; }
it('restricts driver to own side/version and ordered progress, deduplicates same-key concurrency and binds progress/resource', async () => {
  const { order, first, second } = await pending(); const key = randomUUID(); const input = { expectedVersion: 1, progress: 'COLLECTED' };
  for (const actor of [h.actors.recipient, h.actors.outsider, h.actors.operator, h.actors.mixed]) await h.command(actor, driver(first.id), input).expect(actor === h.actors.outsider ? 404 : 403);
  await h.command(h.actors.initiator, driver(first.id), { ...input, progress: 'DELIVERED' }).expect(409);
  await h.command(h.actors.initiator, driver(first.id), { ...input, expectedVersion: 999 }).expect(409);
  await h.command(h.actors.initiator, driver(first.id), { ...input, businessNo: first.businessNo }).expect(400);
  const results = await Promise.all([h.command(h.actors.initiator, driver(first.id), input, key), h.command(h.actors.initiator, driver(first.id), input, key)]);
  expect(results.map(r => r.status)).toEqual([200, 200]); expect(results[0]!.body).toEqual(results[1]!.body);
  expect(await h.prisma.auditLog.count({ where: { action: 'SIMULATED_SHIPMENT_PROGRESS_ADMITTED', entityId: order.id } })).toBe(1);
  expect(await h.prisma.shipmentEvent.count({ where: { shipmentId: first.id } })).toBe(1);
  await h.command(h.actors.initiator, driver(first.id), { ...input, progress: 'EXCEPTION' }, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  await h.command(h.actors.initiator, driver(second.id), input, key).expect(403);
  const another = await pending(); await h.command(h.actors.initiator, driver(another.first.id), input, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  const current = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const delivered = await h.command(h.actors.initiator, driver(first.id), { expectedVersion: current.version, progress: 'DELIVERED' }).expect(200);
  expect(delivered.body.order.parties.find((p: { side: string }) => p.side === 'RECIPIENT').incomingDeliveredAt).toBe(h.clock.now().toISOString());
});
it.each(['hold', 'expiry', 'cancel'] as const)('does not mint progress after pre-effect query failure and %s on original-key retry', async change => {
  const { order, first } = await pending(); const key = randomUUID(); const before = h.clock.now();
  const adapter = h.app.get(SimulatedLogisticsAdapter); vi.spyOn(adapter, 'queryShipment').mockRejectedValueOnce(new Error('Injected pre-effect query failure'));
  await h.command(h.actors.initiator, driver(first.id), { expectedVersion: 1, progress: 'COLLECTED' }, key).expect(500);
  if (change === 'expiry') h.clock.set((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillmentDeadline!);
  else await h.prisma.order.update({ where: { id: order.id }, data: { status: change === 'hold' ? 'ON_HOLD' : 'CANCEL_PENDING' } });
  try {
    await h.command(h.actors.initiator, driver(first.id), { expectedVersion: 1, progress: 'COLLECTED' }, key).expect(409);
    expect(await h.app.get(SimulatedProviderStore).successCount(first.businessNo)).toBe(0); expect(await h.prisma.shipmentEvent.count({ where: { shipmentId: first.id } })).toBe(0);
  } finally { h.clock.set(before); }
});
it('recovers independent success after inserted progress audit failure while held without resending or reopening', async () => {
  const { order, first } = await pending(); const key = randomUUID(); const audit = h.app.get(AuditService); const record = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { const row = await record(tx, entry); if (entry.action === 'ORDER_SHIPMENT_PROGRESS_CONFIRMED') throw new Error('Injected progress audit failure'); return row; });
  await h.command(h.actors.initiator, driver(first.id), { expectedVersion: 1, progress: 'COLLECTED' }, key).expect(500);
  expect(await h.app.get(SimulatedProviderStore).successCount(first.businessNo)).toBe(1); expect(await h.prisma.shipmentEvent.count({ where: { shipmentId: first.id } })).toBe(0);
  vi.restoreAllMocks(); await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD' } });
  const send = vi.spyOn(h.app.get(SimulatedProviderStore), 'recordEvent');
  const result = await h.command(h.actors.initiator, driver(first.id), { expectedVersion: 1, progress: 'COLLECTED' }, key).expect(200);
  expect(result.body.order.status).toBe('ON_HOLD'); expect(send).not.toHaveBeenCalled(); expect(await h.prisma.shipmentEvent.count({ where: { shipmentId: first.id } })).toBe(1);
  expect((await h.command(h.actors.initiator, driver(first.id), { expectedVersion: 1, progress: 'COLLECTED' }, key).expect(200)).body).toEqual(result.body);
});
it('reconciles genuinely entered independent progress after concurrent hold and rechecks a stale pending snapshot', async () => {
  const { order, first } = await pending(); const store = h.app.get(SimulatedProviderStore); const record = store.recordEvent.bind(store);
  vi.spyOn(store, 'recordEvent').mockImplementationOnce(async event => { await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD' } }); await record(event); });
  const result = await h.command(h.actors.initiator, driver(first.id), { expectedVersion: 1, progress: 'COLLECTED' }).expect(200);
  expect(result.body.order.status).toBe('ON_HOLD'); expect(await store.successCount(first.businessNo)).toBe(1);
  vi.restoreAllMocks(); const another = await pending(); const adapter = h.app.get(SimulatedLogisticsAdapter); const query = adapter.queryShipment.bind(adapter);
  vi.spyOn(adapter, 'queryShipment').mockImplementationOnce(async businessNo => {
    const prior = await query(businessNo); await store.recordEvent(verified(another.first, 'COLLECTED'));
    await h.prisma.order.update({ where: { id: another.order.id }, data: { status: 'ON_HOLD', holdReason: 'TEST_HOLD' } }); return prior;
  });
  expect((await h.command(h.actors.initiator, driver(another.first.id), { expectedVersion: 1, progress: 'COLLECTED' }).expect(200)).body.order.status).toBe('ON_HOLD');
});
it('samples fresh event time after real shipment lock waits and denies a new effect at deadline', async () => {
  const { order, first } = await pending(); const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect(); const before = h.clock.now();
  let response: Promise<{ status: number }> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM "Shipment" WHERE id = $1::uuid FOR UPDATE', [first.id]); const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    response = h.command(h.actors.initiator, driver(first.id), { expectedVersion: 1, progress: 'COLLECTED' }).then(r => r);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) { const result = await h.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`; if (result[0]!.waiting > 0) { blocked = true; break; } await delay(10); }
    expect(blocked).toBe(true); h.clock.set((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillmentDeadline!); await blocker.query('COMMIT');
    expect((await response).status).toBe(409); expect(await h.app.get(SimulatedProviderStore).successCount(first.businessNo)).toBe(0);
  } finally { await blocker.query('ROLLBACK'); await response; await blocker.end(); h.clock.set(before); }
});
it('worker releases business locks before provider I/O, validates results and reconciles a saved fact after hold', async () => {
  const { order, first } = await registered(); const op = operation(first);
  await h.prisma.outboxCommand.create({ data: { ...op, availableAt: h.clock.now() } });
  const adapter = h.app.get(SimulatedLogisticsAdapter); const verify = adapter.verifyShipment.bind(adapter); const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  vi.spyOn(adapter, 'verifyShipment').mockImplementationOnce(async value => {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM "Order" WHERE id = $1::uuid FOR UPDATE NOWAIT', [order.id]); await blocker.query('SELECT id FROM "Shipment" WHERE id = $1::uuid FOR UPDATE NOWAIT', [first.id]); await blocker.query('ROLLBACK');
    return verify(value);
  });
  try { await new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry)).tick(); } finally { await blocker.end(); }
  expect(await h.app.get(SimulatedProviderStore).query(first.businessNo)).toMatchObject({ status: 'PENDING' });
  await h.app.get(SimulatedProviderStore).recordEvent(verified(first, 'COLLECTED')); await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD' } });
  h.clock.advance(30000); vi.restoreAllMocks(); const fresh = vi.spyOn(adapter, 'verifyShipment');
  await new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry)).tick();
  expect(fresh).not.toHaveBeenCalled(); expect((await h.prisma.shipment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('COLLECTED');
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
  const result = await adapter.queryShipment(first.businessNo); if (result.status !== 'SUCCESS') throw new Error('Fixture success missing');
  await expect(h.app.get(LogisticsOutboxHandler).apply({ ...op, payload: { ...op.payload, shipmentId: randomUUID() } }, result)).rejects.toThrow('does not match');
});
it.each(['disabled', 'production', 'static'] as const)('does not register logistics routes in %s composition', async mode => {
  const previous = { NODE_ENV: process.env.NODE_ENV, LOGISTICS_PROVIDER: process.env.LOGISTICS_PROVIDER, WECHAT_IDENTITY_PROVIDER: process.env.WECHAT_IDENTITY_PROVIDER };
  process.env.NODE_ENV = mode === 'production' ? 'production' : 'test'; process.env.LOGISTICS_PROVIDER = mode === 'static' ? 'simulated' : 'disabled'; process.env.WECHAT_IDENTITY_PROVIDER = 'wechat';
  try {
    const module = await Test.createTestingModule({ imports: [mode === 'static' ? AppModule : AppModule.forEnvironment()] }).overrideProvider(LocalImageStorageAdapter).useValue({}).overrideProvider(OutboxWorker).useValue({}).overrideProvider(ProposalExpiryScheduler).useValue({}).overrideProvider(OrderExpiryScheduler).useValue({}).compile();
    const app = module.createNestApplication(); configureApp(app); await app.init();
    try { await request(app.getHttpServer()).post(driver(randomUUID())).send({ expectedVersion: 1, progress: 'COLLECTED' }).expect(404); } finally { await app.close(); }
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
it('holds the first independent inspection deadline even before both collections and never extends it on duplicate delivery', async () => {
  const { order, first, second } = await registered(); await apply(verified(first, 'DELIVERED'));
  const receiver = await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } } });
  await h.prisma.order.update({ where: { id: order.id }, data: { fulfillmentDeadline: new Date(receiver.acceptanceDeadline!.getTime() + 3600000), outstandingObligations: { financialOperations: ['preserved'] } } });
  const now = h.clock.now(); try { h.clock.set(receiver.acceptanceDeadline!); await apply(verified(second, 'COLLECTED')); } finally { h.clock.set(now); }
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'ON_HOLD', holdReason: 'INSPECTION_TIMEOUT', outstandingObligations: { financialOperations: ['preserved'] } });
  await apply(verified(first, 'DELIVERED')); expect((await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { id: receiver.id } })).acceptanceDeadline).toEqual(receiver.acceptanceDeadline);
});
