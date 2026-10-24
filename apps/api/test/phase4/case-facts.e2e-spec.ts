import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';

let h: AfterSalesHarness;
beforeAll(async () => { h = await createAfterSalesHarness(); });
afterAll(async () => { await h?.close(); });
const kinds = ['compensation-stored', 'compensation-payment', 'compensation-refund', 'compensation-disburse', 'compensation-entry', 'compensation-outbox', 'return-shipment', 'return-outbox'] as const;
type FactKind = typeof kinds[number];
async function completedFact(kind: FactKind, orderId: string, caseId: string, rootDisputeId: string) {
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId } });
  const resolution = await h.prisma.resolutionVersion.create({ data: {
    caseId, number: 1, authorId: h.actors.operations.id, type: 'FUNDS_ONLY', reason: '导入已完成的领域事实', rulesVersion: 'phase4-simulation-v1',
    itemSnapshotIds: snapshots.map(s => s.id), responsibility: 'UNDETERMINED', originalFunds: [], returnPlan: [],
    compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: 100, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 },
    netCompensationFen: 100, compensationPayer: 'INITIATOR', orderOutcome: 'PRESERVE_TERMINAL',
  } });
  if (kind.startsWith('return-')) {
    const ownerSide = snapshots[0].side;
    const holderSide = ownerSide === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR';
    const obligation = await h.prisma.returnObligation.create({ data: {
      resolutionId: resolution.id, itemSnapshotId: snapshots[0].id, holderSide, ownerSide, deliveryMode: 'COURIER', registrationDeadline: h.clock.now(),
      progress: { create: { status: 'CONFIRMED', confirmedAt: h.clock.now() } },
      events: { create: { actorId: snapshots[0].ownerId, kind: 'CONFIRMED', occurredAt: h.clock.now() } },
    } });
    const shipment = await h.prisma.returnShipment.create({ data: {
      resolutionId: resolution.id, holderSide, ownerSide, carrier: 'SF', trackingNumber: randomUUID(), businessNo: randomUUID(), status: 'DELIVERED', deliveredAt: h.clock.now(),
      items: { create: { obligationId: obligation.id } },
    } });
    if (kind === 'return-outbox') {
      const operation = await h.prisma.outboxCommand.create({ data: { orderId, kind: 'QUERY_SHIPMENT', businessNo: randomUUID(), status: 'SUCCEEDED', payload: { shipmentBusinessNo: shipment.businessNo } } });
      return operation.businessNo;
    }
    return shipment.businessNo;
  }
  const refunded = kind === 'compensation-entry';
  const obligation = await h.prisma.compensationObligation.create({ data: {
    resolutionId: resolution.id, rootDisputeId, executionStep: 'net', payerSide: 'INITIATOR', payeeSide: 'RECIPIENT', amountFen: 100, paymentDeadline: h.clock.now(),
    progress: { create: { status: refunded ? 'REFUNDED' : 'CLOSED', completedAt: h.clock.now() } },
  } });
  const payment = await h.prisma.compensationPayment.create({ data: {
    obligationId: obligation.id, provider: 'simulated', businessNo: randomUUID(), amountFen: 100, status: refunded ? 'REFUNDED' : 'CLOSED',
    ...(refunded ? { paidAt: h.clock.now(), refundedAt: h.clock.now() } : { closedAt: h.clock.now() }),
  } });
  if (refunded) {
    await h.prisma.compensationFinancialEntry.create({ data: { paymentId: payment.id, provider: 'simulated', entryType: 'COLLECTION', externalTransactionId: randomUUID(), businessNo: payment.businessNo, amountFen: 100, occurredAt: h.clock.now() } });
    const entry = await h.prisma.compensationFinancialEntry.create({ data: { paymentId: payment.id, provider: 'simulated', entryType: 'REFUND', externalTransactionId: randomUUID(), businessNo: randomUUID(), amountFen: 100, occurredAt: h.clock.now() } });
    return entry.businessNo;
  }
  if (kind === 'compensation-outbox') {
    const operation = await h.prisma.outboxCommand.create({ data: { orderId, kind: 'REFUND_PAYMENT', businessNo: randomUUID(), status: 'SUCCEEDED', payload: { paymentBusinessNo: payment.businessNo } } });
    return operation.businessNo;
  }
  if (kind === 'compensation-refund') return `compensation:refund:${payment.id}`;
  if (kind === 'compensation-disburse') return `compensation:disburse:${payment.id}`;
  if (kind === 'compensation-stored') return payment.businessNo;
  // The approved stable collection operation may differ from imported payment.businessNo.
  return `compensation:payment:${payment.id}`;
}

const scenarios = (['current', 'predecessor'] as const).flatMap(scope => kinds.flatMap(kind => (['withdraw', 'reject'] as const).map(command => ({ scope, kind, command }))));
it.each(scenarios)('blocks $command for $scope $kind pending facts despite completed progress', async ({ scope, kind, command }) => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const previous = scope === 'predecessor' ? await h.prisma.afterSalesCase.create({ data: { orderId: order.id, applicantId: h.actors.initiator.id, reason: '导入的前序关闭结果', status: 'WITHDRAWN', closedAt: h.clock.now() } }) : null;
  const opened = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '核验售后资金及退货事实', ...(previous ? { previousCaseId: previous.id } : {}) }).expect(201)).body;
  const businessNo = await completedFact(kind, order.id, previous?.id ?? opened.case.id, opened.case.rootDisputeId);
  const event = await h.prisma.integrationEvent.create({ data: {
    provider: 'simulated', eventId: randomUUID(), kind: kind.startsWith('return-') ? 'SHIPMENT_PROGRESS' : 'PAYMENT_SUCCEEDED', businessNo,
    occurredAt: h.clock.now(), payload: {},
    ...(kind.endsWith('outbox') ? { receipt: { create: { status: 'REJECTED', reason: 'WAITING_VERIFICATION' } } } : kind === 'compensation-refund' || kind === 'compensation-disburse' ? { receipt: { create: { status: 'PENDING' } } } : {}),
  } });
  const key = randomUUID();
  let invoke: () => ReturnType<typeof h.command>;
  if (command === 'withdraw') {
    const requested = (await h.command(h.actors.initiator, `/api/after-sales/${opened.case.id}/withdraw`, { expectedCaseVersion: opened.case.version, expectedOrderVersion: opened.orderVersion, reason: '申请双方撤回' }).expect(200)).body;
    const record = await h.prisma.caseRecord.findFirstOrThrow({ where: { caseId: opened.case.id, kind: 'WITHDRAWAL_REQUESTED' } });
    invoke = () => h.command(h.actors.recipient, `/api/after-sales/${opened.case.id}/withdraw/respond`, { expectedCaseVersion: requested.case.version, expectedOrderVersion: requested.orderVersion, withdrawalRequestId: record.id, decision: 'AGREE' }, key);
  } else {
    const session = await h.operatorLogin(h.actors.operations);
    expect(session.response.status).toBe(201);
    invoke = () => request(h.app.getHttpServer()).post(`/api/admin/after-sales/${opened.case.id}/reject`).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send({ expectedCaseVersion: opened.case.version, expectedOrderVersion: opened.orderVersion, reason: '普通工单驳回核验' });
  }
  const snapshot = async () => ({
    value: await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } }),
    order: await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    records: await h.prisma.caseRecord.count({ where: { caseId: opened.case.id } }),
    audits: await h.prisma.auditLog.count(), cache: await h.prisma.idempotencyRecord.count({ where: { key } }),
    blocker: await h.prisma.orderHoldBlocker.findMany({ where: { orderId: order.id } }),
  });
  const before = await snapshot();
  await invoke().expect(409).expect(r => expect(r.body.code).toBe('FUNDS_UNRESOLVED'));
  expect(await snapshot()).toEqual(before);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: opened.case.id } })).closedAt).toBeNull();
  // A verified receipt unblocks the same logical command; the rejected write
  // leaves neither an idempotency result nor any owning-domain mutation.
  await h.prisma.integrationEventReceipt.upsert({ where: { eventId: event.id }, create: { eventId: event.id, status: 'PROCESSED', processedAt: h.clock.now() }, update: { status: 'PROCESSED', processedAt: h.clock.now() } });
  await invoke().expect(200).expect(r => expect(r.body.case.status).toBe(command === 'withdraw' ? 'WITHDRAWN' : 'REJECTED'));
});
it('does not block a safe close with an unrelated root-dispute pending fact', async () => {
  const otherOrder = await h.prepareOrder({ mode: 'IN_PERSON' });
  const other = (await h.command(h.actors.initiator, `/api/orders/${otherOrder.id}/after-sales`, { expectedOrderVersion: 1, reason: '独立的另一根争议' }).expect(201)).body;
  const businessNo = await completedFact('compensation-payment', otherOrder.id, other.case.id, other.case.rootDisputeId);
  await h.prisma.integrationEvent.create({ data: { provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo, occurredAt: h.clock.now(), payload: {} } });
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const opened = (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: 1, reason: '没有未解事实的根争议' }).expect(201)).body;
  const requested = (await h.command(h.actors.initiator, `/api/after-sales/${opened.case.id}/withdraw`, { expectedCaseVersion: 1, expectedOrderVersion: 2, reason: '安全撤回' }).expect(200)).body;
  const record = await h.prisma.caseRecord.findFirstOrThrow({ where: { caseId: opened.case.id, kind: 'WITHDRAWAL_REQUESTED' } });
  await h.command(h.actors.recipient, `/api/after-sales/${opened.case.id}/withdraw/respond`, { expectedCaseVersion: requested.case.version, expectedOrderVersion: requested.orderVersion, withdrawalRequestId: record.id, decision: 'AGREE' }).expect(200).expect(r => expect(r.body.case.status).toBe('WITHDRAWN'));
});
