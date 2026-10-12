import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import type { CaseCommandResult, ResolutionInput } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { operatorRequestHash } from '../../src/operator-security/operator-action.types.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';

let h: AfterSalesHarness;
beforeAll(async () => { h = await createAfterSalesHarness(); });
afterAll(async () => { await h?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
const versions = (r: CaseCommandResult) => ({ expectedCaseVersion: r.case.version, expectedOrderVersion: r.orderVersion });
const zero = () => ({ originalDifferenceReversal: { amountFen: 0, payer: 'NONE' as const }, initiatorExtraFen: 0, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 });
async function fixture(prepared?: { id: string; version: number }) {
  const order = prepared ?? await h.prepareOrder({ mode: 'IN_PERSON' });
  const opened: CaseCommandResult = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '物品争议，请平台处理' }).expect(201)).body;
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
  const input: ResolutionInput = { ...versions(opened), resolutionVersion: 1, type: 'KEEP_WITH_COMPENSATION', reason: '双方保留物品，独立确认后完成', rulesVersion: 'phase4-simulation-v1', evidenceIds: [], itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'NONE', originalFunds: [], returnPlan: [], compensationComponents: zero(), netCompensation: { amountFen: 0, payer: 'NONE' }, orderOutcome: 'COMPLETE' };
  return { order, opened, snapshots, input, path: `/api/admin/after-sales/${opened.case.id}/resolutions` };
}
async function operator(actor = h.actors.operations) {
  const session = await h.operatorLogin(actor);
  expect(session.response.status).toBe(201);
  return { session, post: (path: string, input: object, key = randomUUID()) => request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send(input) };
}
async function storedResolution(f: Awaited<ReturnType<typeof fixture>>) {
  return h.prisma.resolutionVersion.create({ data: { caseId: f.opened.case.id, number: 1, authorId: h.actors.operations.id, type: f.input.type, reason: f.input.reason, rulesVersion: f.input.rulesVersion, evidenceIds: [], itemSnapshotIds: f.input.itemSnapshotIds, responsibility: 'NONE', originalFunds: [], returnPlan: [], compensationComponents: zero(), netCompensationFen: 0, compensationPayer: 'NONE', orderOutcome: 'COMPLETE' } });
}

it('rejects SQL NULL for a REJECT consent even when HTTP validation is bypassed', async () => {
  const f = await fixture();
  const resolution = await storedResolution(f);
  // All foreign keys, side and decision are valid. Only the SQL NULL reason
  // violates the intended invariant; the pre-fix CHECK accepts UNKNOWN.
  await expect(h.prisma.$executeRaw`INSERT INTO "ResolutionConsent" (id,"resolutionId","actorId",side,decision,reason) VALUES (${randomUUID()}::uuid,${resolution.id}::uuid,${h.actors.initiator.id}::uuid,'INITIATOR','REJECT',NULL)`).rejects.toThrow(/check constraint/i);
});
it.each(['CONTINUE_EXCHANGE', 'RETURN_ORIGINALS', 'CANCEL_BEFORE_HANDOVER'] as const)('stores an explicit %s plan with complete snapshot obligations', async type => {
  const f = await fixture(); const ops = await operator();
  const input = { ...f.input, type, orderOutcome: type === 'CONTINUE_EXCHANGE' ? 'RESUME' : 'CANCEL', returnPlan: type === 'CONTINUE_EXCHANGE' ? [] : f.snapshots.map(s => ({ itemSnapshotId: s.id, outcome: 'UNDELIVERED' })) };
  await ops.post(f.path, input).expect(200);
  expect(await h.prisma.resolutionVersion.findFirst({ where: { caseId: f.opened.case.id } })).toMatchObject({ type, orderOutcome: input.orderOutcome, returnPlan: input.returnPlan });
  expect(await h.prisma.returnObligation.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
});
it('derives complete original-funds targets and permits equal offsets only with payer NONE', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON', differenceFen: 5000, payer: 'INITIATOR' });
  const current = () => h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const payments: { id: string; purpose: string }[] = [];
  for (const [actor, purpose] of [[h.actors.initiator, 'DEPOSIT'], [h.actors.recipient, 'DEPOSIT'], [h.actors.initiator, 'DIFFERENCE']] as const) {
    const payment = await h.command(actor, `/api/orders/${order.id}/payments`, { expectedVersion: (await current()).version, purpose }).expect(202);
    payments.push({ id: payment.body.paymentIntentId, purpose });
  }
  const f = await fixture(await current()); const ops = await operator();
  const originalFunds = payments.map(p => ({ paymentIntentId: p.id, destination: p.purpose === 'DEPOSIT' ? 'REFUND_PAYER' : 'SETTLE_BENEFICIARY' }));
  const input = { ...f.input, originalFunds, compensationComponents: { ...zero(), initiatorExtraFen: 20000, recipientShippingFen: 20000 } };
  await ops.post(f.path, { ...input, originalFunds: originalFunds.slice(1) }).expect(400);
  await ops.post(f.path, { ...input, originalFunds: originalFunds.map(p => ({ ...p, destination: 'SETTLE_BENEFICIARY' })) }).expect(400);
  await ops.post(f.path, { ...input, compensationComponents: { ...zero(), originalDifferenceReversal: { amountFen: 5000, payer: 'RECIPIENT' } }, netCompensation: { amountFen: 5000, payer: 'RECIPIENT' } }).expect(400);
  await ops.post(f.path, input).expect(200);
  const stored = await h.prisma.resolutionVersion.findFirstOrThrow({ where: { caseId: f.opened.case.id } });
  expect(stored).toMatchObject({ netCompensationFen: 0, compensationPayer: 'NONE' });
  expect(stored.originalFunds).toEqual(expect.arrayContaining(originalFunds));
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: order.id } } })).toBe(0);
});
it('reverses only the settled difference beneficiary and supports the 60000 inclusive net limit', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON', differenceFen: 20000, payer: 'INITIATOR' });
  const current = () => h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  const dispatchAvailable = async () => {
    const count = await h.prisma.outboxCommand.count({ where: { status: { in: ['PENDING', 'UNKNOWN'] }, availableAt: { lte: h.clock.now() } } });
    for (let i = 0; i < count; i++) await worker.tick();
  };
  for (const [actor, purpose] of [[h.actors.initiator, 'DEPOSIT'], [h.actors.recipient, 'DEPOSIT'], [h.actors.initiator, 'DIFFERENCE']] as const) {
    const payment = await h.command(actor, `/api/orders/${order.id}/payments`, { expectedVersion: (await current()).version, purpose }).expect(202);
    await dispatchAvailable();
    await h.command(actor, `/api/testing/payments/${payment.body.paymentIntentId}/complete`, { expectedVersion: (await current()).version }).expect(200);
  }
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${order.id}/handover`, { expectedVersion: (await current()).version }).expect(200);
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${order.id}/acceptance`, { expectedVersion: (await current()).version }).expect(200);
  await dispatchAvailable();
  expect((await current()).status).toBe('COMPLETED');
  const f = await fixture(await current()); const ops = await operator();
  const payments = await h.prisma.paymentIntent.findMany({ where: { orderId: order.id } });
  const originalFunds = payments.map(p => ({ paymentIntentId: p.id, destination: p.purpose === 'DEPOSIT' ? 'REFUND_PAYER' : 'SETTLE_BENEFICIARY' }));
  const components = { ...zero(), originalDifferenceReversal: { amountFen: 20000, payer: 'RECIPIENT' }, recipientExtraFen: 20000, recipientShippingFen: 20000 };
  const input = { ...f.input, type: 'FUNDS_ONLY', orderOutcome: 'PRESERVE_TERMINAL', originalFunds, compensationComponents: components, netCompensation: { amountFen: 60000, payer: 'RECIPIENT' } };
  await ops.post(f.path, { ...input, compensationComponents: { ...components, originalDifferenceReversal: { amountFen: 20000, payer: 'INITIATOR' } }, netCompensation: { amountFen: 20000, payer: 'RECIPIENT' } }).expect(400);
  await ops.post(f.path, { ...input, originalFunds: payments.map(p => ({ paymentIntentId: p.id, destination: 'REFUND_PAYER' })) }).expect(400);
  await ops.post(f.path, input).expect(200);
  expect(await h.prisma.resolutionVersion.findFirst({ where: { caseId: f.opened.case.id } })).toMatchObject({ netCompensationFen: 60000, compensationPayer: 'RECIPIENT' });
  expect((await current()).status).toBe('COMPLETED');
  expect(await h.prisma.compensationObligation.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
});
it('requires return coverage and never marks registered shipments or handovers as undelivered', async () => {
  const f = await fixture(); const ops = await operator();
  await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: f.order.id, side: 'INITIATOR' } }, data: { handedOverAt: h.clock.now() } });
  const input = { ...f.input, type: 'RETURN_ORIGINALS', orderOutcome: 'CANCEL', returnPlan: f.snapshots.map(s => ({ itemSnapshotId: s.id, outcome: s.side === 'INITIATOR' ? 'RETURN_ORIGINAL' : 'UNDELIVERED' })) };
  await ops.post(f.path, { ...input, returnPlan: input.returnPlan.slice(1) }).expect(400);
  await ops.post(f.path, { ...input, returnPlan: input.returnPlan.map(p => ({ ...p, outcome: 'UNDELIVERED' })) }).expect(400);
  await ops.post(f.path, { ...input, type: 'CANCEL_BEFORE_HANDOVER' }).expect(409);
  await ops.post(f.path, input).expect(200);
});
it('rejects a new consent at the exact response deadline and keeps successful retries idempotent', async () => {
  const f = await fixture(); const ops = await operator(); const proposed = (await ops.post(f.path, f.input).expect(200)).body;
  const path = `/api/after-sales/${f.opened.case.id}/consent`; const input = { ...versions(proposed), resolutionVersion: 1, decision: 'AGREE' }; const key = randomUUID();
  const consented = (await h.command(h.actors.initiator, path, input, key).expect(200)).body;
  const originalTime = h.clock.now();
  try {
    h.clock.set('2026-10-12T00:00:00.000Z');
    await h.command(h.actors.recipient, path, { ...versions(consented), resolutionVersion: 1, decision: 'AGREE' }).expect(409);
    expect((await h.command(h.actors.initiator, path, input, key).expect(200)).body).toEqual(consented);
    expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(1);
  } finally { h.clock.set(originalTime); }
});
it('serializes concurrent proposals against the same case and order versions', async () => {
  const f = await fixture(); const ops = await operator();
  const results = await Promise.all([ops.post(f.path, f.input), ops.post(f.path, { ...f.input, reason: '另一份并发方案' })]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await h.prisma.resolutionVersion.count({ where: { caseId: f.opened.case.id } })).toBe(1);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.opened.case.id } })).version).toBe(2);
});
it('exposes only allowlisted draft context to an authorized operator before a first proposal', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON', differenceFen: 5000, payer: 'INITIATOR' });
  const started = (await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: order.version, purpose: 'DEPOSIT' }).expect(202)).body;
  const f = await fixture(started.order); const ops = await operator();
  const path = `/api/admin/after-sales/${f.opened.case.id}`;
  const response = await request(h.app.getHttpServer()).get(path).set('Authorization', `Bearer ${ops.session.token}`).set('Cookie', ops.session.cookie).expect(200);
  expect(response.body.resolutionContext).toEqual({
    orderStatus: 'ON_HOLD', orderVersion: 3,
    itemSnapshots: f.snapshots.map(s => ({ id: s.id, itemId: s.itemId, side: s.side, deliveryState: 'UNDELIVERED' })),
    originalPayments: [{ paymentIntentId: started.paymentIntentId, side: 'INITIATOR', purpose: 'DEPOSIT', status: 'CREATED', amountFen: 1000, collectedFen: 0, refundedFen: 0, settledFen: 0 }],
    originalDifference: { amountFen: 5000, payer: 'INITIATOR', settlementStatus: 'UNPAID' },
  });
  expect(JSON.stringify(response.body.resolutionContext)).not.toMatch(/authorId|actorId|userId|sessionId|deviceId|grantId|businessNo|provider|address|checkout|credential/);
  await h.get(h.actors.initiator, path).expect(403);
  await h.get(h.actors.outsider, path).expect(403);
  const customer = await h.get(h.actors.initiator, `/api/after-sales/${f.opened.case.id}`).expect(200);
  expect(customer.body).not.toHaveProperty('resolutionContext');
});
it('allows separate bounded CONTINUE compensation while retaining original deposit terms', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const started = (await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: order.version, purpose: 'DEPOSIT' }).expect(202)).body;
  const f = await fixture(started.order); const ops = await operator();
  const input = { ...f.input, type: 'CONTINUE_EXCHANGE', orderOutcome: 'RESUME', originalFunds: [{ paymentIntentId: started.paymentIntentId, destination: 'RETAIN_FOR_EXCHANGE' }], compensationComponents: { ...zero(), initiatorExtraFen: 500, recipientExtraFen: 100 }, netCompensation: { amountFen: 400, payer: 'INITIATOR' } };
  await ops.post(f.path, input).expect(200);
  expect(await h.prisma.resolutionVersion.findFirst({ where: { caseId: f.opened.case.id } })).toMatchObject({ type: 'CONTINUE_EXCHANGE', netCompensationFen: 400, compensationPayer: 'INITIATOR', originalFunds: input.originalFunds });
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: order.id } } })).toBe(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: order.id, kind: 'REFUND_PAYMENT' } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { orderId: order.id } })).toBe(2);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ON_HOLD');
});
it('preserves valid REJECT and AGREE rows and immutable consent, resolution, record and audit history', async () => {
  const f = await fixture(); const resolution = await storedResolution(f);
  await h.prisma.resolutionConsent.create({ data: { resolutionId: resolution.id, actorId: h.actors.initiator.id, side: 'INITIATOR', decision: 'REJECT', reason: '不同意责任判断' } });
  await h.prisma.resolutionConsent.create({ data: { resolutionId: resolution.id, actorId: h.actors.recipient.id, side: 'RECIPIENT', decision: 'AGREE' } });
  expect(await h.prisma.resolutionConsent.count({ where: { resolutionId: resolution.id } })).toBe(2);
  for (const table of ['ResolutionConsent', 'ResolutionVersion', 'CaseRecord', 'AuditLog']) {
    await expect(h.prisma.$executeRawUnsafe(`UPDATE "${table}" SET "createdAt"=now()`)).rejects.toThrow(/immutable/i);
    await expect(h.prisma.$executeRawUnsafe(`DELETE FROM "${table}"`)).rejects.toThrow(/immutable/i);
  }
});
it('drafts from OPEN, gives a 72-hour response deadline and never accepts goods or executes', async () => {
  const f = await fixture(); const ops = await operator(); const key = randomUUID();
  const result = await ops.post(f.path, f.input, key).expect(200);
  expect(result.body).toMatchObject({ case: { status: 'AWAITING_AGREEMENT', version: 2, currentResolutionVersion: 1, agreementDeadline: '2026-10-12T00:00:00.000Z' }, orderVersion: 3 });
  expect((await ops.post(f.path, f.input, key).expect(200)).body).toEqual(result.body);
  await ops.post(f.path, { ...f.input, reason: '同键改内容' }, key).expect(409);
  expect(await h.prisma.resolutionVersion.count({ where: { caseId: f.opened.case.id } })).toBe(1);
  expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
  expect(await h.prisma.resolutionExecution.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
  expect((await h.prisma.orderPartyProgress.findMany({ where: { orderId: f.order.id } })).every(p => p.acceptedAt === null)).toBe(true);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ON_HOLD');
  await ops.post(f.path.replace('/resolutions', '/execute'), { ...versions(result.body), resolutionVersion: 1 }).expect(404);
});
it('binds each consent to its own participant and invalidates old confirmations with a new proposal', async () => {
  const f = await fixture(); const ops = await operator();
  let result: CaseCommandResult = (await ops.post(f.path, f.input).expect(200)).body;
  const path = `/api/after-sales/${f.opened.case.id}/consent`;
  await h.command(h.actors.outsider, path, { ...versions(result), resolutionVersion: 1, decision: 'AGREE' }).expect(404);
  await h.command(h.actors.mixed, path, { ...versions(result), resolutionVersion: 1, decision: 'AGREE' }).expect(403);
  await h.command(h.actors.initiator, path, { ...versions(result), resolutionVersion: 1, decision: 'AGREE', side: 'RECIPIENT' }).expect(400);
  for (const actor of [h.actors.initiator, h.actors.recipient]) result = (await h.command(actor, path, { ...versions(result), resolutionVersion: 1, decision: 'AGREE' }).expect(200)).body;
  expect(result.case.status).toBe('AWAITING_AGREEMENT');
  const next = (await ops.post(f.path, { ...f.input, ...versions(result), resolutionVersion: 2, reason: '重新核验后的第二版方案' }).expect(200)).body;
  await h.command(h.actors.initiator, path, { ...versions(next), resolutionVersion: 1, decision: 'AGREE' }).expect(409).expect(r => expect(r.body.code).toBe('RESOLUTION_VERSION_CONFLICT'));
  const rows = await h.prisma.resolutionVersion.findMany({ where: { caseId: f.opened.case.id }, include: { consents: true }, orderBy: { number: 'asc' } });
  expect(rows.map(r => r.consents.length)).toEqual([2, 0]);
  expect(rows[0].consents.map(c => [c.actorId, c.side])).toEqual(expect.arrayContaining([[h.actors.initiator.id, 'INITIATOR'], [h.actors.recipient.id, 'RECIPIENT']]));
});
it('records rejection reason, returns to review and rolls consent back when audit fails', async () => {
  const f = await fixture(); const ops = await operator(); const result = (await ops.post(f.path, f.input).expect(200)).body;
  const path = `/api/after-sales/${f.opened.case.id}/consent`;
  const input = { ...versions(result), resolutionVersion: 1, decision: 'REJECT', reason: '责任不清，需要重新核实' };
  await h.command(h.actors.initiator, path, { ...input, reason: null }).expect(400);
  h.faultAuditOnce(); await h.command(h.actors.initiator, path, input).expect(500);
  expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
  const rejected = await h.command(h.actors.initiator, path, input).expect(200);
  expect(rejected.body.case).toMatchObject({ status: 'UNDER_REVIEW', agreementDeadline: null });
  expect(await h.prisma.caseRecord.findFirst({ where: { caseId: f.opened.case.id, kind: 'RESOLUTION_REJECTED' } })).toMatchObject({ actorId: h.actors.initiator.id, description: input.reason });
});
it('rejects foreign snapshots, forged funds targets, excess components, forged net and stale proposal numbers', async () => {
  const f = await fixture(); const ops = await operator();
  for (const change of [
    { itemSnapshotIds: [randomUUID(), f.snapshots[1].id] },
    { originalFunds: [{ paymentIntentId: randomUUID(), destination: 'REFUND_PAYER' }] },
    { netCompensation: { amountFen: 1, payer: 'INITIATOR' } },
    { compensationComponents: { ...zero(), initiatorExtraFen: 20001 }, netCompensation: { amountFen: 20001, payer: 'INITIATOR' } },
    { compensationComponents: { ...zero(), recipientShippingFen: 20001 }, netCompensation: { amountFen: 20001, payer: 'RECIPIENT' } },
    { netCompensation: { amountFen: 60001, payer: 'INITIATOR' } },
  ]) await ops.post(f.path, { ...f.input, ...change }).expect(400);
  await ops.post(f.path, { ...f.input, resolutionVersion: 2 }).expect(409).expect(r => expect(r.body.code).toBe('RESOLUTION_VERSION_CONFLICT'));
});
it('rejects drafting during execution and preserves terminal history', async () => {
  const f = await fixture(); const ops = await operator();
  await h.prisma.afterSalesCase.update({ where: { id: f.opened.case.id }, data: { status: 'EXECUTING' } });
  await ops.post(f.path, f.input).expect(409);
  const historical = await fixture();
  await h.prisma.order.update({ where: { id: historical.order.id }, data: { status: 'COMPLETED', completedAt: h.clock.now() } });
  await ops.post(historical.path, historical.input).expect(400);
  await ops.post(historical.path, { ...historical.input, type: 'FUNDS_ONLY', orderOutcome: 'PRESERVE_TERMINAL' }).expect(200);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: historical.order.id } })).status).toBe('COMPLETED');
});
it('enforces bound operator identity before replay and rolls drafts back atomically', async () => {
  const f = await fixture(); const ops = await operator();
  await h.command(h.actors.operations, f.path, f.input).set('Origin', 'http://localhost:5173').expect(401);
  await (await operator(h.actors.reviewer)).post(f.path, f.input).expect(403);
  const key = randomUUID(); h.faultAuditOnce(); await ops.post(f.path, f.input, key).expect(500);
  expect(await h.prisma.resolutionVersion.count({ where: { caseId: f.opened.case.id } })).toBe(0);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.opened.case.id } })).version).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).version).toBe(2);
  await ops.post(f.path, f.input, key).expect(200);
  await h.prisma.operatorSession.update({ where: { id: ops.session.response.body.operatorSession.id }, data: { revokedAt: h.clock.now() } });
  await ops.post(f.path, f.input, key).expect(401);
});
it('offers a desktop-only action grant for adjudication without granting funds execution', async () => {
  const mobile = await operator(h.actors.superAdminOne);
  await h.grant(mobile.session, { action: 'ADJUDICATE_RESOLUTION', resourceId: randomUUID(), expectedVersions: { expectedCaseVersion: 1, expectedOrderVersion: 2, resolutionVersion: 1 }, requestHash: 'a'.repeat(64) }).expect(403).expect(r => expect(r.body.code).toBe('DESKTOP_SESSION_REQUIRED'));
});
it('shows current proposal details with only current participant consents and no operator identity secrets', async () => {
  const f = await fixture(); const ops = await operator();
  await ops.post(f.path, f.input).expect(200);
  const response = await h.get(h.actors.recipient, `/api/after-sales/${f.opened.case.id}`).expect(200);
  expect(response.body.resolutions).toEqual([expect.objectContaining({ number: 1, type: 'KEEP_WITH_COMPENSATION', netCompensation: { amountFen: 0, payer: 'NONE' }, consents: [] })]);
  expect(JSON.stringify(response.body.resolutions)).not.toMatch(/authorId|actorId|sessionId|deviceId|grantId|businessNo|credential/);
});
it('records an action-bound adjudication atomically without fabricating agreement or execution', async () => {
  const f = await fixture(); const ops = await operator(); const result = (await ops.post(f.path, f.input).expect(200)).body;
  const mobile = await operator(h.actors.superAdminOne);
  const enrollment = await h.enrollOwnedDevice(mobile.session).expect(201);
  const cli = spawnSync(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', enrollment.body.id, 'Task5 owned adjudication fixture'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  expect(cli.status).toBe(0);
  const desktopSession = await h.operatorLogin(h.actors.superAdminOne, mobile.session.cookie);
  const business = { ...versions(result), resolutionVersion: 1, reason: '依据提交说明作平台责任裁决', evidenceIds: [] };
  const grant = await h.grant(desktopSession, { action: 'ADJUDICATE_RESOLUTION', resourceId: f.opened.case.id, expectedVersions: { ...versions(result), resolutionVersion: 1 }, requestHash: operatorRequestHash(business) }).expect(200);
  const input = { ...business, operatorAction: { sessionId: desktopSession.response.body.operatorSession.id, grantId: grant.body.id } };
  const path = f.path.replace('/resolutions', '/adjudication'); const key = randomUUID();
  const post = (body: object, commandKey = key) => request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${desktopSession.token}`).set('Cookie', desktopSession.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', commandKey).send(body);
  await ops.post(path, input).expect(403);
  await post({ ...input, operatorAction: { ...input.operatorAction, sessionId: randomUUID() } }, randomUUID()).expect(403);
  await post({ ...input, reason: '更改授权内容' }, randomUUID()).expect(403);
  h.faultAuditOnce(); await post(input).expect(500);
  expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: grant.body.id } })).consumedAt).toBeNull();
  expect(await h.prisma.caseRecord.count({ where: { caseId: f.opened.case.id, kind: 'RESOLUTION_ADJUDICATED' } })).toBe(0);
  const adjudicated = await post(input).expect(200);
  expect((await post(input).expect(200)).body).toEqual(adjudicated.body);
  const ruling = await h.prisma.caseRecord.findFirstOrThrow({ where: { caseId: f.opened.case.id, kind: 'RESOLUTION_ADJUDICATED' } });
  expect(ruling).toMatchObject({ actorId: h.actors.superAdminOne.id, description: business.reason, details: { resolutionVersion: 1, sessionId: input.operatorAction.sessionId, grantId: grant.body.id } });
  await expect(h.prisma.caseRecord.update({ where: { id: ruling.id }, data: { description: '改写裁决' } })).rejects.toThrow(/immutable/i);
  await expect(h.prisma.caseRecord.delete({ where: { id: ruling.id } })).rejects.toThrow(/immutable/i);
  expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
  expect(await h.prisma.resolutionApproval.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
  expect(await h.prisma.resolutionExecution.count({ where: { resolution: { caseId: f.opened.case.id } } })).toBe(0);
  await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.superAdminOne.id, role: 'SUPER_ADMIN' } } });
  await h.prisma.userRole.create({ data: { userId: h.actors.superAdminOne.id, role: 'OPERATIONS' } });
  try { await post(input).expect(403); }
  finally { await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.superAdminOne.id, role: 'OPERATIONS' } } }); await h.prisma.userRole.create({ data: { userId: h.actors.superAdminOne.id, role: 'SUPER_ADMIN' } }); }
});
