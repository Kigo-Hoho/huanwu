import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import * as caseReader from '../../src/after-sales/case-reader.js';
import type { AfterSalesCase } from '../../src/generated/prisma/client.js';

let h: AfterSalesHarness;
beforeAll(async () => { h = await createAfterSalesHarness(); });
afterAll(async () => { await h?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
const open = (order: { id: string; version: number }, actor = h.actors.initiator, key = randomUUID(), extra = {}) =>
  h.command(actor, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '物品存在争议，需要平台核验', ...extra }, key);
const versions = (result: { case: { version: number }; orderVersion: number }) => ({ expectedCaseVersion: result.case.version, expectedOrderVersion: result.orderVersion });
async function admin(actor = h.actors.operations) {
  const session = await h.operatorLogin(actor);
  expect(session.response.status).toBe(201);
  return {
    get: (path: string) => request(h.app.getHttpServer()).get(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie),
    post: (path: string, input: object, key = randomUUID()) => request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send(input),
    session,
  };
}
it('opens once, holds the order and caches only redacted facts with content binding', async () => {
  const order = await h.prepareOrder();
  const key = randomUUID();
  const first = await open(order, h.actors.initiator, key).expect(201);
  expect(first.body).toMatchObject({ case: { status: 'OPEN', version: 1, orderId: order.id }, orderVersion: 2 });
  expect((await open(order, h.actors.initiator, key).expect(201)).body).toEqual(first.body);
  await open(order, h.actors.initiator, key, { reason: '改变诉求' }).expect(409).expect(r => expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'));
  const stored = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(stored).toMatchObject({ status: 'ON_HOLD', holdPreviousStatus: 'AWAITING_DETAILS', version: 2 });
  expect(await h.prisma.orderHoldBlocker.count({ where: { orderId: order.id, kind: 'CASE', sourceId: first.body.case.id } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_HELD' } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: first.body.case.id, action: 'CASE_OPENED' } })).toBe(1);
  const mine = await h.get(h.actors.recipient, `/api/after-sales/${first.body.case.id}`).expect(200);
  expect(mine.body.records).toEqual([expect.objectContaining({ kind: 'OPENED', actorKind: 'CUSTOMER', side: 'INITIATOR' })]);
  expect(JSON.stringify(first.body)).not.toMatch(/credential|checkout|storageKey|openid|ciphertext/);
  await h.command(h.actors.initiator, `/api/orders/${order.id}/acceptance`, { expectedVersion: 2 }).expect(409).expect(r => expect(r.body.code).toBe('ORDER_ON_HOLD'));
  await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(200).expect(r => expect(r.body.status).toBe('ON_HOLD'));
});
it('enforces pure current customer identity and participant access before replay', async () => {
  const order = await h.prepareOrder();
  await open(order, h.actors.outsider).expect(404).expect(r => expect(r.body.code).toBe('ORDER_NOT_FOUND'));
  await open(order, h.actors.mixed).expect(403);
  const key = randomUUID();
  const first = await open(order, h.actors.initiator, key).expect(201);
  await h.get(h.actors.outsider, `/api/after-sales/${first.body.case.id}`).expect(404).expect(r => expect(r.body.code).toBe('AFTER_SALES_NOT_FOUND'));
  await h.command(h.actors.outsider, `/api/after-sales/${first.body.case.id}/response`, { ...versions(first.body), description: '第三人答复' }).expect(404);
  await h.prisma.userRole.create({ data: { userId: h.actors.initiator.id, role: 'OPERATIONS' } });
  try { await open(order, h.actors.initiator, key).expect(403); }
  finally { await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.initiator.id, role: 'OPERATIONS' } } }); }
});
it('preserves the first hold reason and appends an explicit case blocker', async () => {
  const order = await h.prepareOrder();
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'ON_HOLD', holdPreviousStatus: 'AWAITING_DETAILS', holdReason: '原物流核验', heldAt: h.clock.now(), outstandingObligations: { original: 'keep' } } });
  await open(order).expect(201);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ holdReason: '原物流核验', holdPreviousStatus: 'AWAITING_DETAILS', outstandingObligations: { original: 'keep' } });
  expect(await h.prisma.orderHoldBlocker.count({ where: { orderId: order.id, kind: 'CASE' } })).toBe(1);
});
it('accepts completion before seven days, rejects the exact boundary and flags unknown history', async () => {
  for (const [completedAt, permitted] of [[new Date(h.clock.now().getTime() - 7 * 86400000 + 1), true], [new Date(h.clock.now().getTime() - 7 * 86400000), false], [null, false]] as const) {
    const order = await h.prepareOrder();
    await h.prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED', completedAt } });
    const response = await open(order).expect(permitted ? 201 : 409);
    if (!permitted) expect(response.body.code).toBe('AFTER_SALES_NOT_ELIGIBLE');
    if (!completedAt) expect(response.body.details.manualVerificationRequired).toBe(true);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('COMPLETED');
  }
});
it('does not take later reservations or modify item versions for a historical completed order', async () => {
  const oldOrder = await h.prepareOrder({ mode: 'IN_PERSON' });
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: oldOrder.id } });
  // Owned fixture represents an imported terminal order whose listings are
  // independently available again; the later lease is acquired by real APIs.
  await h.prisma.order.update({ where: { id: oldOrder.id }, data: { status: 'COMPLETED', completedAt: h.clock.now() } });
  await h.prisma.itemReservation.deleteMany({ where: { orderId: oldOrder.id } });
  const proposal = (await h.command(h.actors.initiator, '/api/proposals', {
    offeredItemIds: snapshots.filter(s => s.side === 'INITIATOR').map(s => s.itemId), targetItemId: snapshots.find(s => s.side === 'RECIPIENT')!.itemId,
    differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0,
  }).expect(201)).body;
  const confirmed = (await h.command(h.actors.recipient, `/api/proposals/${proposal.id}/accept`, { expectedVersion: proposal.version }).expect(200)).body;
  const nextOrder = (await h.convert(confirmed).expect(201)).body.order;
  const itemsBefore = await h.prisma.item.findMany({ where: { id: { in: snapshots.map(s => s.itemId) } }, orderBy: { id: 'asc' } });
  const leasesBefore = await h.prisma.itemReservation.findMany({ where: { orderId: nextOrder.id }, orderBy: { itemId: 'asc' } });
  await open(oldOrder).expect(201);
  expect(await h.prisma.item.findMany({ where: { id: { in: snapshots.map(s => s.itemId) } }, orderBy: { id: 'asc' } })).toEqual(itemsBefore);
  expect(await h.prisma.itemReservation.findMany({ where: { orderId: nextOrder.id }, orderBy: { itemId: 'asc' } })).toEqual(leasesBefore);
  expect(await h.prisma.itemReservation.count({ where: { orderId: oldOrder.id } })).toBe(0);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: nextOrder.id } })).version).toBe(1);
});
it('refuses cancelled exchanges without an actual unresolved refund', async () => {
  const order = await h.prepareOrder();
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  await open(order).expect(409).expect(r => expect(r.body.code).toBe('AFTER_SALES_NOT_ELIGIBLE'));
});
it('accepts a cancelled refund anomaly from original payment facts without changing terminal status', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const started = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  await worker.tick();
  const paymentOrder = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  await h.command(h.actors.initiator, `/api/testing/payments/${started.body.paymentIntentId}/complete`, { expectedVersion: paymentOrder.version }).expect(200);
  const paid = await h.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  const response = await open(paid).expect(201);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  expect(await h.prisma.financialEntry.count({ where: { intentId: started.body.paymentIntentId, entryType: 'PAYMENT' } })).toBe(1);
  expect(await h.prisma.orderHoldBlocker.count({ where: { orderId: order.id } })).toBe(0);
  expect(response.body.case.status).toBe('OPEN');
});
it('does not infer a refund anomaly merely from an unrelated refund instruction', async () => {
  const order = await h.prepareOrder();
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  await h.prisma.outboxCommand.create({ data: { orderId: order.id, kind: 'REFUND_PAYMENT', businessNo: randomUUID(), payload: { paymentBusinessNo: 'unrelated' }, status: 'UNKNOWN' } });
  await open(order).expect(409).expect(r => expect(r.body.code).toBe('AFTER_SALES_NOT_ELIGIBLE'));
});
it('refuses a cancelled order once its original payment was fully refunded through the provider', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const started = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  await worker.tick();
  const current = () => h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  await h.command(h.actors.initiator, `/api/testing/payments/${started.body.paymentIntentId}/complete`, { expectedVersion: (await current()).version }).expect(200);
  const requested = await h.command(h.actors.initiator, `/api/orders/${order.id}/cancellation`, { expectedVersion: (await current()).version, reason: '未发货双方取消' }).expect(200);
  await h.command(h.actors.recipient, `/api/orders/${order.id}/cancellation/respond`, { expectedVersion: requested.body.order.version, cancellationId: requested.body.order.cancellation.id, decision: 'AGREE' }).expect(200);
  await worker.tick();
  const cancelled = await current();
  expect(cancelled.status).toBe('CANCELLED');
  expect(await h.prisma.financialEntry.count({ where: { intentId: started.body.paymentIntentId, entryType: 'REFUND' } })).toBe(1);
  await open(cancelled).expect(409).expect(r => expect(r.body.code).toBe('AFTER_SALES_NOT_ELIGIBLE'));
});
it('keeps frozen participants able to create, respond and close an otherwise safe case', async () => {
  const order = await h.prepareOrder();
  await h.prisma.tradingRestriction.update({ where: { userId: h.actors.initiator.id }, data: { status: 'FROZEN', reason: '其他交易待核验' } });
  try {
    const opened = (await open(order).expect(201)).body;
    const path = `/api/after-sales/${opened.case.id}`;
    const responded = (await h.command(h.actors.initiator, `${path}/response`, { ...versions(opened), description: '冻结期间仍补充事实' }).expect(200)).body;
    const requested = (await h.command(h.actors.initiator, `${path}/withdraw`, { ...versions(responded), reason: '请求双方撤回' }).expect(200)).body;
    const record = (await h.get(h.actors.recipient, path)).body.records.find((r: { kind: string }) => r.kind === 'WITHDRAWAL_REQUESTED');
    await h.command(h.actors.recipient, `${path}/withdraw/respond`, { ...versions(requested), withdrawalRequestId: record.id, decision: 'AGREE' }).expect(200).expect(r => expect(r.body.case.status).toBe('WITHDRAWN'));
    expect((await h.prisma.tradingRestriction.findUniqueOrThrow({ where: { userId: h.actors.initiator.id } })).status).toBe('FROZEN');
  } finally { await h.prisma.tradingRestriction.update({ where: { userId: h.actors.initiator.id }, data: { status: 'CLEAR' } }); }
});
it('returns one case snapshot when a response commits between the detail relation reads', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const original = caseReader.readCase;
  let injected = false;
  vi.spyOn(caseReader, 'readCase').mockImplementation(async (tx, id) => {
    if (id === opened.case.id && !injected) {
      injected = true;
      // Inject the real command after the real main-row SELECT, before the
      // reader fetches immutable records. Without snapshot isolation this
      // returns version 1 with the new version-2 response in its timeline.
      const model = tx.afterSalesCase as unknown as { findUnique(args: { where: { id: string } }): Promise<AfterSalesCase | null> };
      const findUnique = model.findUnique.bind(model);
      vi.spyOn(model, 'findUnique').mockImplementationOnce(async args => {
        const value = await findUnique(args);
        await h.command(h.actors.recipient, `/api/after-sales/${id}/response`, { ...versions(opened), description: '读取过程中提交的新事实' }).expect(200);
        return value;
      });
    }
    return original(tx, id);
  });
  const detail = await h.get(h.actors.initiator, `/api/after-sales/${opened.case.id}`).expect(200);
  expect(detail.body.version).toBe(1);
  expect(detail.body.records).toHaveLength(1);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).version).toBe(2);
});
it('uses bound operations sessions for evidence requests and immutable participant responses', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const path = `/api/admin/after-sales/${opened.case.id}`;
  await h.get(h.actors.operations, path).expect(401).expect(r => expect(r.body.code).toBe('REAUTH_REQUIRED'));
  const reviewer = await admin(h.actors.reviewer);
  await reviewer.get(path).expect(403);
  const ops = await admin();
  await ops.get(path).expect(200);
  const key = randomUUID();
  const input = { ...versions(opened), side: 'RECIPIENT', reason: '请补充包装与验收说明' };
  const asked = (await ops.post(`${path}/request-evidence`, input, key).expect(200)).body;
  expect(asked.case).toMatchObject({ status: 'AWAITING_RESPONSE', responseDeadline: '2026-10-12T00:00:00.000Z' });
  expect((await ops.post(`${path}/request-evidence`, input, key).expect(200)).body).toEqual(asked);
  const other = (await h.command(h.actors.initiator, `/api/after-sales/${opened.case.id}/response`, { ...versions(asked), description: '我方先追加说明' }).expect(200)).body;
  expect(other.case.status).toBe('AWAITING_RESPONSE');
  const responded = (await h.command(h.actors.recipient, `/api/after-sales/${opened.case.id}/response`, { ...versions(other), description: '按要求补充验收记录' }).expect(200)).body;
  expect(responded.case).toMatchObject({ status: 'UNDER_REVIEW', responseDeadline: null });
  await h.command(h.actors.recipient, `/api/after-sales/${opened.case.id}/response`, { ...versions(other), description: '旧版本改写' }).expect(409).expect(r => expect(r.body.code).toBe('CASE_VERSION_CONFLICT'));
  const detail = await h.get(h.actors.recipient, `/api/after-sales/${opened.case.id}`).expect(200);
  expect(detail.body.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'EVIDENCE_REQUESTED', actorKind: 'PLATFORM', side: 'RECIPIENT' }), expect.objectContaining({ description: '按要求补充验收记录', actorKind: 'CUSTOMER' })]));
  await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.operations.id, role: 'OPERATIONS' } } });
  await h.prisma.userRole.create({ data: { userId: h.actors.operations.id, role: 'REVIEWER' } });
  try { await ops.post(`${path}/request-evidence`, input, key).expect(403); }
  finally {
    await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.operations.id, role: 'REVIEWER' } } });
    await h.prisma.userRole.create({ data: { userId: h.actors.operations.id, role: 'OPERATIONS' } });
  }
});
it('requires both withdrawal confirmations, records closure and links a successor root', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const path = `/api/after-sales/${opened.case.id}`;
  const requested = (await h.command(h.actors.initiator, `${path}/withdraw`, { ...versions(opened), reason: '双方另行核验后申请撤回' }).expect(200)).body;
  expect(requested.case.status).toBe('OPEN');
  const record = (await h.get(h.actors.initiator, path)).body.records.find((r: { kind: string }) => r.kind === 'WITHDRAWAL_REQUESTED');
  await h.command(h.actors.initiator, `${path}/withdraw/respond`, { ...versions(requested), withdrawalRequestId: record.id, decision: 'AGREE' }).expect(403);
  const closed = (await h.command(h.actors.recipient, `${path}/withdraw/respond`, { ...versions(requested), withdrawalRequestId: record.id, decision: 'AGREE' }).expect(200)).body;
  expect(closed.case.status).toBe('WITHDRAWN');
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
  await h.command(h.actors.recipient, `${path}/response`, { ...versions(closed), description: '不能改写关闭工单' }).expect(409);
  const successor = (await open({ ...order, version: closed.orderVersion }, h.actors.recipient, randomUUID(), { previousCaseId: opened.case.id }).expect(201)).body;
  expect(successor.case.rootDisputeId).toBe(opened.case.rootDisputeId);
});
it('uses immutable successor associations rather than imported timestamp ordering', async () => {
  const order = await h.prepareOrder();
  // Simulate an imported closed history with a later timestamp. Metadata stays
  // immutable; all new successor commands still use the real public API.
  const previous = await h.prisma.afterSalesCase.create({ data: { orderId: order.id, applicantId: h.actors.initiator.id, reason: '历史关闭结果', status: 'WITHDRAWN', closedAt: h.clock.now(), createdAt: new Date(h.clock.now().getTime() + 1) } });
  const successor = (await open(order, h.actors.recipient, randomUUID(), { previousCaseId: previous.id }).expect(201)).body;
  const requested = (await h.command(h.actors.recipient, `/api/after-sales/${successor.case.id}/withdraw`, { ...versions(successor), reason: '撤回后续请求' }).expect(200)).body;
  const record = (await h.get(h.actors.initiator, `/api/after-sales/${successor.case.id}`)).body.records.find((r: { kind: string }) => r.kind === 'WITHDRAWAL_REQUESTED');
  const closed = (await h.command(h.actors.initiator, `/api/after-sales/${successor.case.id}/withdraw/respond`, { ...versions(requested), withdrawalRequestId: record.id, decision: 'AGREE' }).expect(200)).body;
  const third = (await open({ ...order, version: closed.orderVersion }, h.actors.initiator, randomUUID(), { previousCaseId: successor.case.id }).expect(201)).body;
  expect(third.case.rootDisputeId).toBe(previous.rootDisputeId);
});
it('records a late response at the exact deadline as manual review without granting consent', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const ops = await admin();
  const asked = (await ops.post(`/api/admin/after-sales/${opened.case.id}/request-evidence`, { ...versions(opened), side: 'RECIPIENT', reason: '等待指定一方说明' }).expect(200)).body;
  const originalTime = h.clock.now();
  h.clock.set('2026-10-12T00:00:00.000Z');
  try {
    const late = await h.command(h.actors.initiator, `/api/after-sales/${opened.case.id}/response`, { ...versions(asked), description: '期限届满后的补充' }).expect(200);
    expect(late.body.case).toMatchObject({ status: 'UNDER_REVIEW', responseDeadline: null });
    expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'RESPONSE_OVERDUE' } })).toBe(1);
    expect(await h.prisma.resolutionConsent.count()).toBe(0);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
  } finally { h.clock.set(originalTime); }
});
it('rejects an ordinary case with an immutable platform reason and no order recovery', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const ops = await admin();
  const path = `/api/admin/after-sales/${opened.case.id}/reject`;
  const input = { ...versions(opened), reason: '已核验不属于本工单请求范围' };
  const key = randomUUID();
  const closed = await ops.post(path, input, key).expect(200);
  expect(closed.body.case.status).toBe('REJECTED');
  expect((await ops.post(path, input, key).expect(200)).body).toEqual(closed.body);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
  expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'REJECTED', description: input.reason } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: opened.case.id, action: 'CASE_REJECTED' } })).toBe(1);
  await h.prisma.operatorSession.update({ where: { id: ops.session.response.body.operatorSession.id }, data: { revokedAt: h.clock.now() } });
  await ops.post(path, input, key).expect(401);
  await ops.get(`/api/admin/after-sales/${opened.case.id}`).expect(401);
});
it('blocks withdrawal closure when a live risk or pending external operation remains', async () => {
  for (const blocker of ['risk', 'funds'] as const) {
    const order = await h.prepareOrder();
    const opened = (await open(order).expect(201)).body;
    if (blocker === 'risk') await h.prisma.riskTask.create({ data: { orderId: order.id, sourceKey: randomUUID(), kind: 'LOGISTICS_EXCEPTION', description: '人工核验尚未完成' } });
    else await h.prisma.outboxCommand.create({ data: { orderId: order.id, kind: 'REFUND_PAYMENT', businessNo: randomUUID(), payload: {}, status: 'UNKNOWN' } });
    const path = `/api/after-sales/${opened.case.id}`;
    const requested = (await h.command(h.actors.initiator, `${path}/withdraw`, { ...versions(opened), reason: '申请撤回' }).expect(200)).body;
    const record = (await h.get(h.actors.initiator, path)).body.records.find((r: { kind: string }) => r.kind === 'WITHDRAWAL_REQUESTED');
    const response = await h.command(h.actors.recipient, `${path}/withdraw/respond`, { ...versions(requested), withdrawalRequestId: record.id, decision: 'AGREE' }).expect(409);
    expect(response.body.code).toBe(blocker === 'risk' ? 'RISK_BLOCKS_RESUME' : 'FUNDS_UNRESOLVED');
    expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).closedAt).toBeNull();
  }
});
it('keeps a predecessor risk attached to its root dispute when closing a successor', async () => {
  const order = await h.prepareOrder();
  const previous = await h.prisma.afterSalesCase.create({ data: { orderId: order.id, applicantId: h.actors.initiator.id, reason: '历史关闭结果', status: 'WITHDRAWN', closedAt: h.clock.now() } });
  await h.prisma.riskTask.create({ data: { caseId: previous.id, sourceKey: randomUUID(), kind: 'REQUIRES_VERIFICATION', description: '关联根争议仍待核验' } });
  const opened = (await open(order, h.actors.initiator, randomUUID(), { previousCaseId: previous.id }).expect(201)).body;
  const path = `/api/after-sales/${opened.case.id}`;
  const requested = (await h.command(h.actors.initiator, `${path}/withdraw`, { ...versions(opened), reason: '申请撤回后续工单' }).expect(200)).body;
  const record = (await h.get(h.actors.initiator, path)).body.records.find((r: { kind: string }) => r.kind === 'WITHDRAWAL_REQUESTED');
  await h.command(h.actors.recipient, `${path}/withdraw/respond`, { ...versions(requested), withdrawalRequestId: record.id, decision: 'AGREE' }).expect(409).expect(r => expect(r.body.code).toBe('RISK_BLOCKS_RESUME'));
});
it.each(['execution', 'return', 'compensation', 'predecessor-return', 'completed-execution', 'completed-return', 'completed-compensation', 'completed-refund', 'completed-transfer', 'inconsistent-closed-compensation'] as const)('handles the stored completion facts of %s before withdrawal', async obligationKind => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const previous = obligationKind === 'predecessor-return' ? await h.prisma.afterSalesCase.create({ data: { orderId: order.id, applicantId: h.actors.initiator.id, reason: '历史未核清的关闭记录', status: 'REJECTED', closedAt: h.clock.now() } }) : null;
  const opened = (await open(order, h.actors.initiator, randomUUID(), previous ? { previousCaseId: previous.id } : {}).expect(201)).body;
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: order.id } });
  const resolution = await h.prisma.resolutionVersion.create({ data: {
    caseId: previous?.id ?? opened.case.id, number: 1, authorId: h.actors.operations.id, type: 'FUNDS_ONLY', reason: '人工核验原款义务', rulesVersion: 'phase4-simulation-v1',
    itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'UNDETERMINED', originalFunds: [], returnPlan: [],
    compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: 100, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 },
    netCompensationFen: 100, compensationPayer: 'INITIATOR', orderOutcome: 'PRESERVE_TERMINAL',
  } });
  if (['execution', 'completed-execution'].includes(obligationKind)) await h.prisma.resolutionExecution.create({ data: { resolutionId: resolution.id, executionStep: 'pending', action: 'VERIFY_ORIGINAL_FUNDS', ...(obligationKind === 'completed-execution' ? { progress: { create: { status: 'SUCCEEDED', completedAt: h.clock.now(), result: { verified: true } } } } : {}) } });
  if (['return', 'predecessor-return', 'completed-return'].includes(obligationKind)) await h.prisma.returnObligation.create({ data: { resolutionId: resolution.id, itemSnapshotId: snapshots[0].id, holderSide: snapshots[0].side === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR', ownerSide: snapshots[0].side, deliveryMode: 'IN_PERSON', registrationDeadline: new Date(h.clock.now().getTime() + 72 * 3600000), ...(obligationKind === 'completed-return' ? { progress: { create: { status: 'CONFIRMED', confirmedAt: h.clock.now() } }, events: { create: { actorId: snapshots[0].ownerId, kind: 'CONFIRMED', occurredAt: h.clock.now() } } } : {}) } });
  if (['compensation', 'completed-compensation'].includes(obligationKind)) await h.prisma.compensationObligation.create({ data: { resolutionId: resolution.id, rootDisputeId: opened.case.rootDisputeId, executionStep: 'net', payerSide: 'INITIATOR', payeeSide: 'RECIPIENT', amountFen: 100, paymentDeadline: new Date(h.clock.now().getTime() + 72 * 3600000), ...(obligationKind === 'completed-compensation' ? { progress: { create: { status: 'CLOSED', completedAt: h.clock.now() } } } : {}) } });
  if (['completed-refund', 'completed-transfer', 'inconsistent-closed-compensation'].includes(obligationKind)) {
    const refund = obligationKind === 'completed-refund';
    const inconsistent = obligationKind === 'inconsistent-closed-compensation';
    const obligation = await h.prisma.compensationObligation.create({ data: { resolutionId: resolution.id, rootDisputeId: opened.case.rootDisputeId, executionStep: 'net', payerSide: 'INITIATOR', payeeSide: 'RECIPIENT', amountFen: 100, paymentDeadline: h.clock.now(), progress: { create: { status: inconsistent ? 'CLOSED' : refund ? 'REFUNDED' : 'TRANSFERRED', completedAt: h.clock.now() } } } });
    const payment = await h.prisma.compensationPayment.create({ data: { obligationId: obligation.id, businessNo: randomUUID(), provider: 'simulated', amountFen: 100, status: refund ? 'REFUNDED' : 'PAID', paidAt: h.clock.now(), ...(inconsistent ? {} : refund ? { refundedAt: h.clock.now() } : { transferredAt: h.clock.now() }) } });
    for (const entryType of (inconsistent ? ['COLLECTION'] : ['COLLECTION', refund ? 'REFUND' : 'TRANSFER']) as ('COLLECTION' | 'REFUND' | 'TRANSFER')[]) {
      await h.prisma.compensationFinancialEntry.create({ data: { paymentId: payment.id, entryType, provider: 'simulated', externalTransactionId: randomUUID(), businessNo: randomUUID(), amountFen: 100, occurredAt: h.clock.now() } });
    }
  }
  const path = `/api/after-sales/${opened.case.id}`;
  const requested = (await h.command(h.actors.initiator, `${path}/withdraw`, { ...versions(opened), reason: '请求停止后续处置' }).expect(200)).body;
  const record = (await h.get(h.actors.initiator, path)).body.records.find((r: { kind: string }) => r.kind === 'WITHDRAWAL_REQUESTED');
  const completed = obligationKind.startsWith('completed-');
  const response = await h.command(h.actors.recipient, `${path}/withdraw/respond`, { ...versions(requested), withdrawalRequestId: record.id, decision: 'AGREE' }).expect(completed ? 200 : 409);
  if (completed) expect(response.body.case.status).toBe('WITHDRAWN');
  else {
    expect(response.body.code).toBe('FUNDS_UNRESOLVED');
    expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).closedAt).toBeNull();
  }
});
it('lists only own cases using stable twenty-row pages and rejects invalid query input', async () => {
  for (let i = 0; i < 22; i++) await open(await h.prepareOrder()).expect(201);
  const first = await h.get(h.actors.initiator, '/api/after-sales').expect(200);
  expect(first.body.items).toHaveLength(20);
  expect(first.body.nextCursor).toEqual(expect.any(String));
  const second = await h.get(h.actors.initiator, `/api/after-sales?cursor=${first.body.nextCursor}`).expect(200);
  expect(second.body.items.some((r: { id: string }) => first.body.items.some((a: { id: string }) => a.id === r.id))).toBe(false);
  await h.get(h.actors.outsider, '/api/after-sales').expect(200).expect(r => expect(r.body.items).toEqual([]));
  for (const query of ['limit=51', 'cursor=garbage', 'unknown=1']) await h.get(h.actors.initiator, `/api/after-sales?${query}`).expect(400).expect(r => expect(r.body.code).toBe('VALIDATION_FAILED'));
});
