import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { Client } from 'pg';
import { setImmediate } from 'node:timers/promises';
import { OrderAcceptanceService } from '../../src/orders/order-acceptance.service.js';

let h: OrderHarness;
beforeAll(async () => { h = await createOrderHarness(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await h?.close(); });
async function inspection(early = false) {
  const order = (await h.convert(await h.confirmedProposal()).expect(201)).body.order;
  await h.prisma.order.update({ where: { id: order.id }, data: { status: early ? 'AWAITING_FULFILLMENT' : 'AWAITING_ACCEPTANCE', fulfillmentDeadline: early ? new Date(h.clock.now().getTime() + 3600000) : null, outstandingObligations: { financialOperations: ['historical-admission'] } } });
  await h.prisma.orderPartyProgress.updateMany({ where: { orderId: order.id, ...(early ? { side: 'INITIATOR' } : {}) }, data: { incomingDeliveredAt: h.clock.now(), acceptanceDeadline: new Date(h.clock.now().getTime() + 3600000), fundsReady: true } });
  return order.id as string;
}
it('lets the independently received side accept, but rejects acceptance for the other incoming parcel', async () => {
  const id = await inspection(true);
  await h.command(h.actors.recipient, `/api/orders/${id}/acceptance`, { expectedVersion: 1 }).expect(409);
  const result = await h.command(h.actors.initiator, `/api/orders/${id}/acceptance`, { expectedVersion: 1 }).expect(200);
  expect(result.body.order.status).toBe('AWAITING_FULFILLMENT');
  expect(result.body.order.parties.find((p: { side: string }) => p.side === 'INITIATOR').acceptedAt).not.toBeNull();
  expect(result.body.order.parties.find((p: { side: string }) => p.side === 'RECIPIENT').acceptedAt).toBeNull();
});
it('holds the order with one command revision, retained financial history and all occupancy, and replays original success', async () => {
  const id = await inspection(); const key = randomUUID(); const input = { expectedVersion: 1, reason: '收到物品存在明显问题' };
  const result = await h.command(h.actors.initiator, `/api/orders/${id}/issue`, input, key).expect(200);
  expect(result.body.order.status).toBe('ON_HOLD'); expect(result.body.order.version).toBe(2);
  const order = await h.prisma.order.findUniqueOrThrow({ where: { id } });
  expect(order.holdPreviousStatus).toBe('AWAITING_ACCEPTANCE'); expect(order.heldAt).toEqual(h.clock.now());
  expect(order.outstandingObligations).toMatchObject({ financialOperations: ['historical-admission'], fulfillment: { pendingAcceptanceSides: ['INITIATOR', 'RECIPIENT'] } });
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(2);
  expect((await h.command(h.actors.initiator, `/api/orders/${id}/issue`, input, key).expect(200)).body).toEqual(result.body);
  await h.command(h.actors.recipient, `/api/orders/${id}/acceptance`, { expectedVersion: 2 }).expect(409);
  expect(await h.prisma.auditLog.count({ where: { entityId: id, action: 'ORDER_HELD' } })).toBe(1);
});
it('enforces identity, schema, resource binding, cancellation and inclusive inspection deadline', async () => {
  const id = await inspection();
  for (const action of ['acceptance', 'issue']) {
    const input = { expectedVersion: 1, ...(action === 'issue' ? { reason: '收到物品存在问题' } : {}) };
    for (const actor of [h.actors.outsider, h.actors.operator, h.actors.mixed]) await h.command(actor, `/api/orders/${id}/${action}`, input).expect(actor === h.actors.outsider ? 404 : 403);
    await h.command(h.actors.initiator, `/api/orders/${id}/${action}`, { ...input, side: 'RECIPIENT' }).expect(400);
  }
  await h.prisma.orderCancellation.create({ data: { orderId: id, requestedBySide: 'RECIPIENT', reason: '请求取消', requestedVersion: 1 } });
  await h.command(h.actors.initiator, `/api/orders/${id}/acceptance`, { expectedVersion: 1 }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_CANCELLATION_PENDING'));
  const fresh = await inspection(); h.clock.advance(3600000);
  await h.command(h.actors.initiator, `/api/orders/${fresh}/acceptance`, { expectedVersion: 1 }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_EXPIRED'));
});
it('rolls back a hold after the actual customer audit insertion fails', async () => {
  const id = await inspection(); const audit = h.app.get(AuditService); const original = audit.record.bind(audit); const key = randomUUID();
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { const row = await original(tx, entry); if (entry.action === 'ORDER_ISSUE_REPORTED') throw new Error('Injected issue audit failure'); return row; });
  await h.command(h.actors.initiator, `/api/orders/${id}/issue`, { expectedVersion: 1, reason: '收到物品存在问题' }, key).expect(500);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'AWAITING_ACCEPTANCE', version: 1, heldAt: null });
  expect(await h.prisma.auditLog.count({ where: { entityId: id, action: 'ORDER_HELD' } })).toBe(0);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
});
it('preserves a logical acceptance success and rejects changed input, changed resource, or stale new commands', async () => {
  const id = await inspection(true); const other = await inspection(true); const key = randomUUID();
  const path = `/api/orders/${id}/acceptance`; const input = { expectedVersion: 1 };
  const success = (await h.command(h.actors.initiator, path, input, key).expect(200)).body;
  h.clock.advance(3600000);
  expect((await h.command(h.actors.initiator, path, input, key).expect(200)).body).toEqual(success);
  for (const [target, payload] of [[id, { expectedVersion: 2 }], [other, input]] as const) await h.command(h.actors.initiator, `/api/orders/${target}/acceptance`, payload, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  const fresh = await inspection();
  await h.command(h.actors.initiator, `/api/orders/${fresh}/acceptance`, { expectedVersion: 2 }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_VERSION_CONFLICT'));
});
it('serializes an issue holding the order lock before a competing acceptance', async () => {
  const id = await inspection(); const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }); const resume = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
    const result = await original(tx, entry);
    if (entry.action === 'ORDER_HELD') { entered(); await resume; }
    return result;
  });
  const service = h.app.get(OrderAcceptanceService);
  const issue = service.issue(h.actors.initiator, id, { expectedVersion: 1, reason: '收到物品存在问题' }, randomUUID());
  await reached;
  const accepted = service.accept(h.actors.recipient, id, { expectedVersion: 1 }, randomUUID()).then(() => 'unexpected', () => 'rejected');
  release(); await issue; expect(await accepted).toBe('rejected');
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ON_HOLD', version: 2 });
  expect(await h.prisma.orderPartyProgress.count({ where: { orderId: id, acceptedAt: { not: null } } })).toBe(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: id } })).toBe(0);
});
it('rechecks inclusive inspection time after an actual sorted item row lock wait', async () => {
  const id = await inspection(); const item = await h.prisma.orderItemSnapshot.findFirstOrThrow({ where: { orderId: id }, orderBy: { itemId: 'asc' } });
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  let active: Promise<string> | undefined;
  try {
    await blocker.query('BEGIN'); const identity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await blocker.query('SELECT id FROM "Item" WHERE id = $1::uuid FOR UPDATE', [item.itemId]);
    active = h.app.get(OrderAcceptanceService).accept(h.actors.initiator, id, { expectedVersion: 1 }, randomUUID()).then(() => 'unexpected', error => error.getResponse().code as string);
    let blocked = false;
    for (let attempts = 0; attempts < 1000; attempts++) {
      const rows = await h.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${identity.rows[0]!.pid} = ANY(pg_blocking_pids(pid))`;
      if (rows[0]!.waiting > 0) { blocked = true; break; } await setImmediate();
    }
    expect(blocked).toBe(true); h.clock.advance(3600000); await blocker.query('COMMIT');
    expect(await active).toBe('ORDER_EXPIRED');
    expect(await h.prisma.orderPartyProgress.count({ where: { orderId: id, acceptedAt: { not: null } } })).toBe(0);
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await active; }
});
