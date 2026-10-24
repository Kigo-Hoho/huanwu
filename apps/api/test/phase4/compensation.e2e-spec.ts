import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createCompensationHarness, type CompensationHarness } from './support/compensation-harness.js';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import { randomUUID } from 'node:crypto';
let h: CompensationHarness;
beforeAll(async () => { h = await createCompensationHarness(); });
afterAll(async () => { await h?.close(); });
afterEach(() => vi.restoreAllMocks());
it('executes a 60000-fen net reversal, rejects 60001, and cannot create a second root reversal', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON', differenceFen: 20000, payer: 'INITIATOR' });
  const current = () => h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  for (const [actor, purpose] of [[h.actors.initiator, 'DEPOSIT'], [h.actors.recipient, 'DEPOSIT'], [h.actors.initiator, 'DIFFERENCE']] as const) {
    const started = await h.command(actor, `/api/orders/${order.id}/payments`, { expectedVersion: (await current()).version, purpose }).expect(202);
    const p = await h.prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.body.paymentIntentId } });
    await h.run(p.businessNo);
    await h.command(actor, `/api/testing/payments/${p.id}/complete`, { expectedVersion: (await current()).version }).expect(200);
    await h.run(p.businessNo);
  }
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${order.id}/handover`, { expectedVersion: (await current()).version }).expect(200);
  for (const actor of [h.actors.initiator, h.actors.recipient]) await h.command(actor, `/api/orders/${order.id}/acceptance`, { expectedVersion: (await current()).version }).expect(200);
  for (const command of await h.prisma.outboxCommand.findMany({ where: { orderId: order.id, status: 'PENDING' } })) await h.run(command.businessNo);
  expect((await current()).status).toBe('COMPLETED');
  const f = await h.fixture({ completedOrder: await current() }); await f.execute();
  const obligation = await h.prisma.compensationObligation.findFirstOrThrow({ where: { resolution: { caseId: f.caseId } } });
  expect(obligation).toMatchObject({ amountFen: 60000, payerSide: 'RECIPIENT' }); expect(obligation.originalPaymentIntentId).not.toBeNull();
  await expect(h.prisma.compensationObligation.create({ data: { ...obligation, id: randomUUID(), executionStep: 'SECOND_REVERSAL' } })).rejects.toThrow();
  await h.command(h.actors.recipient, `/api/after-sales/${f.caseId}/compensation/payments`, await f.current()).expect(200);
  const payment = await h.prisma.compensationPayment.findUniqueOrThrow({ where: { obligationId: obligation.id } });
  await h.run(payment.businessNo);
  await h.command(h.actors.recipient, `/api/testing/compensation/${payment.id}/complete`, await f.current()).expect(200);
  await h.run(`compensation:disburse:${payment.id}`);
  expect(await h.prisma.compensationFinancialEntry.findMany({ where: { paymentId: payment.id }, select: { amountFen: true } })).toEqual([{ amountFen: 60000 }, { amountFen: 60000 }]);
  expect((await current()).status).toBe('COMPLETED');
});
it('composes a return plan with its independent compensation without replacing return planning', async () => {
  const f = await h.fixture({ type: 'RETURN_ORIGINALS' }); await f.execute();
  expect(await h.prisma.compensationObligation.count({ where: { resolution: { caseId: f.caseId } } })).toBe(1);
});
it('executes the registered funds-free recovery and completes its case', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE', amount: 0, approve: false });
  const before = await f.current();
  // The shared execution gate chooses RESUME_ORDER itself.
  const business = { ...before, reason: '等待订单恢复执行器' };
  const { operatorRequestHash } = await import('../../src/operator-security/operator-action.types.js');
  const grant = await h.grant(h.one, { action: 'RESUME_ORDER', resourceId: f.caseId, expectedVersions: before, requestHash: operatorRequestHash(business) }).expect(200);
  await h.post(h.one, `${f.path}/execute`, { ...business, operatorAction: { sessionId: h.one.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).status).toBe('RESOLVED');
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('AWAITING_PAYMENT');
});

it('collects once through an explicit payer action and separately disburses the exact amount', async () => {
  const f = await h.fixture(); await f.execute();
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments`, await f.current()).expect(200);
  const payment = await h.prisma.compensationPayment.findFirstOrThrow({ where: { obligation: { resolution: { caseId: f.caseId } } } });
  await h.run(payment.businessNo);
  await h.command(h.actors.initiator, `/api/testing/compensation/${payment.id}/complete`, await f.current(), 'complete-compensation').expect(200);
  await h.run(`compensation:disburse:${payment.id}`);
  expect(await h.prisma.compensationFinancialEntry.findMany({ where: { paymentId: payment.id }, select: { entryType: true, amountFen: true } })).toEqual(expect.arrayContaining([{ entryType: 'COLLECTION', amountFen: 500 }, { entryType: 'TRANSFER', amountFen: 500 }]));
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: payment.id } })).toBe(2);
  const transferred = await h.prisma.compensationPayment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(transferred.transferredAt).not.toBeNull();
  const store = h.app.get(SimulatedProviderStore);
  await expect(store.execute({ orderId: f.order.id, businessNo: `compensation:refund:${payment.id}`, kind: 'REFUND_COMPENSATION' as never, payload: { paymentBusinessNo: payment.businessNo, amountFen: 500, currency: 'CNY' } })).resolves.toMatchObject({ status: 'FAILURE', reason: 'PAYMENT_ALREADY_DISPOSED' });
});

it('does not create obligations, checkout or provider effects before dual approval and execution', async () => {
  const f = await h.fixture({ approve: false });
  await f.execute(409);
  expect(await h.prisma.compensationObligation.count({ where: { resolution: { caseId: f.caseId } } })).toBe(0);
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments`, await f.current()).expect(409);
  expect(await h.prisma.simulatedProviderOperation.count({ where: { orderId: f.order.id } })).toBe(0);
});
it('plans a separate unpaid obligation without charging, then only the payer can request and read checkout', async () => {
  const f = await h.fixture(); await f.execute();
  const obligation = await h.prisma.compensationObligation.findFirstOrThrow({ where: { resolution: { caseId: f.caseId } } });
  expect(obligation).toMatchObject({ amountFen: 500, payerSide: 'INITIATOR', payeeSide: 'RECIPIENT', rootDisputeId: (await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).rootDisputeId });
  expect(await h.prisma.compensationPayment.count({ where: { obligationId: obligation.id } })).toBe(0);
  const path = `/api/after-sales/${f.caseId}/compensation/payments`;
  const input = await f.current();
  await h.command(h.actors.recipient, path, input).expect(403);
  await h.command(h.actors.outsider, path, input).expect(404);
  await h.command(h.actors.mixed, path, input).expect(403);
  const response = await h.command(h.actors.initiator, path, input, 'compensation-request-1').expect(200);
  expect(JSON.stringify(response.body)).not.toMatch(/checkout|params|businessNo/);
  await h.command(h.actors.initiator, path, input, 'compensation-request-1').expect(200);
  const payment = await h.prisma.compensationPayment.findUniqueOrThrow({ where: { obligationId: obligation.id } });
  await h.get(h.actors.initiator, `/api/after-sales/${f.caseId}`).expect(200).expect(r => expect(r.body.compensation).toEqual([expect.objectContaining({ obligationId: obligation.id, paymentId: payment.id, amountFen: 500 })]));
  expect(payment.businessNo).toBe(`compensation:payment:${payment.id}`);
  await h.run(payment.businessNo);
  const checkout = `${path}/${payment.id}/checkout`;
  await h.get(h.actors.recipient, checkout).expect(403);
  await h.get(h.actors.outsider, checkout).expect(404);
  await h.get(h.actors.initiator, checkout).expect(200).expect(r => { expect(r.headers['cache-control']).toBe('no-store'); expect(r.body).toMatchObject({ paymentId: payment.id, status: 'READY', provider: 'simulated' }); });
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: payment.id } })).toBe(0);
  expect(JSON.stringify(await h.prisma.idempotencyRecord.findMany({ where: { key: 'compensation-request-1' } }))).not.toMatch(/checkout|params/);
  expect(JSON.stringify(await h.prisma.auditLog.findMany({ where: { entityId: f.caseId } }))).not.toMatch(/checkout|params/);
});
it('rolls payment request, outbox, versions and idempotency back when its audit fails', async () => {
  const f = await h.fixture(); await f.execute();
  const before = await f.current();
  h.faultAuditOnce(true);
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments`, before, 'request-rollback').expect(500);
  expect(await h.prisma.compensationPayment.count({ where: { obligation: { resolution: { caseId: f.caseId } } } })).toBe(0);
  expect(await f.current()).toEqual(before);
  expect(await h.prisma.idempotencyRecord.count({ where: { key: 'request-rollback' } })).toBe(0);
});
