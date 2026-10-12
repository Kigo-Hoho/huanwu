import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
let h: AfterSalesHarness;
beforeAll(async () => { h = await createAfterSalesHarness(); });
afterAll(async () => { await h?.close(); });
it('serializes simultaneous participant applications into one case and one pause', async () => {
  const order = await h.prepareOrder();
  const results = await Promise.all([h.actors.initiator, h.actors.recipient].map(actor => h.command(actor, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '申请人工核验' })));
  expect(results.map(r => r.status).sort()).toEqual([201, 409]);
  expect(results.find(r => r.status === 409)?.body.code).toBe('AFTER_SALES_ALREADY_OPEN');
  expect(await h.prisma.afterSalesCase.count({ where: { orderId: order.id } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_HELD' } })).toBe(1);
});
it('rolls back the case, pause, version, records and idempotency when audit fails', async () => {
  const order = await h.prepareOrder();
  const key = randomUUID();
  h.faultAuditOnce(true);
  try { await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '申请人工核验' }, key).expect(500); }
  finally { vi.restoreAllMocks(); }
  expect(await h.prisma.afterSalesCase.count({ where: { orderId: order.id } })).toBe(0);
  expect(await h.prisma.orderHoldBlocker.count({ where: { orderId: order.id } })).toBe(0);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'AWAITING_DETAILS', version: 1 });
  expect(await h.prisma.idempotencyRecord.count({ where: { actorId: h.actors.initiator.id, key } })).toBe(0);
  await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '申请人工核验' }, key).expect(201);
});
it('allows exactly one append for simultaneous same-key participant responses', async () => {
  const order = await h.prepareOrder();
  const opened = await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '申请人工核验' }).expect(201);
  const key = randomUUID();
  const call = () => h.command(h.actors.recipient, `/api/after-sales/${opened.body.case.id}/response`, { expectedCaseVersion: 1, expectedOrderVersion: 2, description: '另一方补充事实' }, key);
  const results = await Promise.all([call(), call()]);
  expect(results.map(r => r.status)).toEqual([200, 200]);
  expect(results[0].body).toEqual(results[1].body);
  expect(await h.prisma.caseRecord.count({ where: { caseId: opened.body.case.id, kind: 'RESPONSE' } })).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(3);
});
it('maps a simultaneous reused key on different orders to a content conflict', async () => {
  const orders = [await h.prepareOrder(), await h.prepareOrder()];
  const key = randomUUID();
  const results = await Promise.all(orders.map(order => h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '申请人工核验' }, key)));
  expect(results.map(r => r.status).sort()).toEqual([201, 409]);
  expect(results.find(r => r.status === 409)?.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  expect(await h.prisma.afterSalesCase.count({ where: { orderId: { in: orders.map(o => o.id) } } })).toBe(1);
});
it('rolls back a response record and both revisions when its final audit fails', async () => {
  const order = await h.prepareOrder();
  const opened = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '申请人工核验' }).expect(201)).body;
  const key = randomUUID();
  const auditCount = await h.prisma.auditLog.count();
  h.faultAuditOnce(true);
  try { await h.command(h.actors.recipient, `/api/after-sales/${opened.case.id}/response`, { expectedCaseVersion: 1, expectedOrderVersion: 2, description: '本记录应整笔回滚' }, key).expect(500); }
  finally { vi.restoreAllMocks(); }
  expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'RESPONSE' } })).toBe(0);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).version).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
  expect(await h.prisma.auditLog.count()).toBe(auditCount);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
});
