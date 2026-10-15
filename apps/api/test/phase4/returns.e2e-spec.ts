import { createHmac, randomUUID } from 'node:crypto';
import { CompensationComponentsSchema, ResolutionReturnPlanSchema } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { CaseCommandsService } from '../../src/after-sales/case-commands.service.js';
import type { CaseMutationContext, LockedCase } from '../../src/after-sales/case.types.js';
import { SimulatedLogisticsAdapter } from '../../src/integrations/simulated-logistics.adapter.js';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import type { ProviderOperation, VerifiedIntegrationEvent } from '../../src/integrations/integration.types.js';
import type { AuthenticatedUser } from '../../src/auth/auth.service.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { AddressCipher } from '../../src/orders/address-cipher.js';
import { LogisticsEventsService } from '../../src/logistics/logistics-events.service.js';
import request from 'supertest';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../../src/integrations/integration-config.js';
import { selectIntegration } from '../../src/integrations/integration-config.js';

let h: AfterSalesHarness;
beforeAll(async () => { h = await createAfterSalesHarness(); });
afterAll(async () => { await h?.close(); });
afterEach(() => vi.restoreAllMocks());
type Planner = { planInTransaction(ctx: CaseMutationContext, resolution: LockedCase['resolutions'][number]): Promise<void> };
const address = { recipientName: '归还地址专用姓名', phone: '13812345678', region: '测试省测试市测试区', detail: '加密专用街道九九号' };
async function fixture(options: { count?: number; mode?: 'COURIER'|'IN_PERSON'; delivered?: ('INITIATOR'|'RECIPIENT')[]; registered?: boolean; importedInterception?: boolean } = {}) {
  const mode = options.mode ?? 'COURIER';
  const order = await h.prepareOrder({ offeredCount: options.count ?? 5, mode });
  const delivered = options.delivered ?? ['INITIATOR', 'RECIPIENT'];
  await h.prisma.order.update({ where: { id: order.id }, data: { status: 'AWAITING_FULFILLMENT', detailsDeadline: null } });
  for (const side of delivered) {
    if (mode === 'COURIER') {
      const id = randomUUID();
      await h.prisma.shipment.create({ data: { id, orderId: order.id, side, carrier: 'SF', trackingNumber: randomUUID(), businessNo: `shipment:${id}`, status: options.registered ? 'REGISTERED' : 'DELIVERED', deliveredAt: options.registered ? null : h.clock.now() } });
    } else await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side } }, data: { handedOverAt: h.clock.now() } });
  }
  const opened = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: 'Task8真实归还测试' }).expect(201)).body;
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
  const resolution = await h.prisma.resolutionVersion.create({ data: {
    caseId: opened.case.id, number: 1, authorId: h.actors.operations.id, type: 'RETURN_ORIGINALS', reason: '退回全部原物', rulesVersion: 'phase4-simulation-v1', evidenceIds: [], itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'NONE', originalFunds: [], returnPlan: snapshots.map(s => ({ itemSnapshotId: s.id, outcome: delivered.includes(s.side) ? options.importedInterception ? 'INTERCEPT_VERIFIED' : 'RETURN_ORIGINAL' : 'UNDELIVERED' })), compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: 0, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 }, netCompensationFen: 0, compensationPayer: 'NONE', orderOutcome: 'CANCEL',
  } });
  await h.prisma.afterSalesCase.update({ where: { id: opened.case.id }, data: { currentResolutionVersion: 1, status: 'AWAITING_AGREEMENT' } });
  return { order, caseId: opened.case.id as string, resolution, snapshots, result: opened, mode };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function refresh(f: Fixture) {
  const c = await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } });
  const o = await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
  return { expectedCaseVersion: c.version, expectedOrderVersion: o.version, resolutionVersion: 1 };
}
async function saveAddress(f: Fixture, actor: AuthenticatedUser, details = address, key = randomUUID()) {
  const call = h.command(actor, `/api/after-sales/${f.caseId}/return-address`, { ...await refresh(f), ...details }, key);
  return { expect: (status: number) => call.expect(status) };
}
async function plan(f: Fixture, key = randomUUID(), input?: Awaited<ReturnType<typeof refresh>>) {
  const planner = h.app.get<Map<string, Planner>>('RESOLUTION_EXECUTORS').get('RETURN_ORIGINALS');
  expect(planner, 'RETURN_ORIGINALS must have its real registered planner').toBeDefined();
  // Exercise the public transactional planner under the exact production order→case
  // command lock/version/audit transaction; fixtures do not grant execution authority.
  return h.app.get(CaseCommandsService).run({ actor: h.actors.initiator, caseId: f.caseId, input: input ?? await refresh(f), key, commandName: 'TASK8_TEST_PLAN' }, async ctx => {
    await planner!.planInTransaction(ctx, ctx.case.resolutions[0]);
    await ctx.tx.resolutionExecution.create({ data: { resolutionId: f.resolution.id, executionStep: 'START', action: 'EXECUTE_FUNDS', actorId: h.actors.superAdminOne.id, progress: { create: { status: 'PENDING' } } } });
    await ctx.tx.afterSalesCase.update({ where: { id: f.caseId }, data: { status: 'EXECUTING' } });
  });
}
async function ready(f: Fixture) {
  if (f.mode === 'COURIER') for (const actor of [h.actors.initiator, h.actors.recipient]) await (await saveAddress(f, actor)).expect(200);
  await plan(f);
}
async function obligations(f: Fixture, holder?: string) {
  return h.prisma.returnObligation.findMany({ where: { resolutionId: f.resolution.id, ...(holder ? { holderSide: holder as 'INITIATOR'|'RECIPIENT' } : {}) }, include: { progress: true }, orderBy: { id: 'asc' } });
}
async function parcel(f: Fixture, actor = h.actors.recipient, ids?: string[], trackingNumber: string = randomUUID(), key = randomUUID()) {
  const all = await obligations(f, actor.id === h.actors.recipient.id ? 'RECIPIENT' : 'INITIATOR');
  const selected = ids ?? all.map(o => o.id);
  const call = h.command(actor, `/api/after-sales/${f.caseId}/returns/shipment`, { ...await refresh(f), obligationIds: selected, obligationVersions: selected.map(id => ({ obligationId: id, expectedVersion: all.find(o => o.id === id)?.progress?.version ?? 1 })), carrier: 'SF', trackingNumber }, key);
  return { expect: (status: number) => call.expect(status) };
}
function signed(event: object): VerifiedIntegrationEvent {
  const raw = JSON.stringify(event);
  return h.app.get(SimulatedLogisticsAdapter).verifySignedEvent(raw, createHmac('sha256', Buffer.from(process.env.SIMULATED_INTEGRATION_SIGNING_KEY_BASE64!, 'base64')).update(raw).digest('hex'));
}
async function drive(operation: ProviderOperation, outcome: object) {
  operation = { businessNo: operation.businessNo, orderId: operation.orderId, kind: operation.kind, payload: operation.payload };
  const registry = h.app.get(OutboxHandlerRegistry); const handler = registry.get(operation.kind)!;
  expect(await handler.authorize!(operation)).toBe(true);
  await handler.execute(operation);
  const event = signed({ provider: 'simulated', eventId: randomUUID(), businessNo: operation.businessNo, occurredAt: h.clock.now().toISOString(), ...outcome });
  await h.app.get(SimulatedProviderStore).recordEvent(event);
  const result = await handler.query(operation);
  await handler.apply(operation, result);
  return { handler, event, result };
}
async function closeOriginals(f: Fixture, outcome: 'DELIVERED'|'INTERCEPTED' = 'DELIVERED') {
  const commands = await h.prisma.outboxCommand.findMany({ where: { orderId: f.order.id, kind: 'CLOSE_OR_INTERCEPT' } });
  expect(commands.length).toBeGreaterThan(0);
  for (const op of commands) await drive(op as unknown as ProviderOperation, { kind: 'ORIGINAL_SHIPMENT_CLOSED', shipmentId: (op.payload as { shipmentId: string }).shipmentId, outcome });
}

async function deferOtherCommands() {
  await h.prisma.outboxCommand.updateMany({ data: { availableAt: new Date(h.clock.now().getTime() + 365 * 86400000) } });
}
async function simulate(f: Fixture, actor: AuthenticatedUser, shipmentId: string, fact: object, key = randomUUID(), input?: object) {
  return h.command(actor, `/api/after-sales/${f.caseId}/returns/simulated-progress`, input ?? { ...await refresh(f), shipmentId, ...fact }, key);
}
it('consumes runtime simulated COLLECTED then later DELIVERED and EXCEPTION after actual worker success without duplicate operations', async () => {
  await deferOtherCommands();
  const f = await fixture({ count: 1, delivered: ['INITIATOR'] }); await ready(f);
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  try {
    await worker.tick();
    const original = await h.prisma.shipment.findFirstOrThrow({ where: { orderId: f.order.id } });
    expect(await h.prisma.originalShipmentClosure.findUnique({ where: { shipmentId: original.id } })).toBeNull();
    expect((await simulate(f, h.actors.initiator, original.id, { kind: 'ORIGINAL_SHIPMENT_CLOSED', outcome: 'DELIVERED' })).status).toBe(200);
    h.clock.advance(30000); await worker.tick();
    await (await parcel(f)).expect(200); await worker.tick();
    const op = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: f.order.id, kind: 'VERIFY_RETURN' } });
    const shipmentId = (op.payload as { shipmentId: string }).shipmentId;
    const input = { ...await refresh(f), shipmentId, kind: 'RETURN_PROGRESS', progress: 'COLLECTED' };
    for (const [actor, status] of [[h.actors.outsider, 404], [h.actors.mixed, 403], [h.actors.initiator, 403]] as const) expect((await simulate(f, actor, shipmentId, {}, randomUUID(), input)).status).toBe(status);
    expect((await simulate(f, h.actors.recipient, shipmentId, {}, randomUUID(), { ...input, progress: 'DELIVERED' })).status).toBe(409);
    expect((await simulate(f, h.actors.recipient, shipmentId, {}, randomUUID(), { ...input, provider: 'simulated', eventId: 'client-cannot-author-facts' })).status).toBe(400);
    const key = randomUUID();
    const first = await simulate(f, h.actors.recipient, shipmentId, {}, key, input);
    expect(first.status).toBe(200); expect(first.headers['cache-control']).toBe('no-store');
    h.clock.advance(30000); await worker.tick();
    expect(await h.prisma.outboxCommand.findUniqueOrThrow({ where: { id: op.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect((await obligations(f))[0].progress?.status).toBe('COLLECTED');
    const deliveryInput = { ...await refresh(f), shipmentId, kind: 'RETURN_PROGRESS', progress: 'DELIVERED' };
    const deliveryKey = randomUUID();
    const collected = await obligations(f);
    const eventsBefore = await h.prisma.returnEvent.count({ where: { shipmentId } });
    h.faultAuditActionAfterInsertOnce('RETURN_PROVIDER_FACT_RECORDED', async tx => { expect(await tx.returnShipment.findUniqueOrThrow({ where: { id: shipmentId } })).toMatchObject({ status: 'DELIVERED' }); });
    expect((await simulate(f, h.actors.recipient, shipmentId, {}, deliveryKey, deliveryInput)).status).toBe(500);
    expect(await obligations(f)).toEqual(collected);
    expect(await h.prisma.returnEvent.count({ where: { shipmentId } })).toBe(eventsBefore);
    expect(await h.prisma.integrationEvent.count({ where: { businessNo: op.businessNo, payload: { path: ['progress'], equals: 'DELIVERED' } } })).toBe(0);
    vi.restoreAllMocks();
    expect((await simulate(f, h.actors.recipient, shipmentId, {}, deliveryKey, deliveryInput)).status).toBe(200);
    const delivered = (await obligations(f))[0];
    expect(delivered.progress).toMatchObject({ status: 'DELIVERED', confirmedAt: null });
    const beforeReplay = await refresh(f);
    expect((await simulate(f, h.actors.recipient, shipmentId, {}, key, input)).status).toBe(200);
    expect(await refresh(f)).toEqual(beforeReplay);
    expect((await simulate(f, h.actors.recipient, shipmentId, {}, key, { ...input, progress: 'EXCEPTION' })).status).toBe(409);
    expect((await simulate(f, h.actors.recipient, shipmentId, { kind: 'RETURN_PROGRESS', progress: 'COLLECTED' })).status).toBe(409);
    expect((await simulate(f, h.actors.recipient, shipmentId, { kind: 'RETURN_PROGRESS', progress: 'EXCEPTION' })).status).toBe(200);
    expect((await obligations(f))[0].progress?.status).toBe('DISPUTED');
    expect(await h.prisma.riskTask.count({ where: { caseId: f.caseId, kind: 'RETURN_EXCEPTION' } })).toBe(1);
    expect(await h.prisma.simulatedProviderOperation.count({ where: { businessNo: op.businessNo } })).toBe(1);
    expect(await h.prisma.outboxCommand.count({ where: { businessNo: op.businessNo } })).toBe(1);
    expect(await h.prisma.returnShipment.findUniqueOrThrow({ where: { id: shipmentId } })).toMatchObject({ businessNo: op.businessNo });
  } finally { await worker.onModuleDestroy(); }
});
it('admits runtime simulated interception and retries provider facts after atomic audit rollback with participant and sender checks', async () => {
  await deferOtherCommands();
  const f = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'] }); await ready(f);
  const original = await h.prisma.shipment.findFirstOrThrow({ where: { orderId: f.order.id } });
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  try {
    await worker.tick();
    const input = { ...await refresh(f), shipmentId: original.id, kind: 'ORIGINAL_SHIPMENT_CLOSED', outcome: 'INTERCEPTED' };
    const key = randomUUID();
    for (const [actor, status] of [[h.actors.outsider, 404], [h.actors.mixed, 403], [h.actors.recipient, 403]] as const) expect((await simulate(f, actor, original.id, {}, randomUUID(), input)).status).toBe(status);
    h.faultAuditActionAfterInsertOnce('RETURN_PROVIDER_FACT_RECORDED', async tx => { expect(await tx.originalShipmentClosure.count({ where: { shipmentId: original.id } })).toBe(1); });
    expect((await simulate(f, h.actors.initiator, original.id, {}, key, input)).status).toBe(500);
    expect(await h.prisma.originalShipmentClosure.findUnique({ where: { shipmentId: original.id } })).toBeNull();
    expect(await h.prisma.integrationEvent.count({ where: { businessNo: `return:intercept:${original.id}` } })).toBe(0);
    expect((await obligations(f))[0].progress?.status).toBe('UNKNOWN');
    vi.restoreAllMocks();
    expect((await simulate(f, h.actors.initiator, original.id, {}, key, input)).status).toBe(200);
    expect((await obligations(f))[0].progress?.status).toBe('INTERCEPTED');
    expect(await h.prisma.simulatedProviderOperation.count({ where: { businessNo: `return:intercept:${original.id}` } })).toBe(1);
  } finally { await worker.onModuleDestroy(); }
});
async function successor(f: Fixture) {
  // Fixture of a safely terminated prior execution; Task10 transitions are not implemented here.
  await deferOtherCommands();
  await h.prisma.outboxCommand.updateMany({ where: { orderId: f.order.id }, data: { availableAt: h.clock.now() } });
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  try { for (let i = 0; i < 2; i++) await worker.tick(); } finally { await worker.onModuleDestroy(); }
  await h.prisma.resolutionExecutionProgress.updateMany({ where: { execution: { resolutionId: f.resolution.id } }, data: { status: 'SUCCEEDED', completedAt: h.clock.now() } });
  await h.prisma.afterSalesCase.update({ where: { id: f.caseId }, data: { status: 'RESOLVED', closedAt: h.clock.now() } });
  await h.prisma.orderHoldBlocker.updateMany({ where: { orderId: f.order.id }, data: { resolvedAt: h.clock.now() } });
  const opened = await h.command(h.actors.initiator, `/api/orders/${f.order.id}/after-sales`, { expectedOrderVersion: (await refresh(f)).expectedOrderVersion, previousCaseId: f.caseId, reason: '同根后续事项，沿用原拦截事实' }).expect(201);
  const session = await h.operatorLogin(h.actors.operations);
  const input = { expectedCaseVersion: opened.body.case.version, expectedOrderVersion: opened.body.orderVersion, resolutionVersion: 1, type: 'RETURN_ORIGINALS', reason: '沿用已核验原拦截', rulesVersion: 'phase4-simulation-v1', evidenceIds: [], itemSnapshotIds: f.snapshots.map(s => s.id), responsibility: 'NONE', originalFunds: [], returnPlan: f.snapshots.map(s => ({ itemSnapshotId: s.id, outcome: s.side === 'INITIATOR' ? 'INTERCEPT_VERIFIED' : 'UNDELIVERED' })), compensationComponents: f.resolution.compensationComponents, netCompensation: { amountFen: 0, payer: 'NONE' }, orderOutcome: 'CANCEL' };
  await request(h.app.getHttpServer()).post(`/api/admin/after-sales/${opened.body.case.id}/resolutions`).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', randomUUID()).send(input).expect(200);
  const resolution = await h.prisma.resolutionVersion.findFirstOrThrow({ where: { caseId: opened.body.case.id } });
  return { ...f, caseId: opened.body.case.id as string, resolution };
}
it('reuses exact verified historical interception for a formally accepted same-root successor plan without new obligations or outbox', async () => {
  const f = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'] }); await ready(f); await closeOriginals(f, 'INTERCEPTED');
  const old = await obligations(f);
  const closure = await h.prisma.originalShipmentClosure.findFirstOrThrow({ where: { resolutionId: f.resolution.id } });
  const next = await successor(f);
  const commands = await h.prisma.outboxCommand.findMany({ where: { orderId: f.order.id } });
  const key = randomUUID(); const input = await refresh(next);
  const result = await plan(next, key, input);
  expect(await plan(next, key, input)).toEqual(result);
  expect(await obligations(next)).toHaveLength(0);
  expect(await obligations(f)).toEqual(old);
  expect(await h.prisma.originalShipmentClosure.findUniqueOrThrow({ where: { shipmentId: closure.shipmentId } })).toEqual(closure);
  expect(await h.prisma.outboxCommand.findMany({ where: { orderId: f.order.id } })).toEqual(commands);
  expect(next.resolution.returnPlan).toEqual(expect.arrayContaining([{ itemSnapshotId: old[0].itemSnapshotId, outcome: 'INTERCEPT_VERIFIED' }]));
});
it.each(['different-root', 'different-order-and-snapshot'] as const)('does not reuse an interception from %s', async scenario => {
  const f = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'] }); await ready(f); await closeOriginals(f, 'INTERCEPTED');
  const next = await successor(f);
  let unrelated: Fixture;
  if (scenario === 'different-root') {
    await h.prisma.afterSalesCase.update({ where: { id: next.caseId }, data: { status: 'RESOLVED', closedAt: h.clock.now() } });
    const value = await h.prisma.afterSalesCase.create({ data: { orderId: f.order.id, applicantId: h.actors.initiator.id, reason: '需要核验的不同根导入历史' } });
    const resolution = await h.prisma.resolutionVersion.create({ data: { ...next.resolution, id: randomUUID(), caseId: value.id, originalFunds: [], returnPlan: ResolutionReturnPlanSchema.parse(next.resolution.returnPlan), compensationComponents: CompensationComponentsSchema.parse(next.resolution.compensationComponents) } });
    await h.prisma.afterSalesCase.update({ where: { id: value.id }, data: { currentResolutionVersion: 1, status: 'AWAITING_AGREEMENT' } });
    unrelated = { ...f, caseId: value.id, resolution };
  } else unrelated = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'], importedInterception: true });
  await expect(plan(unrelated)).rejects.toMatchObject({ status: 409 });
  expect(await obligations(unrelated)).toHaveLength(0);
  expect(await h.prisma.outboxCommand.count({ where: { payload: { path: ['resolutionId'], equals: unrelated.resolution.id } } })).toBe(0);
});
it.each(['UNKNOWN', 'PENDING', 'REGISTERED', 'COLLECTED', 'DELIVERED', 'DISPUTED', 'CONFIRMED', 'UNRETURNABLE'] as const)('never reuses historical %s progress as an interception', async status => {
  const f = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'] }); await ready(f); await closeOriginals(f, 'INTERCEPTED');
  const next = await successor(f);
  const [old] = await obligations(f);
  await h.prisma.returnProgress.update({ where: { obligationId: old.id }, data: { status, ...(status === 'CONFIRMED' ? { confirmedAt: h.clock.now() } : {}) } });
  await expect(plan(next)).rejects.toMatchObject({ status: 409 });
  expect(await obligations(next)).toHaveLength(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: f.order.id } })).toBe(1);
});
it.each(['risk', 'late-delivery', 'pending-execution', 'unprocessed-closure'] as const)('rejects unresolved or contradictory historical interception: %s', async scenario => {
  const f = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'] }); await ready(f); await closeOriginals(f, 'INTERCEPTED');
  const next = await successor(f);
  const closure = await h.prisma.originalShipmentClosure.findFirstOrThrow({ where: { resolutionId: f.resolution.id } });
  if (scenario === 'risk') await h.prisma.riskTask.create({ data: { orderId: f.order.id, caseId: f.caseId, kind: 'RETURN_CLOSURE_CONFLICT', sourceKey: randomUUID(), description: '未解决的原关闭冲突' } });
  if (scenario === 'pending-execution') await h.prisma.resolutionExecutionProgress.updateMany({ where: { execution: { resolutionId: f.resolution.id } }, data: { status: 'PENDING', completedAt: null } });
  if (scenario === 'unprocessed-closure') await h.prisma.integrationEventReceipt.update({ where: { eventId: closure.eventId }, data: { status: 'REJECTED', reason: 'requires reconciliation' } });
  if (scenario === 'late-delivery') {
    const original = await h.prisma.shipment.findUniqueOrThrow({ where: { id: closure.shipmentId } });
    await h.app.get(LogisticsEventsService).applyVerified(signed({ provider: 'simulated', eventId: randomUUID(), kind: 'SHIPMENT_PROGRESS', businessNo: original.businessNo, shipmentId: original.id, progress: 'DELIVERED', occurredAt: h.clock.now().toISOString() }));
  }
  await expect(plan(next)).rejects.toMatchObject({ status: 409 });
  expect(await obligations(next)).toHaveLength(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: f.order.id } })).toBe(1);
  expect(await h.prisma.originalShipmentClosure.findUniqueOrThrow({ where: { shipmentId: closure.shipmentId } })).toEqual(closure);
});
it.each(['cleared', 'wrong-source', 'wrong-kind', 'wrong-order', 'open-blocker'] as const)('reuses historical original EXCEPTION only with matching resolved provenance: %s', async scenario => {
  const f = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'] }); await ready(f);
  const original = await h.prisma.shipment.findFirstOrThrow({ where: { orderId: f.order.id } });
  const event = signed({ provider: 'simulated', eventId: randomUUID(), kind: 'SHIPMENT_PROGRESS', businessNo: original.businessNo, shipmentId: original.id, progress: 'EXCEPTION', occurredAt: h.clock.now().toISOString() });
  await h.app.get(LogisticsEventsService).applyVerified(event);
  const risk = await h.prisma.riskTask.findUniqueOrThrow({ where: { sourceKey: `shipment:${original.id}:exception` } });
  const blocker = await h.prisma.orderHoldBlocker.findUniqueOrThrow({ where: { orderId_kind_sourceId: { orderId: f.order.id, kind: 'RISK', sourceId: risk.id } } });
  await closeOriginals(f, 'INTERCEPTED');
  await h.prisma.riskTask.update({ where: { id: risk.id }, data: { status: 'RESOLVED' } });
  const next = await successor(f);
  if (scenario === 'wrong-source') await h.prisma.riskTask.update({ where: { id: risk.id }, data: { sourceKey: randomUUID() } });
  if (scenario === 'wrong-kind') await h.prisma.riskTask.update({ where: { id: risk.id }, data: { kind: 'UNRELATED_HISTORY' } });
  if (scenario === 'wrong-order') await h.prisma.riskTask.update({ where: { id: risk.id }, data: { orderId: (await h.prepareOrder()).id } });
  if (scenario === 'open-blocker') await h.prisma.orderHoldBlocker.update({ where: { id: blocker.id }, data: { resolvedAt: null } });
  if (scenario === 'cleared') await plan(next);
  else await expect(plan(next)).rejects.toMatchObject({ status: 409 });
  expect(await obligations(next)).toHaveLength(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: f.order.id } })).toBe(1);
  expect(await h.prisma.shipment.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ status: 'EXCEPTION', deliveredAt: null });
  expect(await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } } })).toMatchObject({ payload: event });
});
it('rejects simulated runtime requests for stale versions, wrong case and unselected or production integrations', async () => {
  await deferOtherCommands();
  const f = await fixture({ count: 1, registered: true, delivered: ['INITIATOR'] }); await ready(f);
  const original = await h.prisma.shipment.findFirstOrThrow({ where: { orderId: f.order.id } });
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  try { await worker.tick(); } finally { await worker.onModuleDestroy(); }
  const input = { ...await refresh(f), shipmentId: original.id, kind: 'ORIGINAL_SHIPMENT_CLOSED', outcome: 'INTERCEPTED' };
  expect((await simulate(f, h.actors.initiator, original.id, {}, randomUUID(), { ...input, outcome: 'UNKNOWN' })).status).toBe(400);
  expect((await simulate(f, h.actors.initiator, original.id, {}, randomUUID(), { ...input, outcome: 'DELIVERED' })).status).toBe(409);
  for (const changed of [{ expectedCaseVersion: input.expectedCaseVersion - 1 }, { expectedOrderVersion: input.expectedOrderVersion - 1 }, { resolutionVersion: 2 }, { shipmentId: randomUUID() }]) expect((await simulate(f, h.actors.initiator, original.id, {}, randomUUID(), { ...input, ...changed })).status).toBe(409);
  const other = await fixture({ count: 1, delivered: [] });
  expect((await simulate(other, h.actors.initiator, original.id, { kind: 'ORIGINAL_SHIPMENT_CLOSED', outcome: 'INTERCEPTED' })).status).toBe(409);
  const config = h.app.get<IntegrationConfiguration>(INTEGRATION_CONFIG);
  const previous = config.logistics;
  config.logistics = 'disabled';
  try { expect((await simulate(f, h.actors.initiator, original.id, {}, randomUUID(), input)).status).toBe(503); } finally { config.logistics = previous; }
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { expect((await simulate(f, h.actors.initiator, original.id, {}, randomUUID(), input)).status).toBe(503); } finally { process.env.NODE_ENV = nodeEnv; }
  expect(() => selectIntegration({ nodeEnv: 'production', provider: 'simulated' })).toThrow();
  expect(await h.prisma.originalShipmentClosure.findUnique({ where: { shipmentId: original.id } })).toBeNull();
});

it('plans five initiator snapshots and one recipient snapshot exactly and freezes encrypted owner addresses atomically', async () => {
  const f = await fixture(); await ready(f);
  const all = await obligations(f); expect(all).toHaveLength(6);
  expect(all.map(o => o.itemSnapshotId).sort()).toEqual(f.snapshots.map(s => s.id).sort());
  expect(all.filter(o => o.holderSide === 'RECIPIENT')).toHaveLength(5);
  expect(all.every(o => o.ownerSide !== o.holderSide && o.progress?.version === 1)).toBe(true);
  const addresses = await h.prisma.returnAddress.findMany({ where: { caseId: f.caseId } });
  expect(addresses.every(a => a.frozenAt && !Buffer.from(a.ciphertext).toString().includes(address.detail))).toBe(true);
  expect(await h.prisma.simulatedProviderOperation.count({ where: { orderId: f.order.id } })).toBe(0);
});
it('does not invent a return duty for the side that never handed over', async () => {
  const f = await fixture({ mode: 'IN_PERSON', delivered: ['INITIATOR'] }); await ready(f);
  expect(await obligations(f)).toHaveLength(5); expect(await obligations(f, 'INITIATOR')).toHaveLength(0);
});
it('keeps self owner-specific, stranger 404, outgoing unavailable before execution and original ON_HOLD outgoing closed', async () => {
  const f = await fixture();
  await (await saveAddress(f, h.actors.initiator)).expect(200);
  const other = { ...address, recipientName: '另一个原物主', detail: '另一个独立地址' };
  await (await saveAddress(f, h.actors.recipient, other)).expect(200);
  await h.get(h.actors.outsider, `/api/after-sales/${f.caseId}/return-address?side=self`).expect(404);
  await h.get(h.actors.recipient, `/api/after-sales/${f.caseId}/return-address?side=outgoing`).expect(409);
  await plan(f);
  await h.get(h.actors.initiator, `/api/after-sales/${f.caseId}/return-address?side=self`).expect(200).expect(r => expect(r.body).toMatchObject(address));
  await h.get(h.actors.recipient, `/api/after-sales/${f.caseId}/return-address?side=self`).expect(200).expect(r => expect(r.body).toMatchObject(other));
  await h.get(h.actors.recipient, `/api/after-sales/${f.caseId}/return-address?side=outgoing`).expect(200).expect(r => expect(r.body).toMatchObject(address));
  await h.get(h.actors.recipient, `/api/orders/${f.order.id}/shipping-address?side=outgoing`).expect(409);
  await (await saveAddress(f, h.actors.initiator)).expect(409);
  const generic = JSON.stringify({ logs: await h.prisma.auditLog.findMany({ where: { entityId: f.caseId } }), cache: await h.prisma.idempotencyRecord.findMany({ where: { actorId: { in: [h.actors.initiator.id, h.actors.recipient.id] } } }), detail: (await h.get(h.actors.initiator, `/api/after-sales/${f.caseId}`).expect(200)).body });
  expect(generic).not.toContain(address.detail); expect(generic).not.toContain(address.phone);
});
it('requires confirmed original closure before exact combined parcel registration and preserves original Shipment', async () => {
  const f = await fixture(); await ready(f);
  const before = await h.prisma.shipment.findMany({ where: { orderId: f.order.id }, orderBy: { id: 'asc' } });
  await (await parcel(f)).expect(409);
  await closeOriginals(f);
  const all = await obligations(f, 'RECIPIENT');
  const key = randomUUID(); const input = { ...await refresh(f), obligationIds: all.map(o => o.id), obligationVersions: all.map(o => ({ obligationId: o.id, expectedVersion: o.progress!.version })), carrier: 'SF', trackingNumber: randomUUID() };
  const path = `/api/after-sales/${f.caseId}/returns/shipment`;
  const first = await h.command(h.actors.recipient, path, input, key).expect(200);
  await h.command(h.actors.recipient, path, input, key).expect(200).expect(r => expect(r.body).toEqual(first.body));
  await h.command(h.actors.recipient, path, { ...input, trackingNumber: randomUUID() }, key).expect(409);
  expect(await h.prisma.returnShipmentItem.count({ where: { shipment: { resolutionId: f.resolution.id } } })).toBe(5);
  expect(await h.prisma.shipment.findMany({ where: { orderId: f.order.id }, orderBy: { id: 'asc' } })).toEqual(before);
});
it.each(['UNKNOWN', 'PENDING'] as const)('keeps %s original provider state unresolved and never fabricates undelivered or closure', async status => {
  const f = await fixture({ registered: true, delivered: ['INITIATOR'] }); await ready(f);
  const op = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: f.order.id, kind: 'CLOSE_OR_INTERCEPT' } });
  const handler = h.app.get(OutboxHandlerRegistry).get(op.kind)!;
  await handler.apply(op as unknown as ProviderOperation, { status });
  await (await parcel(f)).expect(409);
  expect((await obligations(f)).every(o => o.progress?.status === 'UNKNOWN')).toBe(true);
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(6);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: f.caseId } })).status).toBe('EXECUTING');
});
it('records verified interception without requiring a fictional reverse parcel or exposing outgoing address', async () => {
  const f = await fixture({ registered: true, delivered: ['INITIATOR'] }); await ready(f); await closeOriginals(f, 'INTERCEPTED');
  expect((await obligations(f)).every(o => o.progress?.status === 'INTERCEPTED')).toBe(true);
  await (await parcel(f)).expect(409);
  await h.get(h.actors.recipient, `/api/after-sales/${f.caseId}/return-address?side=outgoing`).expect(409);
});
it('requires the actual holder handback then a different original owner confirmation, including frozen customers', async () => {
  const f = await fixture({ mode: 'IN_PERSON', delivered: ['INITIATOR'] }); await ready(f);
  await h.prisma.tradingRestriction.update({ where: { userId: h.actors.recipient.id }, data: { status: 'FROZEN', reason: '保留必要退货' } });
  const all = await obligations(f); const ids = all.map(o => o.id);
  const path = `/api/after-sales/${f.caseId}/returns`;
  const hand = { ...await refresh(f), obligationIds: ids, obligationVersions: all.map(o => ({ obligationId: o.id, expectedVersion: o.progress!.version })) };
  await h.command(h.actors.initiator, `${path}/handover`, hand).expect(403);
  await h.command(h.actors.mixed, `${path}/handover`, hand).expect(403);
  await h.command(h.actors.recipient, `${path}/handover`, hand).expect(200);
  const [one] = await obligations(f); const confirm = { ...await refresh(f), obligationId: one.id, expectedObligationVersion: one.progress!.version, decision: 'CONFIRM' };
  await h.command(h.actors.recipient, `${path}/confirmation`, confirm).expect(403);
  await h.command(h.actors.outsider, `${path}/confirmation`, confirm).expect(404);
  await h.command(h.actors.initiator, `${path}/confirmation`, confirm).expect(200);
  expect((await obligations(f)).filter(o => o.progress?.status === 'CONFIRMED')).toHaveLength(1);
  await h.prisma.tradingRestriction.update({ where: { userId: h.actors.recipient.id }, data: { status: 'CLEAR', reason: null } });
});
it('records signed return DELIVERED as evidence only, deduplicates events and requires customer receipt', async () => {
  const f = await fixture(); await ready(f); await closeOriginals(f); await (await parcel(f)).expect(200);
  const op = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: f.order.id, kind: 'VERIFY_RETURN' } });
  const shipmentId = (op.payload as { shipmentId: string }).shipmentId;
  const { handler, result } = await drive(op as unknown as ProviderOperation, { kind: 'RETURN_PROGRESS', shipmentId, progress: 'DELIVERED' });
  const before = await refresh(f); await handler.apply(op as unknown as ProviderOperation, result);
  expect(await refresh(f)).toEqual(before);
  const all = await obligations(f, 'RECIPIENT'); expect(all.every(o => o.progress?.status === 'DELIVERED' && !o.progress.confirmedAt)).toBe(true);
  const input = { ...before, obligationId: all[0].id, expectedObligationVersion: all[0].progress!.version, decision: 'CONFIRM' };
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/returns/confirmation`, { ...input, expectedObligationVersion: 1 }).expect(409).expect(r => expect(r.body.code).toBe('RETURN_VERSION_CONFLICT'));
  await h.command(h.actors.initiator, `/api/after-sales/${f.caseId}/returns/confirmation`, input).expect(200);
});
it('prevents global original/return tracking-number reuse and rolls back shipment/outbox on final audit failure', async () => {
  const f = await fixture(); await ready(f); await closeOriginals(f);
  const original = await h.prisma.shipment.findFirstOrThrow({ where: { orderId: f.order.id } });
  await (await parcel(f, h.actors.recipient, undefined, original.trackingNumber)).expect(409);
  const before = await refresh(f);
  h.faultAuditOnce(true);
  await (await parcel(f)).expect(500);
  expect(await refresh(f)).toEqual(before);
  expect(await h.prisma.returnShipment.count({ where: { resolutionId: f.resolution.id } })).toBe(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: f.order.id, kind: 'VERIFY_RETURN' } })).toBe(0);
  vi.restoreAllMocks();
  const tracking = randomUUID(); await (await parcel(f, h.actors.recipient, undefined, tracking)).expect(200);
  await (await parcel(f, h.actors.initiator, undefined, tracking)).expect(409);
});
it('rolls back planner obligations, address freeze and interception outbox when audit fails', async () => {
  const f = await fixture();
  for (const actor of [h.actors.initiator, h.actors.recipient]) await (await saveAddress(f, actor)).expect(200);
  h.faultAuditOnce(true); await expect(plan(f)).rejects.toThrow('Injected audit failure');
  expect(await obligations(f)).toHaveLength(0);
  expect(await h.prisma.returnAddress.count({ where: { caseId: f.caseId, frozenAt: { not: null } } })).toBe(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: f.order.id } })).toBe(0);
});

it('does not disclose an outgoing address to an unproven holder while original delivery is UNKNOWN', async () => {
  const f = await fixture({ registered: true, delivered: ['INITIATOR'] }); await ready(f);
  await h.get(h.actors.recipient, `/api/after-sales/${f.caseId}/return-address?side=outgoing`).expect(409);
  await h.get(h.actors.recipient, `/api/after-sales/${f.caseId}/return-address?side=self`).expect(200);
});
it('provides current safe per-snapshot versions through an authorized return query', async () => {
  const f = await fixture({ mode: 'IN_PERSON' }); await ready(f);
  const path = `/api/after-sales/${f.caseId}/returns`;
  await h.get(h.actors.outsider, path).expect(404);
  await h.get(h.actors.mixed, path).expect(403);
  await h.get(h.actors.initiator, path).expect(200).expect(r => {
    expect(r.body).toHaveLength(6);
    expect(r.body.every((v: Record<string, unknown>) => v.version === 1 && typeof v.itemSnapshotId === 'string' && !('actorId' in v) && !('ciphertext' in v))).toBe(true);
  });
});

it('reconciles the same external interception after a real worker audit rollback without another provider operation', async () => {
  // Bound the worker to this test's new owned order; prior owned commands remain
  // durable but are not due in this clock window.
  await h.prisma.outboxCommand.updateMany({ data: { availableAt: new Date(h.clock.now().getTime() + 365 * 86400000) } });
  const f = await fixture({ registered: true, delivered: ['INITIATOR'] }); await ready(f);
  const command = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: f.order.id, kind: 'CLOSE_OR_INTERCEPT' } });
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  await worker.tick();
  expect(await h.prisma.outboxCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: 'PENDING', attempts: 1 });
  expect((await obligations(f)).every(o => o.progress?.status === 'UNKNOWN')).toBe(true);
  const event = signed({ provider: 'simulated', eventId: randomUUID(), kind: 'ORIGINAL_SHIPMENT_CLOSED', businessNo: command.businessNo, shipmentId: (command.payload as { shipmentId: string }).shipmentId, outcome: 'DELIVERED', occurredAt: h.clock.now().toISOString() });
  await h.app.get(SimulatedProviderStore).recordEvent(event);
  h.faultAuditActionAfterInsertOnce('RETURN_PROVIDER_FACT_RECORDED', async tx => { expect(await tx.originalShipmentClosure.count({ where: { resolutionId: f.resolution.id } })).toBe(1); });
  h.clock.advance(30000); await worker.tick();
  expect(await h.prisma.originalShipmentClosure.count({ where: { resolutionId: f.resolution.id } })).toBe(0);
  expect(await h.prisma.integrationEvent.count({ where: { businessNo: command.businessNo } })).toBe(0);
  expect(await h.prisma.outboxCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: 'UNKNOWN', attempts: 2 });
  vi.restoreAllMocks(); h.clock.advance(30000); await worker.tick();
  expect(await h.prisma.outboxCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
  expect(await h.prisma.simulatedProviderOperation.count({ where: { businessNo: command.businessNo } })).toBe(1);
  expect((await obligations(f)).every(o => o.progress?.status === 'PENDING')).toBe(true);
  await worker.onModuleDestroy();
});
it('isolates authenticated return-address bytes from the original address encryption namespace', async () => {
  const cipher = h.app.get(AddressCipher);
  const base = { orderId: randomUUID(), side: 'INITIATOR' as const, version: 1 };
  const plain = { ...base, ...address };
  const original = cipher.encrypt(plain, base);
  const returned = cipher.encrypt(plain, { ...base, namespace: 'return-address-v1' });
  expect(cipher.decrypt(original, base)).toEqual(plain);
  expect(cipher.decrypt(returned, { ...base, namespace: 'return-address-v1' })).toEqual(plain);
  expect(() => cipher.decrypt(original, { ...base, namespace: 'return-address-v1' })).toThrow();
  expect(() => cipher.decrypt(returned, base)).toThrow();
});
it('rejects duplicate, mixed and cross-case parcel coverage with no partial writes', async () => {
  const f = await fixture(); await ready(f); await closeOriginals(f);
  const another = await fixture({ mode: 'IN_PERSON' }); await ready(another);
  const all = await obligations(f, 'RECIPIENT'); const opposite = await obligations(f, 'INITIATOR');
  const input = { ...await refresh(f), obligationIds: all.map(o => o.id), obligationVersions: all.map(o => ({ obligationId: o.id, expectedVersion: o.progress!.version })), carrier: 'SF', trackingNumber: randomUUID() };
  const path = `/api/after-sales/${f.caseId}/returns/shipment`;
  await h.command(h.actors.recipient, path, { ...input, obligationIds: [all[0].id, all[0].id] }).expect(400);
  for (const foreignId of [opposite[0].id, (await obligations(another))[0].id]) {
    const ids = [foreignId, ...all.slice(1).map(o => o.id)];
    await h.command(h.actors.recipient, path, { ...input, obligationIds: ids, obligationVersions: ids.map(id => ({ obligationId: id, expectedVersion: 1 })) }).expect(409);
  }
  await h.command(h.actors.recipient, path, { ...input, expectedCaseVersion: input.expectedCaseVersion - 1 }).expect(409);
  await h.command(h.actors.recipient, path, { ...input, expectedOrderVersion: input.expectedOrderVersion - 1 }).expect(409);
  await h.command(h.actors.recipient, path, { ...input, resolutionVersion: 2 }).expect(409);
  expect(await h.prisma.returnShipment.count({ where: { resolutionId: f.resolution.id } })).toBe(0);
});
it('serializes competing parcel registrations and prevents return tracking reuse by a later original shipment', async () => {
  const f = await fixture(); await ready(f); await closeOriginals(f);
  const all = await obligations(f, 'RECIPIENT'); const trackingNumber = randomUUID();
  const input = { ...await refresh(f), obligationIds: all.map(o => o.id), obligationVersions: all.map(o => ({ obligationId: o.id, expectedVersion: o.progress!.version })), carrier: 'SF', trackingNumber };
  const responses = await Promise.all([h.command(h.actors.recipient, `/api/after-sales/${f.caseId}/returns/shipment`, input), h.command(h.actors.recipient, `/api/after-sales/${f.caseId}/returns/shipment`, input)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await h.prisma.returnShipment.count({ where: { resolutionId: f.resolution.id } })).toBe(1);
  const another = await fixture({ delivered: [] });
  const id = randomUUID();
  await expect(h.prisma.shipment.create({ data: { id, orderId: another.order.id, side: 'INITIATOR', carrier: 'OTHER', trackingNumber: trackingNumber.toLowerCase(), businessNo: `shipment:${id}` } })).rejects.toMatchObject({ code: 'P2002' });
});
it('allows separate parcels in one direction while retaining every uncovered snapshot obligation', async () => {
  const f = await fixture(); await ready(f); await closeOriginals(f);
  const all = await obligations(f, 'RECIPIENT');
  await (await parcel(f, h.actors.recipient, all.slice(0, 4).map(o => o.id))).expect(200);
  expect((await obligations(f, 'RECIPIENT')).filter(o => o.progress?.status === 'REGISTERED')).toHaveLength(4);
  expect((await obligations(f, 'RECIPIENT')).filter(o => o.progress?.status === 'PENDING')).toHaveLength(1);
  await (await parcel(f, h.actors.recipient, [all[0].id])).expect(409);
  await (await parcel(f, h.actors.recipient, [all[4].id])).expect(200);
  expect(await h.prisma.returnShipment.count({ where: { resolutionId: f.resolution.id } })).toBe(2);
  expect(await h.prisma.returnShipmentItem.count({ where: { shipment: { resolutionId: f.resolution.id } } })).toBe(5);
  expect((await obligations(f, 'INITIATOR'))[0].progress?.status).toBe('PENDING');
});
it('preserves truthful delivery and quarantines a conflicting interception or mismatched shipment result', async () => {
  const f = await fixture(); await ready(f);
  const op = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: f.order.id, kind: 'CLOSE_OR_INTERCEPT' } });
  const operation = { businessNo: op.businessNo, orderId: op.orderId, kind: op.kind, payload: op.payload } as ProviderOperation;
  const handler = h.app.get(OutboxHandlerRegistry).get(op.kind)!;
  await handler.execute(operation);
  const event = signed({ provider: 'simulated', eventId: randomUUID(), kind: 'ORIGINAL_SHIPMENT_CLOSED', businessNo: op.businessNo, shipmentId: (op.payload as { shipmentId: string }).shipmentId, outcome: 'INTERCEPTED', occurredAt: h.clock.now().toISOString() });
  await handler.apply(operation, { status: 'SUCCESS', externalTransactionId: (event as { shipmentId: string }).shipmentId, event });
  expect(await h.prisma.originalShipmentClosure.count({ where: { resolutionId: f.resolution.id } })).toBe(0);
  expect((await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, include: { receipt: true } })).receipt?.status).toBe('REJECTED');
  await expect(handler.apply({ ...operation, businessNo: 'wrong-business-number' }, { status: 'SUCCESS', externalTransactionId: (event as { shipmentId: string }).shipmentId, event })).rejects.toThrow();
  expect((await obligations(f)).every(o => o.progress?.status === 'PENDING')).toBe(true);
});
it('never treats a persisted DELIVERED status with a missing legacy timestamp as interception success', async () => {
  const f = await fixture({ delivered: ['INITIATOR'] });
  const original = await h.prisma.shipment.findFirstOrThrow({ where: { orderId: f.order.id } });
  await h.prisma.shipment.update({ where: { id: original.id }, data: { deliveredAt: null } });
  await ready(f);
  const op = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: f.order.id, kind: 'CLOSE_OR_INTERCEPT' } });
  const event = signed({ provider: 'simulated', eventId: randomUUID(), kind: 'ORIGINAL_SHIPMENT_CLOSED', businessNo: op.businessNo, shipmentId: original.id, outcome: 'INTERCEPTED', occurredAt: h.clock.now().toISOString() });
  await h.app.get(OutboxHandlerRegistry).get(op.kind)!.apply(op as unknown as ProviderOperation, { status: 'SUCCESS', externalTransactionId: original.id, event });
  expect(await h.prisma.originalShipmentClosure.count({ where: { shipmentId: original.id } })).toBe(0);
  expect((await obligations(f)).every(o => o.progress?.status === 'UNKNOWN')).toBe(true);
});
it('does not commit address changes or return receipts when final audit fails, and safely retries the exact command', async () => {
  const f = await fixture(); const key = randomUUID();
  const input = { ...await refresh(f), ...address };
  const path = `/api/after-sales/${f.caseId}/return-address`;
  h.faultAuditOnce(true); await h.command(h.actors.initiator, path, input, key).expect(500);
  expect(await h.prisma.returnAddress.count({ where: { caseId: f.caseId } })).toBe(0);
  vi.restoreAllMocks();
  const saved = await h.command(h.actors.initiator, path, input, key).expect(200);
  await h.command(h.actors.initiator, path, input, key).expect(200).expect(r => expect(r.body).toEqual(saved.body));
  await h.command(h.actors.initiator, path, { ...input, detail: '修改地址必须更换逻辑命令' }, key).expect(409);
  const hand = await fixture({ mode: 'IN_PERSON', delivered: ['INITIATOR'] }); await ready(hand);
  const all = await obligations(hand);
  await h.command(h.actors.recipient, `/api/after-sales/${hand.caseId}/returns/handover`, { ...await refresh(hand), obligationIds: all.map(o => o.id), obligationVersions: all.map(o => ({ obligationId: o.id, expectedVersion: 1 })) }).expect(200);
  const o = (await obligations(hand))[0];
  const confirmation = { ...await refresh(hand), obligationId: o.id, expectedObligationVersion: o.progress!.version, decision: 'DISPUTE', reason: '归还物品破损，需人工核验' };
  h.faultAuditOnce(true); await h.command(h.actors.initiator, `/api/after-sales/${hand.caseId}/returns/confirmation`, confirmation).expect(500);
  expect((await obligations(hand))[0].progress?.status).toBe('DELIVERED');
  expect(await h.prisma.riskTask.count({ where: { caseId: hand.caseId, kind: 'RETURN_DISPUTED' } })).toBe(0);
  vi.restoreAllMocks(); await h.command(h.actors.initiator, `/api/after-sales/${hand.caseId}/returns/confirmation`, confirmation).expect(200);
  expect((await obligations(hand))[0].progress?.status).toBe('DISPUTED');
  expect(await h.prisma.riskTask.count({ where: { caseId: hand.caseId, kind: 'RETURN_DISPUTED' } })).toBe(1);
});
it('keeps contradictory late original delivery from falsely completing a verified intercepted duty', async () => {
  const f = await fixture({ registered: true, delivered: ['INITIATOR'] }); await ready(f); await closeOriginals(f, 'INTERCEPTED');
  const original = await h.prisma.shipment.findFirstOrThrow({ where: { orderId: f.order.id } });
  const event = signed({ provider: 'simulated', eventId: randomUUID(), kind: 'SHIPMENT_PROGRESS', businessNo: original.businessNo, shipmentId: original.id, progress: 'DELIVERED', occurredAt: h.clock.now().toISOString() });
  h.faultAuditActionAfterInsertOnce('RETURN_ORIGINAL_CLOSURE_CONFLICT', async tx => {
    expect(await tx.returnProgress.count({ where: { obligation: { resolutionId: f.resolution.id }, status: 'UNKNOWN' } })).toBe(5);
  });
  await expect(h.app.get(LogisticsEventsService).applyVerified(event)).rejects.toThrow('Injected action-targeted audit failure');
  expect((await obligations(f)).every(o => o.progress?.status === 'INTERCEPTED')).toBe(true);
  expect((await h.prisma.shipment.findUniqueOrThrow({ where: { id: original.id } })).deliveredAt).toBeNull();
  expect(await h.prisma.integrationEvent.count({ where: { provider: event.provider, eventId: event.eventId } })).toBe(0);
  vi.restoreAllMocks();
  await h.app.get(LogisticsEventsService).applyVerified(event);
  expect((await obligations(f)).every(o => o.progress?.status === 'UNKNOWN')).toBe(true);
  expect(await h.prisma.originalShipmentClosure.findUniqueOrThrow({ where: { shipmentId: original.id } })).toMatchObject({ outcome: 'INTERCEPTED' });
  expect(await h.prisma.riskTask.count({ where: { caseId: f.caseId, kind: 'RETURN_CLOSURE_CONFLICT', status: { not: 'RESOLVED' } } })).toBe(1);
  expect(await h.prisma.itemReservation.count({ where: { orderId: f.order.id } })).toBe(6);
  const before = await refresh(f);
  await h.app.get(LogisticsEventsService).applyVerified(event);
  const older = signed({ provider: 'simulated', eventId: randomUUID(), kind: 'SHIPMENT_PROGRESS', businessNo: original.businessNo, shipmentId: original.id, progress: 'COLLECTED', occurredAt: new Date(h.clock.now().getTime() - 3600000).toISOString() });
  await h.app.get(LogisticsEventsService).applyVerified(older);
  expect((await obligations(f)).every(o => o.progress?.status === 'UNKNOWN')).toBe(true);
  expect(await refresh(f)).toEqual(before);
  const bad = JSON.stringify({ ...event, eventId: randomUUID() });
  expect(() => h.app.get(SimulatedLogisticsAdapter).verifySignedEvent(bad, '0'.repeat(64))).toThrow();
});
