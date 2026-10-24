import { afterAll, beforeAll, expect, it } from 'vitest';
import { createCompensationHarness, type CompensationHarness } from './support/compensation-harness.js';
import { operatorRequestHash } from '../../src/operator-security/operator-action.types.js';
import { CaseFinalizationService } from '../../src/after-sales/case-finalization.service.js';
import { vi } from 'vitest';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import type { ProviderOperation } from '../../src/integrations/integration.types.js';
let h: CompensationHarness;
beforeAll(async () => { h = await createCompensationHarness(); });
afterAll(async () => { await h?.close(); });
it('permits ordinary payments, handover and acceptance after safe funds-free recovery', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE', amount: 0, approve: false }); await f.execute();
  for (const actor of [h.actors.initiator, h.actors.recipient]) {
    const started = await h.command(actor, `/api/orders/${f.order.id}/payments`, { expectedVersion: (await f.current()).expectedOrderVersion, purpose: 'DEPOSIT' }).expect(202);
    const p = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.body.paymentIntentId } });
    await h.run(p.businessNo);
    await h.command(actor, `/api/testing/payments/${p.id}/complete`, { expectedVersion: (await f.current()).expectedOrderVersion }).expect(200);
    await h.run(p.businessNo);
  }
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${f.order.id}/handover`, { expectedVersion: (await f.current()).expectedOrderVersion }).expect(200);
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${f.order.id}/acceptance`, { expectedVersion: (await f.current()).expectedOrderVersion }).expect(200);
  for (const op of await h.prisma.outboxCommand.findMany({ where: { orderId: f.order.id, status: 'PENDING' } })) await h.run(op.businessNo);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('COMPLETED');
});
it('resumes from current facts while unpaid independent compensation keeps the case open', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE' });
  await f.execute();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('AWAITING_PAYMENT');
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).status).toBe('EXECUTING');
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(2);
});
it('closes once on trusted compensation transfer without holding the resumed order again', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE' }); await f.execute();
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments`, await f.current()).expect(200);
  const payment = await h.prisma.compensationPayment.findFirstOrThrow({ where: { obligation: { resolution: { caseId: f.caseId } } } });
  await h.run(payment.businessNo);
  await h.command(h.actors.initiator, `/api/testing/compensation/${payment.id}/complete`, await f.current()).expect(200);
  await h.prisma.outboxCommand.update({ where: { businessNo: `compensation:disburse:${payment.id}` }, data: { status: 'UNKNOWN' } });
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('AWAITING_PAYMENT');
  await h.run(`compensation:disburse:${payment.id}`);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).status).toBe('RESOLVED');
  expect(await h.app.get(CaseFinalizationService).reconcile(f.caseId)).toBe(false);
  expect(await h.prisma.auditLog.count({ where: { entityId: f.caseId, action: 'CASE_RESOLVED' } })).toBe(1);
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(2);
});
it('extends the same deadline category only once from server approval time', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE' });
  async function extend(status: number) {
    const input = { ...await f.current(), kind: 'PAYMENT', reason: '批准延长付款期限' };
    const grant = await h.grant(h.one, { action: 'RESUME_ORDER', resourceId: f.caseId, expectedVersions: await f.current(), requestHash: operatorRequestHash(input) }).expect(200);
    return h.post(h.one, `${f.path}/extend-deadline`, { ...input, operatorAction: { sessionId: h.one.response.body.operatorSession.id, grantId: grant.body.id } }).expect(status);
  }
  await extend(200);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).paymentDeadline).toEqual(new Date(h.clock.now().getTime() + 72 * 3600000));
  await extend(409);
});
it('does not trust stale fundsReady flags as evidence of funded recovery', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE' });
  await h.prisma.orderPartyProgress.updateMany({ where: { orderId: f.order.id }, data: { fundsReady: true } });
  await f.execute();
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('AWAITING_PAYMENT');
});
it('derives completed recovery when both acceptances and original settlement finished during hold', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const current = () => h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  for (const actor of [h.actors.initiator, h.actors.recipient]) {
    const started = await h.command(actor, `/api/orders/${order.id}/payments`, { expectedVersion: (await current()).version, purpose: 'DEPOSIT' }).expect(202);
    const p = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.body.paymentIntentId } }); await h.run(p.businessNo);
    await h.command(actor, `/api/testing/payments/${p.id}/complete`, { expectedVersion: (await current()).version }).expect(200); await h.run(p.businessNo);
  }
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${order.id}/handover`, { expectedVersion: (await current()).version }).expect(200);
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${order.id}/acceptance`, { expectedVersion: (await current()).version }).expect(200);
  for (const row of await h.prisma.outboxCommand.findMany({ where: { orderId: order.id, status: 'PENDING' } })) {
    const op: ProviderOperation = { businessNo: row.businessNo, orderId: row.orderId, kind: row.kind, payload: row.payload as ProviderOperation['payload'] };
    const handler = h.app.get(OutboxHandlerRegistry).get(row.kind)!;
    expect(await handler.authorize?.(op)).toBe(true); await handler.execute(op);
  }
  const f = await h.fixture({ existingOrder: await current(), type: 'CONTINUE_EXCHANGE', amount: 0, approve: false });
  for (const op of await h.prisma.outboxCommand.findMany({ where: { orderId: order.id, status: 'PENDING' } })) await h.run(op.businessNo);
  const versions = await f.current(); const input = { ...versions, reason: '核验既有结算后恢复' };
  const grant = await h.grant(h.one, { action: 'RESUME_ORDER', resourceId: f.caseId, expectedVersions: versions, requestHash: operatorRequestHash(input) }).expect(200);
  const response = await h.post(h.one, `${f.path}/execute`, { ...input, operatorAction: { sessionId: h.one.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200);
  expect(response.body.orderVersion).toBe((await current()).version);
  expect((await current()).status).toBe('COMPLETED');
});
it('the lawful closure gate itself blocks an unresolved claim even when funds are complete', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE' }); await f.execute();
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments`, await f.current()).expect(200);
  const payment = await h.prisma.compensationPayment.findFirstOrThrow({ where: { obligation: { resolution: { caseId: f.caseId } } } });
  await h.run(payment.businessNo);
  await h.command(h.actors.initiator, `/api/testing/compensation/${payment.id}/complete`, await f.current()).expect(200);
  const finalizer = h.app.get(CaseFinalizationService);
  const suspended = vi.spyOn(finalizer, 'reconcile').mockResolvedValue(false);
  try { await h.run(`compensation:disburse:${payment.id}`); } finally { suspended.mockRestore(); }
  const claim = await h.prisma.resolutionExecution.findFirstOrThrow({ where: { resolution: { caseId: f.caseId }, executionStep: `CLAIM:compensation:disburse:${payment.id}` } });
  // An imported unresolved execution marker must independently fence closure,
  // even when its financial domain already contains complete trustworthy facts.
  let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const updating = h.prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.order.id}::uuid FOR UPDATE`;
    await tx.resolutionExecutionProgress.update({ where: { executionId: claim.id }, data: { status: 'UNKNOWN', completedAt: null } });
    arrived(); await barrier;
  });
  await arrival;
  const closing = finalizer.reconcile(f.caseId); release(); await updating;
  expect(await closing).toBe(false);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).status).toBe('EXECUTING');
  await h.prisma.resolutionExecutionProgress.update({ where: { executionId: claim.id }, data: { status: 'SUCCEEDED', completedAt: h.clock.now() } });
  expect(await finalizer.reconcile(f.caseId)).toBe(true);
  await h.command(h.actors.initiator, `/api/orders/${f.order.id}/after-sales`, { expectedOrderVersion: (await f.current()).expectedOrderVersion, previousCaseId: f.caseId, reason: '后续不同事实需要复核' }).expect(201);
});
