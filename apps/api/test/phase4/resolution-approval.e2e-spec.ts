import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import type { CaseCommandResult, OperatorAction, ResolutionInput } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { operatorRequestHash } from '../../src/operator-security/operator-action.types.js';
import type { CaseMutationContext, LockedCase } from '../../src/after-sales/case.types.js';

let h: AfterSalesHarness;
type Session = Awaited<ReturnType<AfterSalesHarness['operatorLogin']>>;
let one: Session; let two: Session; let three: Session; let ops: Session;
type Planner = { planInTransaction(ctx: CaseMutationContext, resolution: LockedCase['resolutions'][number]): Promise<void> };
const versions = (r: CaseCommandResult) => ({ expectedCaseVersion: r.case.version, expectedOrderVersion: r.orderVersion });
function post(session: Session, path: string, input: object, key = randomUUID()) {
  return request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send(input);
}
async function trust(actor: Parameters<AfterSalesHarness['operatorLogin']>[0]) {
  const mobile = await h.operatorLogin(actor);
  const device = await h.enrollOwnedDevice(mobile).expect(201);
  const business = { expectedVersion: device.body.version, reason: 'Task6 isolated desktop fixture' };
  const grant = await h.grant(one, { action: 'APPROVE_DEVICE', resourceId: device.body.id, expectedVersions: { expectedVersion: device.body.version }, requestHash: operatorRequestHash(business) }).expect(200);
  await post(one, `/api/admin/security/devices/${device.body.id}/approve`, { ...business, operatorAction: { sessionId: one.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200);
  return h.operatorLogin(actor, mobile.cookie);
}
beforeAll(async () => {
  h = await createAfterSalesHarness();
  const mobile = await h.operatorLogin();
  const device = await h.enrollOwnedDevice(mobile).expect(201);
  const cli = spawnSync(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', device.body.id, 'Task6 owned bootstrap'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  expect(cli.status).toBe(0);
  one = await h.operatorLogin(h.actors.superAdminOne, mobile.cookie);
  two = await trust(h.actors.superAdminTwo);
  const credential = await h.prisma.adminCredential.findUniqueOrThrow({ where: { userId: h.actors.superAdminOne.id } });
  const user = await h.prisma.user.create({ data: { roles: { create: { role: 'SUPER_ADMIN' } }, adminCredential: { create: { email: `${randomUUID()}@example.test`, passwordHash: credential.passwordHash } } } });
  three = await trust({ id: user.id, roles: ['SUPER_ADMIN'] });
  ops = await trust(h.actors.operations);
});
afterAll(async () => { await h?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
async function fixture(options: { financial?: boolean; author?: Session; consent?: boolean; payment?: boolean } = {}) {
  let order = await h.prepareOrder({ mode: 'IN_PERSON' });
  if (options.payment) order = (await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: order.version, purpose: 'DEPOSIT' }).expect(202)).body.order;
  const opened: CaseCommandResult = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '审批执行测试争议' }).expect(201)).body;
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: order.id } });
  const payments = await h.prisma.paymentIntent.findMany({ where: { orderId: order.id } });
  const financial = options.financial !== false;
  const input: ResolutionInput = { ...versions(opened), resolutionVersion: 1, type: financial ? 'KEEP_WITH_COMPENSATION' : 'CONTINUE_EXCHANGE', reason: '明确当前版本的处理方案', rulesVersion: 'phase4-simulation-v1', evidenceIds: [], itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'NONE', originalFunds: payments.map(p => ({ paymentIntentId: p.id, destination: financial ? 'REFUND_PAYER' : 'RETAIN_FOR_EXCHANGE' })), returnPlan: [], compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: financial ? 500 : 0, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 }, netCompensation: { amountFen: financial ? 500 : 0, payer: financial ? 'INITIATOR' : 'NONE' }, orderOutcome: financial ? 'COMPLETE' : 'RESUME' };
  const path = `/api/admin/after-sales/${opened.case.id}`;
  let result: CaseCommandResult = (await post(options.author ?? ops, `${path}/resolutions`, input).expect(200)).body;
  if (options.consent !== false) for (const actor of [h.actors.initiator, h.actors.recipient]) result = (await h.command(actor, `/api/after-sales/${opened.case.id}/consent`, { ...versions(result), resolutionVersion: 1, decision: 'AGREE' }).expect(200)).body;
  return { order, input, path, result, caseId: opened.case.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function authorized(f: Fixture, session: Session, action: OperatorAction, reason = '核验当前方案后批准操作') {
  const business = { ...versions(f.result), resolutionVersion: f.result.case.currentResolutionVersion!, reason };
  const grant = await h.grant(session, { action, resourceId: f.caseId, expectedVersions: { ...versions(f.result), resolutionVersion: business.resolutionVersion }, requestHash: operatorRequestHash(business) }).expect(200);
  return { ...business, operatorAction: { sessionId: session.response.body.operatorSession.id as string, grantId: grant.body.id as string } };
}
async function approve(f: Fixture, session: Session) {
  const input = await authorized(f, session, 'APPROVE_FUNDS');
  f.result = (await post(session, `${f.path}/approvals`, input).expect(200)).body;
  return input;
}
function registry() { return h.app.get<Map<string, Planner>>('RESOLUTION_EXECUTORS'); }
function registerPlanner(type = 'KEEP_WITH_COMPENSATION') {
  // This test-only adapter writes an owned planning fact, never invokes a provider.
  registry().set(type, { async planInTransaction(ctx, resolution) {
    await ctx.tx.outboxCommand.create({ data: { orderId: ctx.order.id, kind: 'REFUND_PAYMENT', businessNo: `task6-planning-fixture:${resolution.id}`, payload: { testOnly: true, resolutionId: resolution.id }, availableAt: ctx.now } });
  } });
}
async function counts(f: Fixture) {
  return { approvals: await h.prisma.resolutionApproval.count({ where: { resolution: { caseId: f.caseId } } }), executions: await h.prisma.resolutionExecution.count({ where: { resolution: { caseId: f.caseId } } }), outbox: await h.prisma.outboxCommand.count({ where: { orderId: f.order.id } }) };
}

it('requires two distinct approvals and explicitly rejects an unregistered executor without consuming its grant', async () => {
  const f = await fixture();
  let execution = await authorized(f, one, 'EXECUTE_FUNDS');
  await post(one, `${f.path}/execute`, execution).expect(409).expect(r => expect(r.body.code).toBe('APPROVAL_REQUIRED'));
  const first = await approve(f, one);
  expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: first.operatorAction.grantId } })).consumedAt).not.toBeNull();
  execution = await authorized(f, one, 'EXECUTE_FUNDS');
  await post(one, `${f.path}/execute`, execution).expect(409).expect(r => expect(r.body.code).toBe('APPROVAL_REQUIRED'));
  await approve(f, two);
  execution = await authorized(f, one, 'EXECUTE_FUNDS');
  await post(one, `${f.path}/execute`, execution).expect(503).expect(r => expect(r.body.code).toBe('RESOLUTION_EXECUTOR_UNAVAILABLE'));
  expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: execution.operatorAction.grantId } })).consumedAt).toBeNull();
  expect(await counts(f)).toEqual({ approvals: 2, executions: 0, outbox: 0 });
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ON_HOLD');
});
it('rejects proposer approval and a second approval by the same person; a third administrator permits an admin-authored plan', async () => {
  const f = await fixture({ author: one });
  await post(one, `${f.path}/approvals`, await authorized(f, one, 'APPROVE_FUNDS')).expect(403);
  await approve(f, two);
  await post(two, `${f.path}/approvals`, await authorized(f, two, 'APPROVE_FUNDS')).expect(409);
  await approve(f, three);
  const rows = await h.prisma.resolutionApproval.findMany({ where: { resolution: { caseId: f.caseId } } });
  expect(new Set(rows.map(r => r.actorId)).size).toBe(2);
  expect(rows.some(r => r.actorId === h.actors.superAdminOne.id)).toBe(false);
  await expect(h.prisma.resolutionApproval.update({ where: { id: rows[0].id }, data: { createdAt: new Date() } })).rejects.toThrow(/immutable/i);
  await expect(h.prisma.resolutionApproval.delete({ where: { id: rows[0].id } })).rejects.toThrow(/immutable/i);
});
it('rejects customer, customer-service, mobile, mismatched-session and altered-content commands', async () => {
  const f = await fixture(); const input = await authorized(f, one, 'APPROVE_FUNDS');
  const mobile = await h.operatorLogin(h.actors.superAdminOne);
  for (const suffix of ['approvals', 'execute']) {
    await h.command(h.actors.initiator, `${f.path}/${suffix}`, input).expect(403);
    await post(ops, `${f.path}/${suffix}`, input).expect(403);
    await post(mobile, `${f.path}/${suffix}`, { ...input, operatorAction: { ...input.operatorAction, sessionId: mobile.response.body.operatorSession.id } }).expect(403);
  }
  await post(one, `${f.path}/approvals`, { ...input, operatorAction: { ...input.operatorAction, sessionId: two.response.body.operatorSession.id } }).expect(403);
  await post(one, `${f.path}/approvals`, { ...input, reason: '改动已经绑定的内容' }).expect(403);
  await post(one, `${f.path}/approvals`, { ...input, businessNo: 'arbitrary-refund' }).expect(400);
  expect(await counts(f)).toEqual({ approvals: 0, executions: 0, outbox: 0 });
});
it('invalidates old approvals and grants after a replacement resolution and binds grants to the resource', async () => {
  const f = await fixture(); await approve(f, one); await approve(f, two);
  const old = await authorized(f, one, 'EXECUTE_FUNDS');
  f.result = (await post(ops, `${f.path}/resolutions`, { ...f.input, ...versions(f.result), resolutionVersion: 2, reason: '新的独立方案' }).expect(200)).body;
  await post(one, `${f.path}/execute`, old).expect(409);
  await post(one, `${f.path}/approvals`, { ...old, ...versions(f.result), resolutionVersion: 2 }).expect(403);
  const other = await fixture();
  await post(one, `${other.path}/approvals`, { ...old, ...versions(other.result), resolutionVersion: 1 }).expect(403);
  const fresh = await authorized(f, one, 'EXECUTE_FUNDS');
  await post(one, `${f.path}/execute`, fresh).expect(409).expect(r => expect(r.body.code).toBe('APPROVAL_REQUIRED'));
  expect(await counts(f)).toEqual({ approvals: 2, executions: 0, outbox: 0 });
});
it('keeps client consent or separate adjudication mandatory even with two financial approvals', async () => {
  const f = await fixture({ consent: false }); await approve(f, one); await approve(f, two);
  await post(one, `${f.path}/execute`, await authorized(f, one, 'EXECUTE_FUNDS')).expect(409).expect(r => expect(r.body.code).toBe('APPROVAL_REQUIRED'));
  expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: f.caseId } } })).toBe(0);
  const business = { ...versions(f.result), resolutionVersion: 1, reason: '独立裁决确定处理方向', evidenceIds: [] };
  const grant = await h.grant(one, { action: 'ADJUDICATE_RESOLUTION', resourceId: f.caseId, expectedVersions: { ...versions(f.result), resolutionVersion: 1 }, requestHash: operatorRequestHash(business) }).expect(200);
  f.result = (await post(one, `${f.path}/adjudication`, { ...business, operatorAction: { sessionId: one.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200)).body;
  registerPlanner();
  try {
    await post(one, `${f.path}/execute`, await authorized(f, one, 'EXECUTE_FUNDS')).expect(200);
    expect(await h.prisma.resolutionConsent.count({ where: { resolution: { caseId: f.caseId } } })).toBe(0);
    expect((await h.prisma.orderPartyProgress.findMany({ where: { orderId: f.order.id } })).every(p => p.acceptedAt === null)).toBe(true);
  } finally { registry().clear(); }
});
it('rolls back approval and grant consumption when the final approval audit insert fails, then replays once', async () => {
  const f = await fixture(); const input = await authorized(f, one, 'APPROVE_FUNDS'); const key = randomUUID();
  let inspected = false;
  h.faultAuditActionAfterInsertOnce('CASE_RESOLUTION_APPROVED', async tx => {
    expect(await tx.resolutionApproval.count({ where: { resolution: { caseId: f.caseId } } })).toBe(1);
    expect((await tx.actionGrant.findUniqueOrThrow({ where: { id: input.operatorAction.grantId } })).consumedAt).not.toBeNull();
    inspected = true;
  });
  await post(one, `${f.path}/approvals`, input, key).expect(500);
  expect(inspected).toBe(true); expect(await counts(f)).toEqual({ approvals: 0, executions: 0, outbox: 0 });
  expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: input.operatorAction.grantId } })).consumedAt).toBeNull();
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).version).toBe(f.result.case.version);
  const result = await post(one, `${f.path}/approvals`, input, key).expect(200);
  expect((await post(one, `${f.path}/approvals`, input, key).expect(200)).body).toEqual(result.body);
  await post(one, `${f.path}/approvals`, { ...input, reason: '同键改内容' }, key).expect(409);
  expect((await counts(f)).approvals).toBe(1);
});
it('plans once in the caller transaction and rolls execution, outbox, versions and grant back after final audit failure', async () => {
  const f = await fixture(); await approve(f, one); await approve(f, two); registerPlanner();
  try {
    const input = await authorized(f, one, 'EXECUTE_FUNDS'); const key = randomUUID(); let inspected = false;
    h.faultAuditActionAfterInsertOnce('CASE_RESOLUTION_EXECUTION_STARTED', async tx => {
      expect(await tx.resolutionExecution.count({ where: { resolution: { caseId: f.caseId } } })).toBe(1);
      expect(await tx.outboxCommand.count({ where: { orderId: f.order.id } })).toBe(1);
      expect((await tx.actionGrant.findUniqueOrThrow({ where: { id: input.operatorAction.grantId } })).consumedAt).not.toBeNull();
      inspected = true;
    });
    await post(one, `${f.path}/execute`, input, key).expect(500);
    expect(inspected).toBe(true); expect(await counts(f)).toEqual({ approvals: 2, executions: 0, outbox: 0 });
    expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: input.operatorAction.grantId } })).consumedAt).toBeNull();
    expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).version).toBe(f.result.case.version);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).version).toBe(f.result.orderVersion);
    expect(await h.prisma.idempotencyRecord.count({ where: { commandName: 'CASE_RESOLUTION_EXECUTION_STARTED', key } })).toBe(0);
    expect(await h.prisma.auditLog.count({ where: { OR: [{ entityId: f.caseId, action: 'CASE_RESOLUTION_EXECUTION_STARTED' }, { entityId: input.operatorAction.grantId, action: 'OPERATOR_ACTION_GRANT_CONSUMED' }] } })).toBe(0);
    const results = await Promise.all([post(one, `${f.path}/execute`, input, key), post(one, `${f.path}/execute`, input, key)]);
    expect(results.map(r => r.status)).toEqual([200, 200]); expect(results[0].body).toEqual(results[1].body);
    expect(results[0].body.case.status).toBe('EXECUTING');
    expect(await counts(f)).toEqual({ approvals: 2, executions: 1, outbox: 1 });
    expect(await h.prisma.simulatedProviderOperation.count({ where: { orderId: f.order.id } })).toBe(0);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ON_HOLD');
    f.result = results[0].body;
    await post(one, `${f.path}/execute`, await authorized(f, one, 'EXECUTE_FUNDS')).expect(409);
  } finally { registry().clear(); }
});
it('serializes racing approvals and concurrent reauthentication without double approval or deadlock', async () => {
  const f = await fixture(); const a = await authorized(f, one, 'APPROVE_FUNDS'); const b = await authorized(f, two, 'APPROVE_FUNDS');
  const results = await Promise.all([post(one, `${f.path}/approvals`, a), post(two, `${f.path}/approvals`, b), authorized(f, one, 'EXECUTE_FUNDS')]);
  expect(results.slice(0, 2).map(r => 'status' in r ? r.status : 0).sort()).toEqual([200, 409]);
  expect((await counts(f)).approvals).toBe(1);
});
it('blocks unresolved original funds and active order risks before planning', async () => {
  const f = await fixture({ payment: true }); await approve(f, one); await approve(f, two); registerPlanner();
  try {
    // Even an unqueried CREATED instruction must be reconciled before a
    // conflicting execution; UNKNOWN is not the only unsafe in-flight state.
    await post(one, `${f.path}/execute`, await authorized(f, one, 'EXECUTE_FUNDS')).expect(409).expect(r => expect(r.body.code).toBe('FUNDS_UNRESOLVED'));
    await h.prisma.paymentIntent.updateMany({ where: { orderId: f.order.id }, data: { status: 'UNKNOWN' } });
    const input = await authorized(f, one, 'EXECUTE_FUNDS');
    await post(one, `${f.path}/execute`, input).expect(409).expect(r => expect(r.body.code).toBe('FUNDS_UNRESOLVED'));
    expect((await counts(f)).executions).toBe(0);
    expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: input.operatorAction.grantId } })).consumedAt).toBeNull();
    const safe = await fixture(); await approve(safe, one); await approve(safe, two);
    await h.prisma.riskTask.create({ data: { orderId: safe.order.id, kind: 'MANUAL_REVIEW', sourceKey: randomUUID(), description: '待风险核验' } });
    await post(one, `${safe.path}/execute`, await authorized(safe, one, 'EXECUTE_FUNDS')).expect(409).expect(r => expect(r.body.code).toBe('RISK_BLOCKS_RESUME'));
  } finally { registry().clear(); }
});
it('requires RESUME_ORDER reauthentication for a no-funds CONTINUE and never invents financial approvals', async () => {
  const f = await fixture({ financial: false });
  await post(one, `${f.path}/approvals`, await authorized(f, one, 'APPROVE_FUNDS')).expect(409);
  await post(one, `${f.path}/execute`, await authorized(f, one, 'EXECUTE_FUNDS')).expect(403);
  await post(one, `${f.path}/execute`, await authorized(f, one, 'RESUME_ORDER')).expect(503);
  expect(await counts(f)).toEqual({ approvals: 0, executions: 0, outbox: 0 });
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ON_HOLD');
});
it('requires funds approval for CONTINUE with compensation and leaves original exchange terms intact', async () => {
  const f = await fixture({ financial: false });
  const input = { ...f.input, ...versions(f.result), resolutionVersion: 2, compensationComponents: { ...f.input.compensationComponents, initiatorExtraFen: 500 }, netCompensation: { amountFen: 500, payer: 'INITIATOR' } };
  f.result = (await post(ops, `${f.path}/resolutions`, input).expect(200)).body;
  for (const actor of [h.actors.initiator, h.actors.recipient]) f.result = (await h.command(actor, `/api/after-sales/${f.caseId}/consent`, { ...versions(f.result), resolutionVersion: 2, decision: 'AGREE' }).expect(200)).body;
  await post(one, `${f.path}/execute`, await authorized(f, one, 'EXECUTE_FUNDS')).expect(409).expect(r => expect(r.body.code).toBe('APPROVAL_REQUIRED'));
  await approve(f, one); await approve(f, two);
  await post(one, `${f.path}/execute`, await authorized(f, one, 'RESUME_ORDER')).expect(403);
  await post(one, `${f.path}/execute`, await authorized(f, one, 'EXECUTE_FUNDS')).expect(503);
  expect((await counts(f)).approvals).toBe(2);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).differenceFen).toBe(0);
});
it('rechecks current administrator authority before approvals and successful execution replay', async () => {
  const f = await fixture(); const input = await authorized(f, one, 'APPROVE_FUNDS');
  const demote = async () => {
    await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.superAdminOne.id, role: 'SUPER_ADMIN' } } });
    await h.prisma.userRole.create({ data: { userId: h.actors.superAdminOne.id, role: 'OPERATIONS' } });
  };
  const restore = async () => {
    await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.superAdminOne.id, role: 'OPERATIONS' } } });
    await h.prisma.userRole.create({ data: { userId: h.actors.superAdminOne.id, role: 'SUPER_ADMIN' } });
  };
  await demote();
  try { await post(one, `${f.path}/approvals`, input).expect(403); }
  finally { await restore(); }
  await approve(f, one); await approve(f, two); registerPlanner();
  try {
    const execute = await authorized(f, one, 'EXECUTE_FUNDS'); const key = randomUUID();
    await post(one, `${f.path}/execute`, execute, key).expect(200);
    await demote();
    try { await post(one, `${f.path}/execute`, execute, key).expect(403); }
    finally { await restore(); }
    expect(await counts(f)).toEqual({ approvals: 2, executions: 1, outbox: 1 });
  } finally { registry().clear(); }
});
it('rejects expired grants and revoked devices before sensitive replay', async () => {
  const f = await fixture(); const fresh = await trust(h.actors.superAdminTwo);
  const input = await authorized(f, fresh, 'APPROVE_FUNDS'); const key = randomUUID();
  const now = h.clock.now();
  try { h.clock.set(new Date(now.getTime() + 5 * 60_000)); await post(fresh, `${f.path}/approvals`, input, key).expect(403); }
  finally { h.clock.set(now); }
  await post(fresh, `${f.path}/approvals`, input, key).expect(200);
  const device = fresh.response.body.operatorSession.deviceId;
  const row = await h.prisma.operatorDevice.findUniqueOrThrow({ where: { id: device } });
  const business = { expectedVersion: row.version, reason: '撤销此次测试设备' };
  const grant = await h.grant(one, { action: 'REVOKE_DEVICE', resourceId: device, expectedVersions: { expectedVersion: row.version }, requestHash: operatorRequestHash(business) }).expect(200);
  await post(one, `/api/admin/security/devices/${device}/revoke`, { ...business, operatorAction: { sessionId: one.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200);
  await post(fresh, `${f.path}/approvals`, input, key).expect(401);
  expect((await counts(f)).approvals).toBe(1);
});
