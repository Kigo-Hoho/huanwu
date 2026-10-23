import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import { CompensationEventsService } from '../../src/compensation/compensation-events.service.js';
import { CompensationOutboxHandler } from '../../src/compensation/compensation-outbox.handler.js';
import type { ProviderOperation, VerifiedIntegrationEvent } from '../../src/integrations/integration.types.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { FinancialEventReconciler } from '../../src/compensation/financial-event-reconciler.js';
import { PaymentEventsService } from '../../src/payments/payment-events.service.js';
import { INTEGRATION_CONFIG } from '../../src/integrations/integration-config.js';
import { createCompensationHarness, type CompensationHarness } from './support/compensation-harness.js';
let h: CompensationHarness;
beforeAll(async () => { h = await createCompensationHarness(); });
afterAll(async () => { await h?.close(); });
afterEach(() => vi.restoreAllMocks());
it('quarantines unknown malformed compensation business numbers without losing the verified fact', async () => {
  const event: VerifiedIntegrationEvent = { provider: 'simulated', eventId: randomUUID(), businessNo: `compensation:payment:${'-'.repeat(36)}`, kind: 'PAYMENT_SUCCEEDED', externalTransactionId: randomUUID(), amountFen: 500, currency: 'CNY', occurredAt: h.clock.now().toISOString() };
  await expect(h.app.get(CompensationEventsService).applyVerified(event)).resolves.toBeUndefined();
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'simulated', eventId: event.eventId } }, include: { receipt: true } })).receipt?.status).toBe('REJECTED');
});
it('rejects a mismatched trusted amount, keeps the exact evidence and leaves the ledger unchanged', async () => {
  const { f, p, paid } = await prepared('CONTINUE_EXCHANGE');
  await h.app.get(CompensationEventsService).applyVerified({ ...paid, amountFen: 501 } as VerifiedIntegrationEvent);
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(0);
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'simulated', eventId: paid.eventId } } })).amountFen).toBe(501);
  expect(await h.prisma.$transaction(tx => h.app.get<FundsInspector>('CASE_FUNDS_STATUS').inspect(tx, f.caseId))).toEqual({ complete: false, unknown: true, conflicting: true });
});
it('rechecks current financial authority before accepting a simulated customer collection', async () => {
  const { f, p } = await prepared();
  await h.prisma.user.update({ where: { id: h.actors.superAdminTwo.id }, data: { disabledAt: h.clock.now() } });
  try { await h.command(h.actors.initiator, `/api/testing/compensation/${p.id}/complete`, await f.current()).expect(409); }
  finally { await h.prisma.user.update({ where: { id: h.actors.superAdminTwo.id }, data: { disabledAt: null } }); }
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(0);
});
it('fails closed at runtime in production for both checkout and the explicitly simulated driver', async () => {
  const { f, p } = await prepared(); const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await h.get(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments/${p.id}/checkout`).expect(503);
    await h.command(h.actors.initiator, `/api/testing/compensation/${p.id}/complete`, await f.current()).expect(503);
  } finally { process.env.NODE_ENV = env; }
});
type FundsInspector = { inspect(tx: Prisma.TransactionClient, id: string): Promise<{ complete: boolean; unknown: boolean; conflicting: boolean }> };
it('reports incomplete funds while CONTINUE_EXCHANGE compensation remains unpaid or disbursement UNKNOWN', async () => {
  const { f, p, paid } = await prepared('CONTINUE_EXCHANGE');
  const inspect = () => h.prisma.$transaction(tx => h.app.get<FundsInspector>('CASE_FUNDS_STATUS').inspect(tx, f.caseId));
  expect(await inspect()).toMatchObject({ complete: false });
  await h.app.get(SimulatedProviderStore).recordEvent(paid); await h.app.get(CompensationEventsService).applyVerified(paid);
  await h.prisma.outboxCommand.update({ where: { businessNo: `compensation:disburse:${p.id}` }, data: { status: 'UNKNOWN' } });
  expect(await inspect()).toEqual({ complete: false, unknown: true, conflicting: false });
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBeGreaterThan(0);
});
it('refunds the original deposit once with its original refund number after approved safe cancellation', async () => {
  const f = await h.fixture({ originalDeposit: true, amount: 0, type: 'CANCEL_BEFORE_HANDOVER' }); await f.execute();
  const p = await h.prisma.paymentIntent.findFirstOrThrow({ where: { orderId: f.order.id } });
  const refund = await h.prisma.outboxCommand.findUnique({ where: { businessNo: `refund:${p.id}` } });
  expect(refund).not.toBeNull();
  await h.run(`refund:${p.id}`); await h.run(`refund:${p.id}`);
  expect(await h.prisma.financialEntry.findMany({ where: { intentId: p.id, entryType: 'REFUND' }, select: { amountFen: true, businessNo: true } })).toEqual([{ amountFen: p.amountFen, businessNo: `refund:${p.id}` }]);
  expect(await h.prisma.paymentIntent.count({ where: { orderId: f.order.id } })).toBe(1);
  const claim = await h.prisma.resolutionExecution.findFirstOrThrow({ where: { executionStep: `CLAIM:refund:${p.id}` }, include: { progress: true } });
  expect(claim.progress?.status).toBe('SUCCEEDED');
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ON_HOLD');
});
async function prepared(type: 'KEEP_WITH_COMPENSATION'|'CONTINUE_EXCHANGE' = 'KEEP_WITH_COMPENSATION') {
  const f = await h.fixture({ type }); await f.execute();
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments`, await f.current()).expect(200);
  const p = await h.prisma.compensationPayment.findFirstOrThrow({ where: { obligation: { resolution: { caseId: f.caseId } } } });
  const operation = await h.run(p.businessNo);
  const paid: VerifiedIntegrationEvent = { provider: 'simulated', eventId: randomUUID(), businessNo: p.businessNo, kind: 'PAYMENT_SUCCEEDED', externalTransactionId: randomUUID(), occurredAt: h.clock.now().toISOString(), amountFen: 500, currency: 'CNY' };
  return { f, p, paid, operation };
}
it('rejects new sending when an independent hold blocker appeared after planning', async () => {
  const { f, operation } = await prepared();
  await h.prisma.orderHoldBlocker.create({ data: { orderId: f.order.id, kind: 'RISK', sourceId: randomUUID(), reason: '独立风险仍需核验' } });
  expect(await h.app.get(CompensationOutboxHandler).authorize(operation.op)).toBe(false);
});
it('keeps an execution claim while a sender is between authorization and provider I/O and rejects plan replacement', async () => {
  const f = await h.fixture(); await f.execute();
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/compensation/payments`, await f.current()).expect(200);
  const p = await h.prisma.compensationPayment.findFirstOrThrow({ where: { obligation: { resolution: { caseId: f.caseId } } } });
  const store = h.app.get(SimulatedProviderStore);
  const realExecute = store.execute.bind(store);
  const arrived = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  vi.spyOn(store, 'execute').mockImplementation(async op => {
    if (op.businessNo === p.businessNo) { arrived.resolve(); await release.promise; }
    return realExecute(op);
  });
  const sending = h.run(p.businessNo);
  try {
    await Promise.race([arrived.promise, sending.then(() => { throw new Error('Provider barrier was not reached'); })]);
    expect(await store.query(p.businessNo)).toMatchObject({ status: 'FAILURE', reason: 'NOT_FOUND' });
    const claim = await h.prisma.resolutionExecution.findFirstOrThrow({ where: { executionStep: `CLAIM:${p.businessNo}` }, include: { progress: true } });
    expect(claim.progress?.status).toBe('PROCESSING');
    const before = await f.current();
    await h.post(h.ops, `${f.path}/resolutions`, { ...f.input, ...before, resolutionVersion: 2 }).expect(409);
    expect(await f.current()).toEqual(before);
  } finally { release.resolve(); await sending; }
  expect(await store.query(p.businessNo)).toMatchObject({ status: 'PENDING' });
});
it('recovers accepted payment after a new reconciler instance starts without customer retries', async () => {
  const { p, paid } = await prepared();
  await h.app.get(SimulatedProviderStore).recordEvent(paid);
  h.faultAuditOnce(true); await expect(h.app.get(CompensationEventsService).applyVerified(paid)).rejects.toThrow('Injected'); vi.restoreAllMocks();
  const recovery = new FinancialEventReconciler(h.prisma, h.app.get(CompensationEventsService), h.app.get(PaymentEventsService), h.app.get(INTEGRATION_CONFIG));
  await recovery.tick(); await recovery.onModuleDestroy();
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id, entryType: 'COLLECTION' } })).toBe(1);
});
it('keeps an unsolicited refund auditable but conflicting with the active transfer obligation', async () => {
  const { f, p, paid } = await prepared(); const store = h.app.get(SimulatedProviderStore); const events = h.app.get(CompensationEventsService);
  await store.recordEvent(paid); await events.applyVerified(paid);
  const result = await store.execute({ orderId: f.order.id, kind: 'REFUND_COMPENSATION', businessNo: `compensation:refund:${p.id}`, payload: { paymentBusinessNo: p.businessNo, amountFen: 500, currency: 'CNY' } });
  if (result.status !== 'SUCCESS') throw new Error('fixture failed'); await events.applyVerified(result.event);
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id, entryType: 'REFUND' } })).toBe(1);
  expect(await h.prisma.$transaction(tx => h.app.get<FundsInspector>('CASE_FUNDS_STATUS').inspect(tx, f.caseId))).toMatchObject({ complete: false, conflicting: true });
});
it.each(['refund', 'disburse'] as const)('allows only one external terminal disposition when %s races its opposite', async first => {
  const { f, p, paid } = await prepared(); const store = h.app.get(SimulatedProviderStore); await store.recordEvent(paid);
  const operation = (kind: 'refund'|'disburse'): ProviderOperation => ({ orderId: f.order.id, kind: kind === 'refund' ? 'REFUND_COMPENSATION' : 'DISBURSE_COMPENSATION', businessNo: `compensation:${kind}:${p.id}`, payload: { paymentBusinessNo: p.businessNo, amountFen: 500, currency: 'CNY' } });
  const results = await Promise.all([store.execute(operation(first)), store.execute(operation(first === 'refund' ? 'disburse' : 'refund'))]);
  expect(results.filter(r => r.status === 'SUCCESS')).toHaveLength(1);
  expect(results.filter(r => r.status === 'FAILURE')).toHaveLength(1);
});
it('closes an unpaid provider intent once and refuses collection or refund after closure', async () => {
  const { f, p, paid } = await prepared(); const store = h.app.get(SimulatedProviderStore);
  const op: ProviderOperation = { orderId: f.order.id, kind: 'CLOSE_COMPENSATION', businessNo: `compensation:close:${p.id}`, payload: { paymentBusinessNo: p.businessNo, amountFen: 500, currency: 'CNY' } };
  expect((await store.execute(op)).status).toBe('SUCCESS'); expect((await store.execute(op)).status).toBe('SUCCESS');
  await expect(store.recordEvent(paid)).rejects.toThrow();
  expect((await store.execute({ ...op, kind: 'REFUND_COMPENSATION', businessNo: `compensation:refund:${p.id}` })).status).toBe('FAILURE');
});
it.each(['REFUND_COMPENSATION', 'DISBURSE_COMPENSATION'] as const)('persists unordered %s facts then applies them after collection without a second external effect', async kind => {
  const { f, p, paid } = await prepared(); const store = h.app.get(SimulatedProviderStore); const events = h.app.get(CompensationEventsService);
  await store.recordEvent(paid);
  const op: ProviderOperation = { orderId: f.order.id, kind, businessNo: `compensation:${kind === 'REFUND_COMPENSATION' ? 'refund' : 'disburse'}:${p.id}`, payload: { paymentBusinessNo: p.businessNo, amountFen: 500, currency: 'CNY' } };
  const result = await store.execute(op); expect(result.status).toBe('SUCCESS'); if (result.status !== 'SUCCESS') throw new Error('fixture failed');
  await events.applyVerified(result.event);
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(0);
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'simulated', eventId: result.event.eventId } }, include: { receipt: true } })).receipt?.status).toBe('PENDING');
  await events.applyVerified(paid);
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(2);
  expect(await h.prisma.simulatedProviderEvent.count({ where: { businessNo: { in: [p.businessNo, op.businessNo] } } })).toBe(2);
  await events.applyVerified(result.event); expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(2);
});
it('retains every newly accepted financial event after local audit rollback', async () => {
  const { p, paid } = await prepared(); const store = h.app.get(SimulatedProviderStore); const events = h.app.get(CompensationEventsService);
  await store.recordEvent(paid);
  h.faultAuditOnce(true); await expect(events.applyVerified(paid)).rejects.toThrow('Injected'); vi.restoreAllMocks();
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(0);
  expect(await h.prisma.simulatedProviderEvent.count({ where: { businessNo: p.businessNo } })).toBe(1);
  const replay = await store.query(p.businessNo); if (replay.status !== 'SUCCESS') throw new Error('lost external fact');
  await events.applyVerified(replay.event);
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(1);
});
it('reconciles an already successful disbursement after approval revocation without executing twice', async () => {
  const { p, paid } = await prepared(); const events = h.app.get(CompensationEventsService); const store = h.app.get(SimulatedProviderStore);
  await store.recordEvent(paid); await events.applyVerified(paid);
  const row = await h.prisma.outboxCommand.findUniqueOrThrow({ where: { businessNo: `compensation:disburse:${p.id}` } });
  const op: ProviderOperation = { orderId: row.orderId, kind: row.kind, businessNo: row.businessNo, payload: row.payload as ProviderOperation['payload'] };
  const handler = h.app.get(CompensationOutboxHandler); expect(await handler.authorize(op)).toBe(true);
  const result = await handler.execute(op); h.faultAuditOnce(true); await expect(handler.apply(op, result)).rejects.toThrow('Injected'); vi.restoreAllMocks();
  await h.prisma.user.update({ where: { id: h.actors.superAdminTwo.id }, data: { disabledAt: h.clock.now() } });
  try { expect(await handler.authorize(op)).toBe(false); await handler.apply(op, await handler.query(op)); }
  finally { await h.prisma.user.update({ where: { id: h.actors.superAdminTwo.id }, data: { disabledAt: null } }); }
  expect(await store.successCount(op.businessNo)).toBe(1);
  expect(await h.prisma.compensationFinancialEntry.count({ where: { paymentId: p.id } })).toBe(2);
});
it('retains unpaid CONTINUE_EXCHANGE compensation and never releases original reservations', async () => {
  const f = await h.fixture({ type: 'CONTINUE_EXCHANGE' }); await f.execute();
  expect(await h.prisma.compensationObligation.count({ where: { resolution: { caseId: f.caseId } } })).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('ON_HOLD');
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBeGreaterThan(0);
});
