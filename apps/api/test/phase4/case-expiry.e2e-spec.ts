import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { createCompensationHarness, type CompensationHarness } from './support/compensation-harness.js';
import { CaseExpiryService } from '../../src/after-sales/case-expiry.service.js';
import { CaseExpiryScheduler } from '../../src/after-sales/case-expiry.scheduler.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { CaseCommandsService } from '../../src/after-sales/case-commands.service.js';
import type { CaseMutationContext, LockedCase } from '../../src/after-sales/case.types.js';
import type { AuthenticatedUser } from '../../src/auth/auth.service.js';

let h: AfterSalesHarness;
let funds: CompensationHarness;
beforeAll(async () => {
  h = await createAfterSalesHarness();
  funds = await createCompensationHarness();
});
afterAll(async () => { await funds?.close(); await h?.close(); });
afterEach(() => vi.restoreAllMocks());

const open = (order: { id: string; version: number }, actor = h.actors.initiator) =>
  h.command(actor, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '期限核验争议' });
const versions = (result: { case: { version: number }; orderVersion: number }) => ({ expectedCaseVersion: result.case.version, expectedOrderVersion: result.orderVersion });
async function admin(actor: AuthenticatedUser = h.actors.operations) {
  const session = await h.operatorLogin(actor);
  expect(session.response.status).toBe(201);
  return {
    post: (path: string, input: object, key = randomUUID()) =>
      request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send(input),
  };
}
async function proposeContinue(opened: { case: { id: string; version: number }; orderVersion: number }, orderId: string) {
  const ops = await admin();
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId } });
  return (await ops.post(`/api/admin/after-sales/${opened.case.id}/resolutions`, {
    ...versions(opened), resolutionVersion: 1, type: 'CONTINUE_EXCHANGE', reason: '继续履约核验', rulesVersion: 'phase4-simulation-v1',
    evidenceIds: [], itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'NONE', originalFunds: [], returnPlan: [],
    compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: 0, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 },
    netCompensation: { amountFen: 0, payer: 'NONE' }, orderOutcome: 'RESUME',
  }).expect(200)).body;
}
type Planner = { planInTransaction(ctx: CaseMutationContext, resolution: LockedCase['resolutions'][number]): Promise<void> };
async function planReturn(caseId: string, resolutionId: string, expectedCaseVersion: number, expectedOrderVersion: number) {
  const planner = h.app.get<Map<string, Planner>>('RESOLUTION_EXECUTORS').get('RETURN_ORIGINALS');
  expect(planner).toBeDefined();
  return h.app.get(CaseCommandsService).run({ actor: h.actors.initiator, caseId, input: { expectedCaseVersion, expectedOrderVersion }, key: randomUUID(), commandName: 'TASK11_TEST_PLAN' }, async ctx => {
    await planner!.planInTransaction(ctx, ctx.case.resolutions[0]);
    await ctx.tx.resolutionExecution.create({ data: { resolutionId, executionStep: 'START', action: 'EXECUTE_FUNDS', actorId: h.actors.superAdminOne.id, progress: { create: { status: 'PENDING' } } } });
    await ctx.tx.afterSalesCase.update({ where: { id: caseId }, data: { status: 'EXECUTING' } });
  });
}
async function returnFixture(mode: 'COURIER' | 'IN_PERSON' = 'COURIER') {
  const order = await h.prepareOrder({ mode, offeredCount: 2 });
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'AWAITING_FULFILLMENT', detailsDeadline: null } });
  for (const side of ['INITIATOR', 'RECIPIENT'] as const) {
    if (mode === 'COURIER') {
      const id = randomUUID();
      await h.prisma.shipment.create({ data: { id, orderId: order.id, side, carrier: 'SF', trackingNumber: randomUUID(), businessNo: `shipment:${id}`, status: 'DELIVERED', deliveredAt: h.clock.now() } });
    } else {
      await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side } }, data: { handedOverAt: h.clock.now() } });
    }
  }
  const opened = (await open(order).expect(201)).body;
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
  const resolution = await h.prisma.resolutionVersion.create({ data: {
    caseId: opened.case.id, number: 1, authorId: h.actors.operations.id, type: 'RETURN_ORIGINALS', reason: '退回原物', rulesVersion: 'phase4-simulation-v1',
    evidenceIds: [], itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'NONE', originalFunds: [],
    returnPlan: snapshots.map(s => ({ itemSnapshotId: s.id, outcome: 'RETURN_ORIGINAL' })),
    compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: 0, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 },
    netCompensationFen: 0, compensationPayer: 'NONE', orderOutcome: 'CANCEL',
  } });
  await h.prisma.afterSalesCase.update({ where: { id: opened.case.id }, data: { currentResolutionVersion: 1, status: 'AWAITING_AGREEMENT', version: 2 } });
  if (mode === 'COURIER') {
    const address = { recipientName: '归还地址', phone: '13812345678', region: '测试省测试市测试区', detail: '测试街道一号' };
    for (const actor of [h.actors.initiator, h.actors.recipient]) {
      await h.command(actor, `/api/after-sales/${opened.case.id}/return-address`, { expectedCaseVersion: (await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).version, expectedOrderVersion: (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version, resolutionVersion: 1, ...address }).expect(200);
    }
  }
  const planned = await planReturn(opened.case.id, resolution.id, (await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).version, (await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version);
  return { order, caseId: opened.case.id as string, resolution, planned };
}

it('keeps response open one millisecond before the inclusive 72h boundary', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const ops = await admin();
  const asked = (await ops.post(`/api/admin/after-sales/${opened.case.id}/request-evidence`, { ...versions(opened), side: 'RECIPIENT', reason: '请补充签收说明' }).expect(200)).body;
  h.clock.set(new Date(new Date(asked.case.responseDeadline).getTime() - 1));
  await h.app.get(CaseExpiryService).reconcile(opened.case.id);
  expect(await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).toMatchObject({ status: 'AWAITING_RESPONSE', version: asked.case.version });
  expect(await h.prisma.riskTask.count({ where: { caseId: opened.case.id } })).toBe(0);
  expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'RESPONSE_OVERDUE' } })).toBe(0);
});

it('transitions evidence response to UNDER_REVIEW at the exact deadline without consent or release', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const ops = await admin();
  const asked = (await ops.post(`/api/admin/after-sales/${opened.case.id}/request-evidence`, { ...versions(opened), side: 'RECIPIENT', reason: '请补充签收说明' }).expect(200)).body;
  const holds = await h.prisma.itemReservation.count({ where: { orderId: order.id } });
  h.clock.set(new Date(asked.case.responseDeadline));
  await h.app.get(CaseExpiryService).reconcile(opened.case.id);
  expect(await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).toMatchObject({ status: 'UNDER_REVIEW', responseDeadline: null, responseSide: null });
  expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'RESPONSE_OVERDUE', actorId: null } })).toBe(1);
  expect(await h.prisma.riskTask.count({ where: { caseId: opened.case.id, kind: 'RESPONSE_OVERDUE', status: 'OPEN' } })).toBe(1);
  expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: opened.case.id } } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(holds);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
});

it('transitions agreement response to UNDER_REVIEW at the exact deadline without inventing consent', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const proposed = await proposeContinue(opened, order.id);
  const deadline = new Date(proposed.case.agreementDeadline);
  h.clock.set(new Date(deadline.getTime() - 1));
  await h.app.get(CaseExpiryService).reconcile(opened.case.id);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).status).toBe('AWAITING_AGREEMENT');
  h.clock.set(deadline);
  await h.app.get(CaseExpiryService).reconcile(opened.case.id);
  expect(await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).toMatchObject({ status: 'UNDER_REVIEW', agreementDeadline: null });
  expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'AGREEMENT_OVERDUE', actorId: null } })).toBe(1);
  expect(await h.prisma.riskTask.count({ where: { caseId: opened.case.id, kind: 'AGREEMENT_OVERDUE' } })).toBe(1);
  expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: opened.case.id } } })).toBe(0);
});

it('lets a write command detect overdue agreement without the scheduler and keeps the reconcile durable after conflict', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const proposed = await proposeContinue(opened, order.id);
  const key = randomUUID();
  h.clock.set(new Date(proposed.case.agreementDeadline));
  await h.command(h.actors.initiator, `/api/after-sales/${opened.case.id}/consent`, { ...versions(proposed), resolutionVersion: 1, decision: 'AGREE' }, key)
    .expect(409).expect(r => expect(r.body.code).toBe('AFTER_SALES_NOT_ELIGIBLE'));
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect(await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).toMatchObject({ status: 'UNDER_REVIEW', agreementDeadline: null });
  expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'AGREEMENT_OVERDUE' } })).toBe(1);
  expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: opened.case.id } } })).toBe(0);
});

it('coalesces repeated scheduler ticks into a single overdue task and audit for the same deadline', async () => {
  const order = await h.prepareOrder();
  const opened = (await open(order).expect(201)).body;
  const ops = await admin();
  const asked = (await ops.post(`/api/admin/after-sales/${opened.case.id}/request-evidence`, { ...versions(opened), side: 'RECIPIENT', reason: '补证' }).expect(200)).body;
  h.clock.set(new Date(asked.case.responseDeadline));
  const scheduler = new CaseExpiryScheduler(h.app.get(CaseExpiryService));
  const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
    const result = await original(tx, entry);
    if (entry.action === 'CASE_RESPONSE_OVERDUE' && entry.entityId === opened.case.id) { enter(); await released; }
    return result;
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(59999);
    expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).status).toBe('AWAITING_RESPONSE');
    await vi.advanceTimersByTimeAsync(1); await entered;
    const tick = scheduler.tick(); expect(scheduler.tick()).toBe(tick);
    let closed = false; const closing = scheduler.onModuleDestroy().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); release(); await closing; await tick;
    expect(closed).toBe(true);
    expect(await h.prisma.riskTask.count({ where: { caseId: opened.case.id, kind: 'RESPONSE_OVERDUE' } })).toBe(1);
    expect(await h.prisma.caseRecord.count({ where: { caseId: opened.case.id, kind: 'RESPONSE_OVERDUE' } })).toBe(1);
    expect(await h.prisma.auditLog.count({ where: { entityId: opened.case.id, action: 'CASE_RESPONSE_OVERDUE' } })).toBe(1);
    await vi.advanceTimersByTimeAsync(120000); await scheduler.tick();
    expect(await h.prisma.riskTask.count({ where: { caseId: opened.case.id, kind: 'RESPONSE_OVERDUE' } })).toBe(1);
    expect(await h.prisma.auditLog.count({ where: { entityId: opened.case.id, action: 'CASE_RESPONSE_OVERDUE' } })).toBe(1);
  } finally { release(); await scheduler.onModuleDestroy(); vi.useRealTimers(); }
});

it('raises deduped risk tasks for return registration, receipt, transit and compensation deadlines without releasing or auto-confirming', async () => {
  const f = await funds.fixture({ type: 'KEEP_WITH_COMPENSATION', amount: 500 });
  await f.execute();
  const obligation = await funds.prisma.compensationObligation.findFirstOrThrow({ where: { resolution: { caseId: f.caseId } } });
  const ret = await returnFixture('COURIER');
  const returns = await h.prisma.returnObligation.findMany({ where: { resolutionId: ret.resolution.id }, include: { progress: true }, orderBy: { id: 'asc' } });
  expect(returns.length).toBeGreaterThanOrEqual(2);
  const delivered = returns[0]!;
  const transit = returns[1]!;
  await h.prisma.returnProgress.update({ where: { obligationId: delivered.id }, data: { status: 'DELIVERED', handedOverAt: h.clock.now(), receiptDeadline: new Date(h.clock.now().getTime() + 72 * 3600000) } });
  const shipmentId = randomUUID();
  await h.prisma.returnShipment.create({ data: { id: shipmentId, resolutionId: ret.resolution.id, holderSide: transit.holderSide, ownerSide: transit.ownerSide, carrier: 'SF', trackingNumber: randomUUID(), businessNo: `return:shipment:${shipmentId}`, status: 'COLLECTED', registeredAt: h.clock.now(), collectedAt: h.clock.now() } });
  await h.prisma.returnShipmentItem.create({ data: { shipmentId, obligationId: transit.id } });
  await h.prisma.returnProgress.update({ where: { obligationId: transit.id }, data: { status: 'COLLECTED' } });
  const registrationDeadline = returns.find(r => r.progress?.status === 'PENDING')!.registrationDeadline;
  const receiptDeadline = (await h.prisma.returnProgress.findUniqueOrThrow({ where: { obligationId: delivered.id } })).receiptDeadline!;
  const collectedAt = (await h.prisma.returnShipment.findUniqueOrThrow({ where: { id: shipmentId } })).collectedAt!;
  const due = new Date(Math.max(registrationDeadline.getTime(), receiptDeadline.getTime(), collectedAt.getTime() + 7 * 86400000, obligation.paymentDeadline.getTime()));
  h.clock.set(due);
  funds.clock.set(due);
  await h.app.get(CaseExpiryService).reconcile(ret.caseId);
  await funds.app.get(CaseExpiryService).reconcile(f.caseId);
  await h.app.get(CaseExpiryService).reconcile(ret.caseId);
  await funds.app.get(CaseExpiryService).reconcile(f.caseId);
  expect(await h.prisma.riskTask.count({ where: { caseId: ret.caseId, kind: 'RETURN_REGISTRATION_OVERDUE' } })).toBeGreaterThanOrEqual(1);
  expect(await h.prisma.riskTask.count({ where: { caseId: ret.caseId, kind: 'RETURN_RECEIPT_OVERDUE' } })).toBe(1);
  expect(await h.prisma.riskTask.count({ where: { caseId: ret.caseId, kind: 'RETURN_TRANSIT_OVERDUE' } })).toBe(1);
  expect(await funds.prisma.riskTask.count({ where: { caseId: f.caseId, kind: 'COMPENSATION_PAYMENT_OVERDUE' } })).toBe(1);
  expect((await h.prisma.returnProgress.findUniqueOrThrow({ where: { obligationId: delivered.id } })).status).toBe('DELIVERED');
  expect(await h.prisma.returnObligation.count({ where: { resolutionId: ret.resolution.id, progress: { status: 'PENDING' } } })).toBeGreaterThanOrEqual(1);
  expect(await funds.prisma.financialEntry.count({ where: { intent: { orderId: f.order.id } } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { orderId: ret.order.id } })).toBeGreaterThan(0);
  expect((await funds.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).status).toBe('EXECUTING');
});

it('skips closed and already-resolved CONTINUE cases without new催办', async () => {
  for (const status of ['RESOLVED', 'WITHDRAWN', 'REJECTED'] as const) {
    const order = await h.prepareOrder();
    const opened = (await open(order).expect(201)).body;
    await h.prisma.afterSalesCase.update({ where: { id: opened.case.id }, data: { status, closedAt: h.clock.now(), responseDeadline: h.clock.now(), agreementDeadline: h.clock.now() } });
    const before = await h.prisma.riskTask.count({ where: { caseId: opened.case.id } });
    const audits = await h.prisma.auditLog.count({ where: { entityId: opened.case.id } });
    await h.app.get(CaseExpiryService).reconcile(opened.case.id);
    expect(await h.prisma.riskTask.count({ where: { caseId: opened.case.id } })).toBe(before);
    expect(await h.prisma.auditLog.count({ where: { entityId: opened.case.id } })).toBe(audits);
    expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).status).toBe(status);
  }
});

it('still accepts a late trusted return confirmation after receipt overdue and does not reopen by client time', async () => {
  const ret = await returnFixture('IN_PERSON');
  const holderObs = await h.prisma.returnObligation.findMany({ where: { resolutionId: ret.resolution.id, holderSide: 'RECIPIENT' }, include: { progress: true } });
  expect(holderObs.length).toBeGreaterThan(0);
  const target = holderObs[0]!;
  await h.prisma.returnProgress.update({ where: { obligationId: target.id }, data: { status: 'DELIVERED', handedOverAt: h.clock.now(), receiptDeadline: new Date(h.clock.now().getTime() + 72 * 3600000), version: { increment: 1 } } });
  const receiptDeadline = (await h.prisma.returnProgress.findUniqueOrThrow({ where: { obligationId: target.id } })).receiptDeadline!;
  h.clock.set(receiptDeadline);
  await h.app.get(CaseExpiryService).reconcile(ret.caseId);
  expect(await h.prisma.riskTask.count({ where: { caseId: ret.caseId, kind: 'RETURN_RECEIPT_OVERDUE', sourceKey: `return:${target.id}:receipt-overdue` } })).toBe(1);
  const current = await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: ret.caseId } });
  const order = await h.prisma.order.findUniqueOrThrow({ where: { id: ret.order.id } });
  const progress = await h.prisma.returnProgress.findUniqueOrThrow({ where: { obligationId: target.id } });
  await h.command(h.actors.initiator, `/api/after-sales/${ret.caseId}/returns/confirmation`, {
    expectedCaseVersion: current.version, expectedOrderVersion: order.version, resolutionVersion: 1,
    obligationId: target.id, expectedObligationVersion: progress.version, decision: 'CONFIRM',
  }).expect(200);
  expect((await h.prisma.returnProgress.findUniqueOrThrow({ where: { obligationId: target.id } })).status).toBe('CONFIRMED');
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: ret.caseId } })).status).not.toBe('AWAITING_AGREEMENT');
});
