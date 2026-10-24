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
it.each(['self-cycle', 'mutual-cycle', 'cycle-with-tail', 'dangling-reference', 'inconsistent-root', 'duplicate-parent', 'malformed-reference', 'multiple-tails'] as const)('requires manual verification of imported %s without opening side effects', async kind => {
  const order = await h.prepareOrder();
  const rootDisputeId = randomUUID();
  const size = kind === 'cycle-with-tail' ? 3 : ['mutual-cycle', 'inconsistent-root', 'duplicate-parent', 'multiple-tails'].includes(kind) ? 2 : 1;
  const history = [];
  for (let i = 0; i < size; i++) history.push(await h.prisma.afterSalesCase.create({ data: {
    orderId: order.id, rootDisputeId: kind === 'inconsistent-root' && i === 1 ? randomUUID() : rootDisputeId,
    applicantId: h.actors.initiator.id, reason: '导入的已关闭历史', status: 'WITHDRAWN', closedAt: h.clock.now(),
  } }));
  const link = (caseId: string, previousCaseId: string | number) => h.prisma.caseRecord.create({ data: { caseId, actorId: h.actors.initiator.id, kind: 'OPENED', description: '导入的不可修改前序关联', details: { previousCaseId } } });
  if (kind === 'self-cycle') await link(history[0].id, history[0].id);
  if (['mutual-cycle', 'cycle-with-tail'].includes(kind)) {
    await link(history[0].id, history[1].id);
    await link(history[1].id, history[0].id);
  }
  if (kind === 'dangling-reference') await link(history[0].id, randomUUID());
  if (kind === 'inconsistent-root') await link(history[1].id, history[0].id);
  if (kind === 'duplicate-parent') {
    await link(history[1].id, history[0].id);
    await link(history[1].id, randomUUID());
  }
  if (kind === 'malformed-reference') await link(history[0].id, 42);
  const snapshot = async () => ({
    order: await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    cases: await h.prisma.afterSalesCase.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } }),
    records: await h.prisma.caseRecord.count({ where: { case: { orderId: order.id } } }),
    audits: await h.prisma.auditLog.count(), cache: await h.prisma.idempotencyRecord.count(),
    blockers: await h.prisma.orderHoldBlocker.count({ where: { orderId: order.id } }),
  });
  const before = await snapshot();
  const response = await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '后续售后申请' }).expect(409);
  expect(response.body.code).toBe('AFTER_SALES_NOT_ELIGIBLE');
  expect(response.body.details.manualVerificationRequired).toBe(true);
  expect(await snapshot()).toEqual(before);
});
