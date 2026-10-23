import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import { expect } from 'vitest';
import type { CaseCommandResult, OperatorAction, ResolutionInput } from '@barter/contracts';
import { operatorRequestHash } from '../../../src/operator-security/operator-action.types.js';
import { OutboxHandlerRegistry } from '../../../src/integrations/outbox-handler.registry.js';
import type { ProviderOperation } from '../../../src/integrations/integration.types.js';
import { createAfterSalesHarness } from './after-sales-harness.js';

export async function createCompensationHarness() {
  const h = await createAfterSalesHarness();
  type Session = Awaited<ReturnType<typeof h.operatorLogin>>;
  function post(session: Session, path: string, input: object, key = randomUUID()) {
    return request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send(input);
  }
  const mobile = await h.operatorLogin();
  const device = await h.enrollOwnedDevice(mobile).expect(201);
  const cli = spawnSync(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', device.body.id, 'Task9 owned bootstrap'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  expect(cli.status).toBe(0);
  const one = await h.operatorLogin(h.actors.superAdminOne, mobile.cookie);
  const second = await h.operatorLogin(h.actors.superAdminTwo);
  const secondDevice = await h.enrollOwnedDevice(second).expect(201);
  const business = { expectedVersion: secondDevice.body.version, reason: 'Task9 desktop fixture' };
  const grant = await h.grant(one, { action: 'APPROVE_DEVICE', resourceId: secondDevice.body.id, expectedVersions: { expectedVersion: secondDevice.body.version }, requestHash: operatorRequestHash(business) }).expect(200);
  await post(one, `/api/admin/security/devices/${secondDevice.body.id}/approve`, { ...business, operatorAction: { sessionId: one.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200);
  const two = await h.operatorLogin(h.actors.superAdminTwo, second.cookie);
  const ops = await h.operatorLogin(h.actors.operations);
  const versions = (result: CaseCommandResult) => ({ expectedCaseVersion: result.case.version, expectedOrderVersion: result.orderVersion });
  async function fixture(options: { approve?: boolean; amount?: number; type?: ResolutionInput['type']; originalDeposit?: boolean; completedOrder?: { id: string; version: number } } = {}) {
    let order = options.completedOrder ?? await h.prepareOrder({ mode: 'IN_PERSON' });
    if (options.originalDeposit) {
      const started = await h.command(h.actors.initiator, `/api/orders/${order.id}/payments`, { expectedVersion: order.version, purpose: 'DEPOSIT' }).expect(202);
      const original = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.body.paymentIntentId } });
      await run(original.businessNo);
      order = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      order = (await h.command(h.actors.initiator, `/api/testing/payments/${original.id}/complete`, { expectedVersion: order.version }).expect(200)).body.order;
      await h.prisma.outboxCommand.update({ where: { businessNo: original.businessNo }, data: { status: 'SUCCEEDED' } });
    }
    let result: CaseCommandResult = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '独立补偿争议' }).expect(201)).body;
    const caseId = result.case.id;
    const path = `/api/admin/after-sales/${caseId}`;
    const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: order.id } });
    const amount = options.amount ?? 500;
    const input: ResolutionInput = { ...versions(result), resolutionVersion: 1, type: options.type ?? 'KEEP_WITH_COMPENSATION', reason: '净额独立支付，不改变原支付', rulesVersion: 'phase4-simulation-v1', evidenceIds: [], itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'NONE', originalFunds: [], returnPlan: [], compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: amount, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 }, netCompensation: { amountFen: amount, payer: amount ? 'INITIATOR' : 'NONE' }, orderOutcome: options.type === 'CONTINUE_EXCHANGE' ? 'RESUME' : 'COMPLETE' };
    input.originalFunds = (await h.prisma.paymentIntent.findMany({ where: { orderId: order.id } })).map(p => ({ paymentIntentId: p.id, destination: options.type === 'CONTINUE_EXCHANGE' ? 'RETAIN_FOR_EXCHANGE' : 'REFUND_PAYER' }));
    if (options.completedOrder) {
      input.type = 'FUNDS_ONLY'; input.orderOutcome = 'PRESERVE_TERMINAL';
      input.compensationComponents = { originalDifferenceReversal: { amountFen: 20000, payer: 'RECIPIENT' }, initiatorExtraFen: 0, recipientExtraFen: 20000, initiatorShippingFen: 0, recipientShippingFen: 20000 };
      input.netCompensation = { amountFen: 60000, payer: 'RECIPIENT' };
      input.originalFunds = (await h.prisma.paymentIntent.findMany({ where: { orderId: order.id } })).map(p => ({ paymentIntentId: p.id, destination: p.purpose === 'DEPOSIT' ? 'REFUND_PAYER' : 'SETTLE_BENEFICIARY' }));
      await post(ops, `${path}/resolutions`, { ...input, netCompensation: { amountFen: 60001, payer: 'RECIPIENT' } }).expect(400);
    }
    if (options.type === 'CANCEL_BEFORE_HANDOVER' || options.type === 'RETURN_ORIGINALS') { input.returnPlan = snapshots.map(s => ({ itemSnapshotId: s.id, outcome: 'UNDELIVERED' })); input.orderOutcome = 'CANCEL'; }
    result = (await post(ops, `${path}/resolutions`, input).expect(200)).body;
    for (const actor of [h.actors.initiator, h.actors.recipient]) result = (await h.command(actor, `/api/after-sales/${caseId}/consent`, { ...versions(result), resolutionVersion: 1, decision: 'AGREE' }).expect(200)).body;
    async function authorized(session: Session, action: OperatorAction) {
      const body = { ...versions(result), resolutionVersion: 1, reason: '批准当前资金义务' };
      const auth = await h.grant(session, { action, resourceId: caseId, expectedVersions: { ...versions(result), resolutionVersion: 1 }, requestHash: operatorRequestHash(body) }).expect(200);
      return { ...body, operatorAction: { sessionId: session.response.body.operatorSession.id, grantId: auth.body.id } };
    }
    if (options.approve !== false) for (const session of [one, two]) result = (await post(session, `${path}/approvals`, await authorized(session, 'APPROVE_FUNDS')).expect(200)).body;
    return {
      order, caseId, path, input,
      execute: async (status = 200) => { const response = await post(one, `${path}/execute`, await authorized(one, 'EXECUTE_FUNDS')).expect(status); if (status === 200) result = response.body; return response; },
      async current() { const c = await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: caseId } }); const o = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } }); return { expectedCaseVersion: c.version, expectedOrderVersion: o.version, resolutionVersion: 1 }; },
    };
  }
  async function run(businessNo: string) {
    const row = await h.prisma.outboxCommand.findUniqueOrThrow({ where: { businessNo } });
    const op: ProviderOperation = { businessNo, kind: row.kind, orderId: row.orderId, payload: row.payload as ProviderOperation['payload'] };
    const handler = h.app.get(OutboxHandlerRegistry).get(row.kind)!;
    const queried = await handler.query(op);
    const result = queried.status === 'FAILURE' && queried.reason === 'NOT_FOUND'
      ? await (async () => { expect(await handler.authorize?.(op)).toBe(true); return handler.execute(op); })() : queried;
    await handler.apply(op, result);
    if (result.status === 'SUCCESS') await h.prisma.outboxCommand.update({ where: { businessNo }, data: { status: 'SUCCEEDED' } });
    return { op, result, handler };
  }
  return { ...h, one, two, ops, post, fixture, run };
}
export type CompensationHarness = Awaited<ReturnType<typeof createCompensationHarness>>;
