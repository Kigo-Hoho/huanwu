import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { OrderExpiryService } from '../../src/orders/order-expiry.service.js';
import { OrderExpiryScheduler } from '../../src/orders/order-expiry.scheduler.js';
import { AuditService } from '../../src/audit/audit.service.js';

let h: OrderHarness;
beforeAll(async () => { h = await createOrderHarness(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await h?.close(); });

it.each(['SETTLING', 'CANCEL_PENDING', 'COMPLETED', 'CANCELLED', 'ON_HOLD'] as const)('ignores old deadlines in %s without an extra revision or audit', async status => {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  await h.prisma.order.update({ where: { id: order.id }, data: { status, paymentDeadline: h.clock.now(), fulfillmentDeadline: h.clock.now() } });
  await h.prisma.orderPartyProgress.updateMany({ where: { orderId: order.id }, data: { acceptanceDeadline: h.clock.now() } });
  h.clock.set(order.detailsDeadline);
  const count = await h.prisma.auditLog.count({ where: { entityId: order.id } });
  expect(await h.app.get(OrderExpiryService).reconcile(order.id)).toBe(false);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status, version: 1 });
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id } })).toBe(count);
});

it('ignores accepted-side inspection and an obsolete fulfillment deadline in transit', async () => {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'IN_TRANSIT', fulfillmentDeadline: h.clock.now() } });
  await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } }, data: { acceptanceDeadline: h.clock.now(), acceptedAt: new Date(h.clock.now().getTime() - 1) } });
  expect(await h.app.get(OrderExpiryService).reconcile(order.id)).toBe(false);
  expect((await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(200)).body).toMatchObject({ status: 'IN_TRANSIT', version: 1 });
});

it('keeps unresolved payment leases and selects the post-cleanup status filter', async () => {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  const intent = await h.prisma.paymentIntent.create({ data: { orderId: order.id, side: 'INITIATOR', purpose: 'DEPOSIT', provider: 'simulated', amountFen: 1000, businessNo: randomUUID(), status: 'PENDING' } });
  h.clock.set(order.paymentDeadline);
  const list = (await h.get(h.actors.initiator, '/api/me/orders?status=CANCEL_PENDING&limit=100').expect(200)).body;
  expect(list.items.find((o: { id: string }) => o.id === order.id)).toMatchObject({ status: 'CANCEL_PENDING', version: 2 });
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  expect(await h.prisma.outboxCommand.findUniqueOrThrow({ where: { businessNo: `close:${intent.id}` } })).toMatchObject({ kind: 'CLOSE_PAYMENT', payload: { paymentBusinessNo: intent.businessNo, amountFen: 1000, currency: 'CNY' } });
  expect(await h.app.get(OrderExpiryService).reconcile(order.id)).toBe(false);
});

it('scans each minute, coalesces concurrent ticks and awaits in-flight audit work before destroy', async () => {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  const scheduler = new OrderExpiryScheduler(h.app.get(OrderExpiryService));
  const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const released = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
    const result = await original(tx, entry);
    if (entry.action === 'ORDER_CANCEL_PENDING' && entry.entityId === order.id) { enter(); await released; }
    return result;
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    scheduler.onModuleInit(); h.clock.set(order.detailsDeadline);
    await vi.advanceTimersByTimeAsync(59999);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('AWAITING_DETAILS');
    await vi.advanceTimersByTimeAsync(1); await entered;
    const tick = scheduler.tick(); expect(scheduler.tick()).toBe(tick);
    let closed = false; const closing = scheduler.onModuleDestroy().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); release(); await closing; await tick;
    expect(closed).toBe(true);
    expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CANCELLED', version: 2 });
    expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_CANCEL_PENDING' } })).toBe(1);
    await vi.advanceTimersByTimeAsync(120000); await scheduler.tick();
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
  } finally { release(); await scheduler.onModuleDestroy(); vi.useRealTimers(); }
});

it.each(['DETAILS', 'PAYMENT', 'FULFILLMENT', 'INSPECTION'] as const)('persists inclusive %s expiry on participant GET and keeps the correct leases', async kind => {
  const order = (await h.convert(await h.confirmedProposal({ mode: kind === 'PAYMENT' ? 'IN_PERSON' : 'COURIER' })).expect(201)).body.order;
  const deadline = new Date(h.clock.now().getTime() + 1000);
  if (kind === 'DETAILS') await h.prisma.order.update({ where: { id: order.id }, data: { detailsDeadline: deadline } });
  if (kind === 'PAYMENT') await h.prisma.order.update({ where: { id: order.id }, data: { paymentDeadline: deadline } });
  if (kind === 'FULFILLMENT' || kind === 'INSPECTION') {
    await h.prisma.order.update({ where: { id: order.id }, data: { status: 'AWAITING_FULFILLMENT', fulfillmentDeadline: kind === 'FULFILLMENT' ? deadline : new Date(deadline.getTime() + 10000), outstandingObligations: { financialOperations: ['saved-admission'] } } });
    if (kind === 'INSPECTION') await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } }, data: { incomingDeliveredAt: h.clock.now(), acceptanceDeadline: deadline } });
  }
  h.clock.set(new Date(deadline.getTime() - 1));
  expect((await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(200)).body.version).toBe(1);
  h.clock.set(deadline);
  const expired = (await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(200)).body;
  const cancelled = kind === 'DETAILS' || kind === 'PAYMENT';
  expect(expired.status).toBe(cancelled ? 'CANCELLED' : 'ON_HOLD'); expect(expired.version).toBe(2);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(cancelled ? 0 : 2);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: cancelled ? 'ORDER_CANCELLED' : 'ORDER_HELD', actorId: null } })).toBe(1);
  expect((await h.get(h.actors.recipient, `/api/orders/${order.id}`).expect(200)).body).toEqual(expired);
  if (!cancelled) expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).outstandingObligations).toMatchObject({ financialOperations: ['saved-admission'] });
});

it('rolls back an expired command before independent cleanup and keeps successful terminal replay unchanged', async () => {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  const key = randomUUID(); const input = { expectedVersion: 1, reason: '暂时不需要交换' };
  const success = (await h.command(h.actors.initiator, `/api/orders/${order.id}/cancellation`, input, key).expect(200)).body;
  h.clock.set(order.detailsDeadline);
  const expiredKey = randomUUID();
  await h.command(h.actors.recipient, `/api/orders/${order.id}/cancellation`, { expectedVersion: 2, reason: '现在想取消交换' }, expiredKey).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_EXPIRED'));
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CANCELLED', version: 3 });
  expect(await h.prisma.idempotencyRecord.count({ where: { key: expiredKey } })).toBe(0);
  expect((await h.command(h.actors.initiator, `/api/orders/${order.id}/cancellation`, input, key).expect(200)).body).toEqual(success);
  expect(await h.prisma.orderCancellation.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: 'EXPIRED' });
});

it.each(['payments', 'shipments', 'handover', 'acceptance'] as const)('a delayed scanner cannot admit a fresh expired %s command', async action => {
  const order = (await h.convert(await h.confirmedProposal({ mode: action === 'shipments' ? 'COURIER' : 'IN_PERSON' })).expect(201)).body.order;
  const deadline = h.clock.now();
  if (action === 'payments') await h.prisma.order.update({ where: { id: order.id }, data: { paymentDeadline: deadline } });
  else {
    await h.prisma.order.update({ where: { id: order.id }, data: { status: action === 'acceptance' ? 'AWAITING_ACCEPTANCE' : 'AWAITING_FULFILLMENT', fulfillmentDeadline: deadline } });
    await h.prisma.orderPartyProgress.updateMany({ where: { orderId: order.id }, data: { fundsReady: true, ...(action === 'acceptance' ? { incomingDeliveredAt: new Date(deadline.getTime() - 1000), acceptanceDeadline: deadline } : {}) } });
  }
  const key = randomUUID(); const extra = action === 'payments' ? { purpose: 'DEPOSIT' } : action === 'shipments' ? { carrier: 'SF', trackingNumber: randomUUID() } : {};
  await h.command(h.actors.initiator, `/api/orders/${order.id}/${action}`, { expectedVersion: 1, ...extra }, key).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_EXPIRED'));
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect(await h.prisma.paymentIntent.count({ where: { orderId: order.id } })).toBe(0);
  expect(await h.prisma.shipment.count({ where: { orderId: order.id } })).toBe(0);
  expect(await h.prisma.orderPartyProgress.count({ where: { orderId: order.id, OR: [{ handedOverAt: { not: null } }, { acceptedAt: { not: null } }] } })).toBe(0);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: action === 'payments' ? 'CANCELLED' : 'ON_HOLD', version: 2 });
});

it.each(['ORDER_CANCELLED', 'ORDER_HELD'] as const)('rolls back the final %s audit after its actual insert, including leases and revision', async action => {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  if (action === 'ORDER_HELD') await h.prisma.order.update({ where: { id: order.id }, data: { status: 'AWAITING_FULFILLMENT', fulfillmentDeadline: h.clock.now() } });
  else h.clock.set(order.detailsDeadline);
  const before = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { const result = await original(tx, entry); if (entry.action === action && entry.entityId === order.id) throw new Error('Injected final expiry audit failure'); return result; });
  await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(500);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(before);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: { in: ['ORDER_HELD', 'ORDER_CANCEL_PENDING', 'ORDER_CANCELLED'] } } })).toBe(0);
});

it('authorizes before cleanup, cleans list results, and withholds a GET result when the real audit insert fails', async () => {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  h.clock.set(order.detailsDeadline);
  for (const actor of [h.actors.outsider, h.actors.operator, h.actors.mixed]) await h.get(actor, `/api/orders/${order.id}`).expect(actor === h.actors.outsider ? 404 : 403);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('AWAITING_DETAILS');
  h.faultAuditOnce(true);
  await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(500);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'AWAITING_DETAILS', version: 1 });
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_CANCEL_PENDING' } })).toBe(0);
  const list = await h.get(h.actors.initiator, '/api/me/orders').expect(200);
  expect(list.body.items.find((item: { id: string }) => item.id === order.id)).toMatchObject({ status: 'CANCELLED', version: 2 });
});
