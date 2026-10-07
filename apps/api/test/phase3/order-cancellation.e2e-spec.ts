import { randomUUID } from 'node:crypto';
import { OrderCommandResultSchema } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { AuditService } from '../../src/audit/audit.service.js';
import { OrderCancellationService } from '../../src/orders/order-cancellation.service.js';
import { readOrder, readOrderRelations } from '../../src/orders/order-reader.js';
import type { PaymentIntent, FinancialEntryType } from '../../src/generated/prisma/client.js';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';

let h: OrderHarness;
beforeAll(async () => { h = await createOrderHarness(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await h?.close(); });
async function order(mode: 'COURIER' | 'IN_PERSON' = 'COURIER', offeredCount = 1) {
  return (await h.convert(await h.confirmedProposal({ mode, offeredCount })).expect(201)).body.order;
}
const path = (id: string, suffix = '') => `/api/orders/${id}/cancellation${suffix}`;
async function requested(id: string, expectedVersion = 1) {
  return (await h.command(h.actors.initiator, path(id), { expectedVersion, reason: '双方协商取消交换' }).expect(200)).body.order;
}
function agree(id: string, cancellationId: string, expectedVersion = 2, key = randomUUID()) {
  return h.command(h.actors.recipient, path(id, '/respond'), { expectedVersion, cancellationId, decision: 'AGREE' }, key);
}
// Removing the same-transaction safe release must leave reservations and fail this test.
it.each(['COURIER', 'IN_PERSON'] as const)('agrees and safely releases six items without payment intents in %s', async mode => {
  const created = await order(mode, 5); const pending = await requested(created.id);
  expect(pending.status).toBe(mode === 'COURIER' ? 'AWAITING_DETAILS' : 'AWAITING_PAYMENT');
  expect(pending.version).toBe(2); expect(pending.cancellation.status).toBe('REQUESTED');
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(6);
  const key = randomUUID(); const agreed = await agree(created.id, pending.cancellation.id, 2, key).expect(200);
  const result = OrderCommandResultSchema.parse(agreed.body);
  expect(result.order.status).toBe('CANCELLED'); expect(result.order.version).toBe(3);
  expect(result.order.cancellation?.status).toBe('AGREED');
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(0);
  const items = await h.prisma.item.findMany({ where: { id: { in: created.items.map((item: { itemId: string }) => item.itemId) } } });
  expect(items).toHaveLength(6); expect(items.every(item => item.status === 'ACTIVE' && item.version === 3)).toBe(true);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id } })).toBe(0);
  const now = h.clock.now(); h.clock.advance(100 * 3600000);
  try { expect((await agree(created.id, pending.cancellation.id, 2, key).expect(200)).body).toEqual(agreed.body); }
  finally { h.clock.set(now); }
  expect(await h.prisma.auditLog.count({ where: { entityId: created.id, action: 'ORDER_CANCELLATION_AGREED' } })).toBe(1);
});
it('permits only the opposite participant to respond and only the requester to withdraw', async () => {
  const created = await order(); const pending = await requested(created.id);
  await h.command(h.actors.initiator, path(created.id, '/respond'), { expectedVersion: 2, cancellationId: pending.cancellation.id, decision: 'AGREE' }).expect(409);
  await h.command(h.actors.recipient, path(created.id, '/withdraw'), { expectedVersion: 2, cancellationId: pending.cancellation.id }).expect(409);
  for (const actor of [h.actors.outsider, h.actors.operator, h.actors.mixed]) {
    const status = actor === h.actors.outsider ? 404 : 403;
    await h.command(actor, path(created.id), { expectedVersion: 2, reason: '没有权限的取消请求' }).expect(status);
    await h.command(actor, path(created.id, '/respond'), { expectedVersion: 2, cancellationId: pending.cancellation.id, decision: 'AGREE' }).expect(status);
    await h.command(actor, path(created.id, '/withdraw'), { expectedVersion: 2, cancellationId: pending.cancellation.id }).expect(status);
  }
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).version).toBe(2);
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
});
it('replays one request, rejects second pending requests and conflicting keys without renewing deadlines', async () => {
  const created = await order(); const another = await order(); const key = randomUUID();
  const input = { expectedVersion: 1, reason: '希望取消本次交换' };
  const responses = await Promise.all([h.command(h.actors.initiator, path(created.id), input, key), h.command(h.actors.initiator, path(created.id), input, key)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]); expect(responses[0].body).toEqual(responses[1].body);
  await h.command(h.actors.recipient, path(created.id), { expectedVersion: 2, reason: '同时发起另一份取消' }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_CANCELLATION_PENDING'));
  await h.command(h.actors.initiator, path(created.id), { ...input, reason: '变更原请求的内容' }, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  await h.command(h.actors.initiator, path(another.id), input, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  expect(await h.prisma.orderCancellation.count({ where: { orderId: created.id } })).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).detailsDeadline?.toISOString()).toBe(created.detailsDeadline);
  expect(await h.prisma.auditLog.count({ where: { entityId: created.id, action: 'ORDER_CANCELLATION_REQUESTED' } })).toBe(1);
});
it('preserves rejected and withdrawn history and refuses historical or foreign request ids', async () => {
  const created = await order(); const first = await requested(created.id);
  await h.command(h.actors.recipient, path(created.id, '/respond'), { expectedVersion: 2, cancellationId: first.cancellation.id, decision: 'REJECT' }).expect(200);
  const second = await requested(created.id, 3);
  await agree(created.id, first.cancellation.id, 4).expect(409);
  await h.command(h.actors.initiator, path(created.id, '/withdraw'), { expectedVersion: 4, cancellationId: randomUUID() }).expect(409);
  await h.command(h.actors.initiator, path(created.id, '/withdraw'), { expectedVersion: 4, cancellationId: second.cancellation.id }).expect(200);
  const history = await h.prisma.orderCancellation.findMany({ where: { orderId: created.id }, orderBy: { requestedVersion: 'asc' } });
  expect(history.map(row => row.status)).toEqual(['REJECTED', 'WITHDRAWN']);
  expect(history.every(row => row.respondedAt !== null)).toBe(true);
  const current = (await h.get(h.actors.recipient, `/api/orders/${created.id}`).expect(200)).body;
  expect(current.cancellation.id).toBe(second.cancellation.id); expect(current.version).toBe(5);
  expect(current.detailsDeadline).toBe(created.detailsDeadline);
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
});
it('uses order version to serialize agreement versus withdrawal', async () => {
  const created = await order(); const pending = await requested(created.id);
  const results = await Promise.all([
    agree(created.id, pending.cancellation.id),
    h.command(h.actors.initiator, path(created.id, '/withdraw'), { expectedVersion: 2, cancellationId: pending.cancellation.id }),
  ]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect(results.find(result => result.status === 409)!.body.code).toBe('ORDER_VERSION_CONFLICT');
  const saved = await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  expect(saved.version).toBe(3);
  const cancellation = await h.prisma.orderCancellation.findUniqueOrThrow({ where: { id: pending.cancellation.id } });
  expect(['AGREED', 'WITHDRAWN']).toContain(cancellation.status);
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(cancellation.status === 'AGREED' ? 0 : 2);
});
it.each(['shipment', 'handover'] as const)('blocks requests and agreement after any %s registration', async kind => {
  const created = await order(kind === 'handover' ? 'IN_PERSON' : 'COURIER'); const pending = await requested(created.id);
  if (kind === 'shipment') await h.prisma.shipment.create({ data: { orderId: created.id, side: 'INITIATOR', carrier: 'SF', trackingNumber: randomUUID(), businessNo: randomUUID() } });
  else await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: created.id, side: 'INITIATOR' } }, data: { handedOverAt: h.clock.now() } });
  await agree(created.id, pending.cancellation.id).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_FULFILLMENT_STARTED'));
  await h.command(h.actors.recipient, path(created.id), { expectedVersion: 2, reason: '已交接后的取消请求' }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_FULFILLMENT_STARTED'));
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
  expect((await h.prisma.orderCancellation.findUniqueOrThrow({ where: { id: pending.cancellation.id } })).status).toBe('REQUESTED');
});
it.each(['PAID', 'UNKNOWN', 'PENDING', 'CREATED', 'FAILED'] as const)('retains six reservations for %s intent and queues a safe original-payment operation', async status => {
  const created = await order('IN_PERSON', 5);
  const intent = await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'INITIATOR', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status } });
  const pending = await requested(created.id); const paidCancellation = await agree(created.id, pending.cancellation.id).expect(200);
  expect(paidCancellation.body.order.status).toBe('CANCEL_PENDING');
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(6);
  const commands = await h.prisma.outboxCommand.findMany({ where: { orderId: created.id } });
  expect(commands).toHaveLength(1); expect(commands[0].kind).toBe(status === 'PAID' ? 'REFUND_PAYMENT' : 'CLOSE_PAYMENT');
  expect(commands[0].payload).toEqual({ paymentBusinessNo: intent.businessNo, amountFen: 1000, currency: 'CNY' });
  expect(commands[0].status).toBe('PENDING');
});
it('queues all own immutable deposit and difference obligations with distinct stable business numbers', async () => {
  const created = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON', differenceFen: 20000, payer: 'RECIPIENT' })).expect(201)).body.order;
  const payments = [];
  for (const [side, purpose, amountFen, status] of [
    ['INITIATOR', 'DEPOSIT', 1000, 'PENDING'],
    ['RECIPIENT', 'DEPOSIT', 1000, 'PAID'],
    ['RECIPIENT', 'DIFFERENCE', 20000, 'PAID'],
  ] as const) {
    payments.push(await h.prisma.paymentIntent.create({ data: { orderId: created.id, side, purpose, amountFen, status, businessNo: randomUUID(), provider: 'simulated', checkoutParams: { secret: 'never-enqueue-checkout' } } }));
  }
  const pending = await requested(created.id); await agree(created.id, pending.cancellation.id).expect(200);
  const outbox = await h.prisma.outboxCommand.findMany({ where: { orderId: created.id } });
  expect(outbox).toHaveLength(3);
  for (const [index, payment] of payments.entries()) {
    const command = outbox.find(row => row.businessNo === `${index === 0 ? 'close' : 'refund'}:${payment.id}`)!;
    expect(command.kind).toBe(index === 0 ? 'CLOSE_PAYMENT' : 'REFUND_PAYMENT');
    expect(command.payload).toEqual({ paymentBusinessNo: payment.businessNo, amountFen: index === 2 ? 20000 : 1000, currency: 'CNY' });
  }
  expect(JSON.stringify(outbox)).not.toContain('never-enqueue-checkout');
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
});
it.each(['request', 'agreement'] as const)('rolls back the complete %s transaction after a real audit insert fails', async action => {
  const created = await order(); const pending = action === 'agreement' ? await requested(created.id) : null;
  const key = randomUUID(); const before = await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } }); const audits = await h.prisma.auditLog.count();
  h.faultAuditOnce(true);
  if (pending) await agree(created.id, pending.cancellation.id, 2, key).expect(500);
  else await h.command(h.actors.initiator, path(created.id), { expectedVersion: 1, reason: '审计失败不得持久化' }, key).expect(500);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).toEqual(before);
  expect(await h.prisma.auditLog.count()).toBe(audits); expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
  const history = await h.prisma.orderCancellation.findMany({ where: { orderId: created.id } });
  expect(history.map(row => row.status)).toEqual(pending ? ['REQUESTED'] : []);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id } })).toBe(0);
});
it('rejects malformed commands and expired new decisions while retaining successful replay', async () => {
  const created = await order(); const key = randomUUID(); const input = { expectedVersion: 1, reason: '取消理由足够详细' };
  const first = await h.command(h.actors.initiator, path(created.id), input, key).expect(200);
  await h.command(h.actors.initiator, path(created.id), { ...input, amountFen: 1000 }).expect(400);
  await h.command(h.actors.recipient, path(created.id, '/respond'), { expectedVersion: 2, decision: 'AGREE' }).expect(400);
  const now = h.clock.now(); h.clock.set(created.detailsDeadline);
  try {
    await agree(created.id, first.body.order.cancellation.id).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_EXPIRED'));
    expect((await h.command(h.actors.initiator, path(created.id), input, key).expect(200)).body).toEqual(first.body);
  } finally { h.clock.set(now); }
});

async function entry(intent: PaymentIntent, entryType: FinancialEntryType, amountFen = 1000) {
  // Trusted fixture, confined to the cloned database: Task 7 owns real receipt processing.
  const businessNo = randomUUID(); const externalTransactionId = randomUUID();
  const kind = entryType === 'PAYMENT' ? 'PAYMENT_SUCCEEDED' : entryType === 'REFUND' ? 'REFUND_SUCCEEDED' : 'DIFFERENCE_SETTLED';
  const event = await h.prisma.integrationEvent.create({ data: { provider: 'simulated', eventId: randomUUID(), kind, businessNo, externalTransactionId, amountFen, currency: 'CNY', occurredAt: h.clock.now(), payload: {}, receipt: { create: { status: 'PROCESSED', processedAt: h.clock.now() } } } });
  await h.prisma.financialEntry.create({ data: { intentId: intent.id, integrationEventId: event.id, entryType, provider: 'simulated', externalTransactionId, businessNo, amountFen, currency: 'CNY', occurredAt: h.clock.now() } });
}
const finalize = (id: string) => h.prisma.$transaction(tx => h.app.get(OrderCancellationService).tryFinalize(tx, id, h.clock.now()));
it('finalizes only closed or fully refunded obligations once, with an audited system revision', async () => {
  const created = await order('IN_PERSON');
  const closed = await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'RECIPIENT', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status: 'UNKNOWN' } });
  const paid = await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'INITIATOR', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status: 'PAID' } });
  await entry(paid, 'PAYMENT');
  const pending = await requested(created.id); await agree(created.id, pending.cancellation.id).expect(200);
  expect(await finalize(created.id)).toBe(false);
  await h.prisma.paymentIntent.update({ where: { id: closed.id }, data: { status: 'CLOSED', closedAt: h.clock.now() } });
  await h.prisma.paymentIntent.update({ where: { id: paid.id }, data: { status: 'REFUNDED', refundedAt: h.clock.now() } });
  // A status without its full refund ledger cannot unlock the items.
  expect(await finalize(created.id)).toBe(false);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).version).toBe(3);
  await entry(paid, 'REFUND');
  expect(await finalize(created.id)).toBe(true); expect(await finalize(created.id)).toBe(false);
  const saved = await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  expect(saved.status).toBe('CANCELLED'); expect(saved.version).toBe(4);
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(0);
  const audits = await h.prisma.auditLog.findMany({ where: { entityId: created.id, action: 'ORDER_CANCELLED' } });
  expect(audits).toHaveLength(1); expect(audits[0].actorId).toBeNull();
});
it.each(['wrong-refund', 'settled', 'handover', 'closed-with-payment'] as const)('does not finalize contradictory %s facts', async fact => {
  const created = await order('IN_PERSON');
  const intent = await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'INITIATOR', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status: 'UNKNOWN' } });
  const pending = await requested(created.id); await agree(created.id, pending.cancellation.id).expect(200);
  if (fact === 'handover') {
    await h.prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'CLOSED', closedAt: h.clock.now() } });
    await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: created.id, side: 'RECIPIENT' } }, data: { handedOverAt: h.clock.now() } });
  } else {
    await entry(intent, 'PAYMENT');
    if (fact === 'closed-with-payment') await h.prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'CLOSED', closedAt: h.clock.now() } });
    else {
      await h.prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'REFUNDED', refundedAt: h.clock.now() } });
      await entry(intent, 'REFUND', fact === 'wrong-refund' ? 999 : 1000);
      if (fact === 'settled') await entry(intent, 'DIFFERENCE_SETTLEMENT');
    }
  }
  expect(await finalize(created.id)).toBe(false);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('CANCEL_PENDING');
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
  expect(await h.prisma.auditLog.count({ where: { entityId: created.id, action: 'ORDER_CANCELLED' } })).toBe(0);
});
it('rolls back queued refunds, agreement, version, audit and cache after a generic audit insert fails', async () => {
  const created = await order('IN_PERSON');
  await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'RECIPIENT', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status: 'PAID' } });
  const pending = await requested(created.id); const before = await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } }); const count = await h.prisma.auditLog.count(); const key = randomUUID();
  const audit = h.app.get(AuditService); const record = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, value) => {
    const row = await record(tx, value);
    if (value.action === 'ORDER_CANCELLATION_AGREED') throw new Error('Injected generic audit failure');
    return row;
  });
  await agree(created.id, pending.cancellation.id, 2, key).expect(500);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).toEqual(before);
  expect(await h.prisma.auditLog.count()).toBe(count); expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id } })).toBe(0);
  expect((await h.prisma.orderCancellation.findUniqueOrThrow({ where: { id: pending.cancellation.id } })).status).toBe('REQUESTED');
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
});
it('rolls back asynchronous safe release and its own revision after a real terminal audit insert fails', async () => {
  const created = await order('IN_PERSON');
  const intent = await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'RECIPIENT', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status: 'PENDING' } });
  const pending = await requested(created.id); await agree(created.id, pending.cancellation.id).expect(200);
  await h.prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'CLOSED', closedAt: h.clock.now() } });
  const count = await h.prisma.auditLog.count(); h.faultAuditOnce(true);
  await expect(finalize(created.id)).rejects.toThrow('Injected audit failure');
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).version).toBe(3);
  expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(2);
  expect(await h.prisma.auditLog.count()).toBe(count);
  vi.restoreAllMocks(); expect(await finalize(created.id)).toBe(true);
});
it('enforces partial uniqueness and immutable cancellation history at the database boundary', async () => {
  const created = await order(); const pending = await requested(created.id);
  await expect(h.prisma.orderCancellation.create({ data: { orderId: created.id, requestedBySide: 'RECIPIENT', reason: '不能重复的未决请求', requestedVersion: 2 } })).rejects.toMatchObject({ code: 'P2002' });
  await h.command(h.actors.recipient, path(created.id, '/respond'), { expectedVersion: 2, cancellationId: pending.cancellation.id, decision: 'REJECT' }).expect(200);
  await expect(h.prisma.orderCancellation.update({ where: { id: pending.cancellation.id }, data: { status: 'AGREED' } })).rejects.toThrow();
  await expect(h.prisma.orderCancellation.delete({ where: { id: pending.cancellation.id } })).rejects.toThrow();
  expect((await h.prisma.orderCancellation.findUniqueOrThrow({ where: { id: pending.cancellation.id } })).status).toBe('REJECTED');
});
it('batches only the latest cancellation for each listed order despite long history and tied timestamps', async () => {
  const orders = [await order(), await order()];
  const latestIds: string[] = [];
  for (const created of orders) {
    for (let version = 1; version <= 30; version++) {
      const row = await h.prisma.orderCancellation.create({ data: { orderId: created.id, requestedBySide: 'INITIATOR', reason: '长期保留的历史取消', requestedVersion: version, requestedAt: h.clock.now() } });
      if (version < 30) await h.prisma.orderCancellation.update({ where: { id: row.id }, data: { status: 'REJECTED', respondedAt: h.clock.now() } });
      else latestIds.push(row.id);
    }
  }
  const rows = await h.prisma.$transaction(tx => readOrderRelations(tx, orders), { isolationLevel: 'RepeatableRead' });
  expect(rows.map(row => row.cancellations[0].id)).toEqual(latestIds);
  expect(rows.every(row => row.cancellations.length === 1)).toBe(true);
});
it('provides an audited system begin path that expires a pending negotiation and cancels without payment intents', async () => {
  const created = await order(); const pending = await requested(created.id); const now = h.clock.now();
  h.clock.set(created.detailsDeadline);
  try {
    await h.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${created.id}::uuid FOR UPDATE`;
      const current = await readOrder(tx, created.id);
      await h.app.get(OrderCancellationService).begin(tx, current!, 'DETAILS_TIMEOUT', null, h.clock.now());
      // The caller owns the single revision of this complete system transition.
      await tx.order.update({ where: { id: created.id }, data: { version: { increment: 1 } } });
    });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('CANCELLED');
    expect((await h.prisma.orderCancellation.findUniqueOrThrow({ where: { id: pending.cancellation.id } })).status).toBe('EXPIRED');
    expect(await h.prisma.auditLog.count({ where: { entityId: pending.cancellation.id, action: 'ORDER_CANCELLATION_EXPIRED', actorId: null } })).toBe(1);
    expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(0);
  } finally { h.clock.set(now); }
});
async function waitForBlocked(blockerPid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await h.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))`;
    if (rows[0].waiting > 0) return;
    await delay(10);
  }
  throw new Error('Expected command to wait on the held database lock');
}
it('timestamps final cancellation after waiting for the financial lock', async () => {
  const created = await order('IN_PERSON');
  const intent = await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'RECIPIENT', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status: 'PENDING' } });
  const pending = await requested(created.id); await agree(created.id, pending.cancellation.id).expect(200);
  await h.prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'CLOSED', closedAt: h.clock.now() } });
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  const now = h.clock.now(); let completion: Promise<boolean> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM "PaymentIntent" WHERE id = $1::uuid FOR UPDATE', [intent.id]);
    completion = finalize(created.id);
    const identity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await waitForBlocked(identity.rows[0].pid);
    h.clock.advance(90000); await blocker.query('COMMIT');
    expect(await completion).toBe(true);
    const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { entityId: created.id, action: 'ORDER_CANCELLED' } });
    expect(audit.after).toMatchObject({ cancelledAt: h.clock.now().toISOString() });
  } finally { await blocker.query('ROLLBACK'); await completion; await blocker.end(); h.clock.set(now); }
});
it.each(['Order', 'Item', 'PaymentIntent'] as const)('rechecks the deadline after waiting for the %s lock', async table => {
  const created = await order('IN_PERSON');
  const intent = await h.prisma.paymentIntent.create({ data: { orderId: created.id, side: 'RECIPIENT', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', status: 'PENDING' } });
  const pending = await requested(created.id); const now = h.clock.now();
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  const key = randomUUID(); let response: Promise<{ status: number; body: { code: string } }> | undefined;
  try {
    await blocker.query('BEGIN');
    const id = table === 'Order' ? created.id : table === 'Item' ? created.items.map((item: { itemId: string }) => item.itemId).sort()[0] : intent.id;
    // Table comes only from the fixed test cases; row id remains parameterized.
    await blocker.query(`SELECT "id" FROM "${table}" WHERE "id" = $1::uuid FOR UPDATE`, [id]);
    response = agree(created.id, pending.cancellation.id, 2, key).then(value => value);
    const identity = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await waitForBlocked(identity.rows[0].pid);
    h.clock.set(created.paymentDeadline); await blocker.query('COMMIT');
    const result = await response;
    expect(result.status).toBe(409); expect(result.body.code).toBe('ORDER_EXPIRED');
    expect(await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ version: 3, status: 'CANCEL_PENDING' });
    expect(await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: created.id } })).toMatchObject({ kind: 'CLOSE_PAYMENT', businessNo: `close:${intent.id}` });
    expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id } })).toBe(1);
    expect(await h.prisma.orderCancellation.findUniqueOrThrow({ where: { id: pending.cancellation.id } })).toMatchObject({ status: 'EXPIRED' });
    expect(await h.prisma.itemReservation.count({ where: { orderId: created.id } })).toBe(created.items.length);
    expect(await h.prisma.auditLog.count({ where: { entityId: created.id, action: 'ORDER_CANCEL_PENDING', actorId: null } })).toBe(1);
    expect(await h.prisma.auditLog.count({ where: { entityId: pending.cancellation.id, action: 'ORDER_CANCELLATION_EXPIRED', actorId: null } })).toBe(1);
    expect(await h.prisma.auditLog.count({ where: { entityId: created.id, action: 'ORDER_CANCELLATION_AGREED' } })).toBe(0);
    expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  } finally { await blocker.query('ROLLBACK'); await response; await blocker.end(); h.clock.set(now); }
});
