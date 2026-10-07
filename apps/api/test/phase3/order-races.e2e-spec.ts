import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { OrderAcceptanceService } from '../../src/orders/order-acceptance.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { OrderExpiryService } from '../../src/orders/order-expiry.service.js';
import { ProposalsService } from '../../src/proposals/proposals.service.js';
import { OrdersService } from '../../src/orders/orders.service.js';
import { PaymentEventsService } from '../../src/payments/payment-events.service.js';
import { SimulatedPaymentAdapter } from '../../src/integrations/simulated-payment.adapter.js';
import { LogisticsOutboxHandler } from '../../src/logistics/logistics-outbox.handler.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import type { PaymentIntent } from '../../src/generated/prisma/client.js';
import { ReservationsService } from '../../src/reservations/reservations.service.js';
import { OrderCancellationEngine } from '../../src/orders/order-cancellation-engine.service.js';
import { OrderHoldService } from '../../src/orders/order-hold.service.js';
import { PAYMENT_PORT, type PaymentPort } from '../../src/payments/payment.port.js';

let h: OrderHarness;
const environment = new Map<string, string | undefined>(); const signingKey = randomBytes(32);
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'simulated', LOGISTICS_PROVIDER: 'simulated', SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: signingKey.toString('base64'), ADDRESS_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), ADDRESS_ENCRYPTION_KEY_VERSION: 'races-test' })) { environment.set(key, process.env[key]); process.env[key] = value; }
  h = await createOrderHarness();
});
afterEach(async () => { vi.restoreAllMocks(); await h.prisma.outboxCommand.updateMany({ where: { status: { in: ['PENDING', 'UNKNOWN', 'PROCESSING'] } }, data: { availableAt: new Date('2099-01-01'), leaseOwner: null, leaseExpiresAt: null, status: 'UNKNOWN' } }); });
afterAll(async () => { await h?.close(); for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

function barrier() {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const released = new Promise<void>(resolve => { release = resolve; });
  return { enter, release, entered, released };
}
function auditBarrier(action: string, id?: string) {
  const gate = { ...barrier(), pid: 0 }; const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
    const result = await original(tx, entry);
    if (entry.action === action && (!id || entry.entityId === id)) {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; gate.pid = row!.pid;
      gate.enter(); await gate.released;
    }
    return result;
  });
  return gate;
}
async function blockedBy(pid: number) {
  for (let i = 0; i < 1000; i++) {
    const [row] = await h.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
    if (row!.waiting > 0) return;
    await setImmediate();
  }
  throw new Error('Competing transaction never reached the expected PostgreSQL lock');
}
const current = (id: string) => h.prisma.order.findUniqueOrThrow({ where: { id } });
async function paymentFact(intent: PaymentIntent) {
  const raw = JSON.stringify({ provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo: intent.businessNo, occurredAt: h.clock.now().toISOString(), externalTransactionId: randomUUID(), amountFen: intent.amountFen, currency: 'CNY' });
  await h.app.get(PaymentEventsService).applyVerified(h.app.get(SimulatedPaymentAdapter).verifySignedEvent(raw, createHmac('sha256', signingKey).update(raw).digest('hex')));
}
async function funded(mode: 'COURIER' | 'IN_PERSON' = 'IN_PERSON') {
  const order = (await h.convert(await h.confirmedProposal({ mode })).expect(201)).body.order;
  if (mode === 'COURIER') for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${order.id}/address`, { expectedVersion: (await current(order.id)).version, recipientName: '测试收件', phone: '13800000000', region: '测试地区', detail: '测试详细地址' }).expect(200);
  for (const actor of [h.actors.initiator, h.actors.recipient]) {
    const started = await h.command(actor, `/api/orders/${order.id}/payments`, { expectedVersion: (await current(order.id)).version, purpose: 'DEPOSIT' }).expect(202);
    await paymentFact(await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.body.paymentIntentId } }));
  }
  return order.id as string;
}

it('conversion owns the proposal lock before cancellation and expiry; six leases stay with its sole order', async () => {
  const proposal = await h.confirmedProposal({ offeredCount: 5 }); const gate = auditBarrier('PROPOSAL_CONVERTED', proposal.id);
  const converted = h.app.get(OrdersService).convert(h.actors.initiator, proposal.id, { expectedVersion: proposal.version }, randomUUID());
  let cancel: Promise<{ status: number }> | undefined; let expiry: Promise<boolean> | undefined;
  try {
    await gate.entered;
    cancel = h.command(h.actors.recipient, `/api/proposals/${proposal.id}/cancel`, { expectedVersion: proposal.version }).then(r => r);
    expiry = h.app.get(ProposalsService).expire(proposal.id);
    await blockedBy(gate.pid); h.clock.set(proposal.reservationExpiresAt!); gate.release();
    const success = await converted; expect((await cancel).status).toBe(409); expect(await expiry).toBe(false);
    expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(1);
    const leases = await h.prisma.itemReservation.findMany({ where: { orderId: success.order.id } });
    expect(leases).toHaveLength(6); for (const lease of leases) expect(lease).toMatchObject({ proposalId: null, proposalVersionId: null, expiresAt: null });
  } finally { gate.release(); await Promise.allSettled([converted, cancel, expiry]); }
});

it.each(['cancel', 'expire'] as const)('proposal %s wins before conversion and never leaves mixed proposal/order occupancy', async winner => {
  const proposal = await h.confirmedProposal({ offeredCount: 5 });
  if (winner === 'expire') h.clock.set(proposal.reservationExpiresAt!);
  const gate = auditBarrier(winner === 'cancel' ? 'PROPOSAL_CANCELLED' : 'PROPOSAL_EXPIRED', proposal.id);
  const decision = winner === 'cancel' ? h.command(h.actors.initiator, `/api/proposals/${proposal.id}/cancel`, { expectedVersion: proposal.version }).then(r => r.status) : h.app.get(ProposalsService).expire(proposal.id);
  let conversion: Promise<{ status: number }> | undefined;
  try {
    await gate.entered; conversion = h.convert(proposal).then(r => r); await blockedBy(gate.pid); gate.release();
    expect(await decision).toBe(winner === 'cancel' ? 200 : true); expect((await conversion).status).toBe(409);
    expect(await h.prisma.order.count({ where: { proposalId: proposal.id } })).toBe(0);
    expect(await h.prisma.itemReservation.count({ where: { proposalId: proposal.id } })).toBe(0);
  } finally { gate.release(); await Promise.allSettled([decision, conversion]); }
});

it.each(['payment', 'expiry'] as const)('serializes trusted payment versus expiry with %s holding the first lock', async winner => {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  const intents: PaymentIntent[] = [];
  for (const side of ['INITIATOR', 'RECIPIENT'] as const) { const id = randomUUID(); intents.push(await h.prisma.paymentIntent.create({ data: { id, orderId: order.id, side, purpose: 'DEPOSIT', provider: 'simulated', amountFen: 1000, businessNo: `payment:${id}`, status: 'PENDING' } })); }
  await paymentFact(intents[0]!);
  if (winner === 'expiry') h.clock.set(order.paymentDeadline);
  const gate = auditBarrier(winner === 'payment' ? 'ORDER_PAYMENT_CONFIRMED' : 'ORDER_CANCEL_PENDING', winner === 'payment' ? intents[1]!.id : order.id);
  const first = winner === 'payment' ? paymentFact(intents[1]!) : h.app.get(OrderExpiryService).reconcile(order.id);
  let second: Promise<void | boolean> | undefined;
  try {
    await gate.entered; h.clock.set(order.paymentDeadline);
    second = winner === 'payment' ? h.app.get(OrderExpiryService).reconcile(order.id) : paymentFact(intents[1]!);
    await blockedBy(gate.pid); gate.release(); await first; await second;
    expect((await current(order.id)).status).toBe(winner === 'payment' ? 'AWAITING_FULFILLMENT' : 'CANCEL_PENDING');
    expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: order.id }, entryType: 'PAYMENT' } })).toBe(2);
    expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
    expect(await h.prisma.outboxCommand.count({ where: { orderId: order.id, kind: 'REFUND_PAYMENT' } })).toBe(winner === 'expiry' ? 2 : 0);
  } finally { gate.release(); await Promise.allSettled([first, second]); }
});

it('cancellation agreement owns the order lock before shipment registration; no shipment escapes pending refunds', async () => {
  const id = await funded('COURIER');
  const pending = (await h.command(h.actors.initiator, `/api/orders/${id}/cancellation`, { expectedVersion: (await current(id)).version, reason: '现在需要取消交换' }).expect(200)).body.order;
  const gate = auditBarrier('ORDER_CANCEL_PENDING', id);
  const agreed = h.command(h.actors.recipient, `/api/orders/${id}/cancellation/respond`, { expectedVersion: pending.version, cancellationId: pending.cancellation.id, decision: 'AGREE' }).then(r => r);
  let shipment: Promise<{ status: number }> | undefined;
  try {
    await gate.entered; shipment = h.command(h.actors.initiator, `/api/orders/${id}/shipments`, { expectedVersion: pending.version, carrier: 'SF', trackingNumber: randomUUID() }).then(r => r);
    await blockedBy(gate.pid); gate.release(); expect((await agreed).status).toBe(200); expect((await shipment).status).toBe(409);
    expect(await h.prisma.shipment.count({ where: { orderId: id } })).toBe(0); expect((await current(id)).status).toBe('CANCEL_PENDING');
    expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(2);
  } finally { gate.release(); await Promise.allSettled([agreed, shipment]); }
});

it.each(['acceptance', 'issue'] as const)('second acceptance versus issue has one decision when %s holds the first lock', async winner => {
  const id = await funded();
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${id}/handover`, { expectedVersion: (await current(id)).version }).expect(200);
  const service = h.app.get(OrderAcceptanceService);
  await service.accept(h.actors.initiator, id, { expectedVersion: (await current(id)).version }, randomUUID());
  const version = (await current(id)).version;
  const accept = () => service.accept(h.actors.recipient, id, { expectedVersion: version }, randomUUID());
  const issue = () => service.issue(h.actors.initiator, id, { expectedVersion: version, reason: '收到物品存在问题' }, randomUUID());
  const gate = auditBarrier(winner === 'acceptance' ? 'ORDER_SETTLING' : 'ORDER_HELD', id);
  const first = winner === 'acceptance' ? accept() : issue(); let second: Promise<string> | undefined;
  try {
    await gate.entered; second = (winner === 'acceptance' ? issue() : accept()).then(() => 'unexpected', error => error.getResponse().code as string);
    await blockedBy(gate.pid); gate.release(); await first;
    expect(await second).toBe('ORDER_VERSION_CONFLICT');
    expect(await current(id)).toMatchObject({ version: version + 1, status: winner === 'acceptance' ? 'SETTLING' : 'ON_HOLD' });
    expect(await h.prisma.outboxCommand.count({ where: { orderId: id, kind: 'REFUND_PAYMENT' } })).toBe(winner === 'acceptance' ? 2 : 0);
    expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(2);
  } finally { gate.release(); await Promise.allSettled([first, second]); }
});

it('expiry hold between worker query and its final send gate prevents fresh external shipment creation', async () => {
  const id = await funded('COURIER');
  await h.command(h.actors.initiator, `/api/orders/${id}/shipments`, { expectedVersion: (await current(id)).version, carrier: 'SF', trackingNumber: randomUUID() }).expect(200);
  await h.prisma.outboxCommand.updateMany({ where: { orderId: id, kind: 'CREATE_PAYMENT' }, data: { availableAt: new Date('2099-01-01') } });
  const command = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: id, kind: 'VERIFY_SHIPMENT' } });
  await h.prisma.order.update({ where: { id }, data: { fulfillmentDeadline: new Date(h.clock.now().getTime() + 1000) } });
  const handler = h.app.get(LogisticsOutboxHandler); const original = handler.query.bind(handler); const gate = barrier();
  vi.spyOn(handler, 'query').mockImplementation(async op => { const result = await original(op); gate.enter(); await gate.released; return result; });
  const active = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry)).tick();
  try {
    await gate.entered; h.clock.advance(1000); expect(await h.app.get(OrderExpiryService).reconcile(id)).toBe(true); gate.release(); await active;
    expect(await h.app.get(SimulatedProviderStore).query(command.businessNo)).toMatchObject({ status: 'FAILURE', reason: 'NOT_FOUND' });
    expect((await current(id)).status).toBe('ON_HOLD'); expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(2);
    expect(await h.prisma.outboxCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ lastError: 'EXECUTION_NOT_AUTHORIZED', leaseOwner: null });
  } finally { gate.release(); await active; }
});

it('two expiry service instances serialize one hold and one revision under a proven database lock wait', async () => {
  const id = await funded(); await h.prisma.order.update({ where: { id }, data: { fulfillmentDeadline: h.clock.now() } });
  const before = await current(id); const gate = auditBarrier('ORDER_HELD', id);
  const other = new OrderExpiryService(h.prisma, h.clock, h.app.get(ReservationsService), h.app.get(OrderCancellationEngine), h.app.get(OrderHoldService));
  const first = h.app.get(OrderExpiryService).reconcile(id); let second: Promise<boolean> | undefined;
  try {
    await gate.entered; second = other.reconcile(id); await blockedBy(gate.pid); gate.release();
    expect(await first).toBe(true); expect(await second).toBe(false);
    expect(await current(id)).toMatchObject({ status: 'ON_HOLD', version: before.version + 1 });
    expect(await h.prisma.auditLog.count({ where: { entityId: id, action: 'ORDER_HELD', actorId: null } })).toBe(1);
    expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(2);
  } finally { gate.release(); await Promise.allSettled([first, second]); }
});

it('outgoing address authorizes first and never exposes a newly expired fulfillment address', async () => {
  const id = await funded('COURIER'); const before = await current(id); h.clock.set(before.fulfillmentDeadline!);
  await h.get(h.actors.outsider, `/api/orders/${id}/shipping-address?side=outgoing`).expect(404);
  expect((await current(id)).status).toBe('AWAITING_FULFILLMENT');
  await h.get(h.actors.initiator, `/api/orders/${id}/shipping-address?side=outgoing`).expect(409);
  expect((await current(id)).status).toBe('ON_HOLD');
  expect(await h.prisma.auditLog.count({ where: { entityId: id, action: 'ORDER_OUTGOING_ADDRESS_READ' } })).toBe(0);
});

it.each(['before', 'after'] as const)('checkout cleans payment expiry %s provider read without exposing parameters', async boundary => {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  const started = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const path = `/api/orders/${order.id}/payments/${started.body.paymentIntentId}/checkout`;
  const port = h.app.get<PaymentPort>(PAYMENT_PORT); const original = port.checkout!.bind(port);
  if (boundary === 'before') h.clock.set(order.paymentDeadline);
  else vi.spyOn(port, 'checkout').mockImplementation(async businessNo => { const result = await original(businessNo); h.clock.set(order.paymentDeadline); return result; });
  await h.get(h.actors.recipient, path).expect(403); expect((await current(order.id)).status).toBe('AWAITING_PAYMENT');
  await h.get(h.actors.initiator, path).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_EXPIRED'));
  expect((await current(order.id)).status).toBe('CANCEL_PENDING');
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
});

it('persists inspection timeout after a proven item lock wait instead of admitting a stale acceptance', async () => {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  const deadline = new Date(h.clock.now().getTime() + 1000);
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'AWAITING_ACCEPTANCE' } });
  await h.prisma.orderPartyProgress.updateMany({ where: { orderId: order.id }, data: { incomingDeliveredAt: h.clock.now(), acceptanceDeadline: deadline } });
  const item = await h.prisma.orderItemSnapshot.findFirstOrThrow({ where: { orderId: order.id }, orderBy: { itemId: 'asc' } });
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  let active: Promise<string> | undefined;
  try {
    await blocker.query('BEGIN'); const identity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await blocker.query('SELECT id FROM "Item" WHERE id = $1::uuid FOR UPDATE', [item.itemId]);
    active = h.app.get(OrderAcceptanceService).accept(h.actors.initiator, order.id, { expectedVersion: 1 }, randomUUID()).then(() => 'unexpected', error => error.getResponse().code as string);
    let blocked = false;
    for (let attempts = 0; attempts < 1000; attempts++) {
      const rows = await h.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${identity.rows[0]!.pid} = ANY(pg_blocking_pids(pid))`;
      if (rows[0]!.waiting > 0) { blocked = true; break; } await setImmediate();
    }
    expect(blocked).toBe(true); h.clock.set(deadline); await blocker.query('COMMIT');
    expect(await active).toBe('ORDER_EXPIRED');
    expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'ON_HOLD', version: 2, holdReason: 'INSPECTION_TIMEOUT' });
    expect(await h.prisma.orderPartyProgress.count({ where: { orderId: order.id, acceptedAt: { not: null } } })).toBe(0);
    expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await active; }
});
