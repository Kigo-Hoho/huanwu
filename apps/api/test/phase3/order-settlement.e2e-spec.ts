import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { PaymentOutboxHandler } from '../../src/payments/payment-outbox.handler.js';
import { PaymentEventsService } from '../../src/payments/payment-events.service.js';
import { SimulatedPaymentAdapter } from '../../src/integrations/simulated-payment.adapter.js';
import { OrderHoldService } from '../../src/orders/order-hold.service.js';
import { readOrder } from '../../src/orders/order-reader.js';
import { ReservationsService } from '../../src/reservations/reservations.service.js';
import type { ProviderOperation } from '../../src/integrations/integration.types.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { SettlementService } from '../../src/payments/settlement.service.js';
import { OrderAcceptanceService } from '../../src/orders/order-acceptance.service.js';

let h: OrderHarness;
const environment = new Map<string, string | undefined>();
const signingKey = randomBytes(32);
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'simulated', LOGISTICS_PROVIDER: 'disabled', SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: signingKey.toString('base64') })) { environment.set(key, process.env[key]); process.env[key] = value; }
  h = await createOrderHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.prisma.outboxCommand.updateMany({ where: { status: { in: ['PENDING', 'UNKNOWN', 'PROCESSING'] } }, data: { status: 'UNKNOWN', availableAt: new Date('2099-01-01'), leaseOwner: null, leaseExpiresAt: null } });
});
afterAll(async () => { await h?.close(); for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const current = (id: string) => h.prisma.order.findUniqueOrThrow({ where: { id } });
const worker = () => new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
async function delivered(differenceFen = 0, payer: 'INITIATOR' | 'RECIPIENT' = 'INITIATOR') {
  const order = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON', offeredCount: 5, differenceFen, payer: differenceFen ? payer : 'NONE' })).expect(201)).body.order;
  for (const side of ['initiator', 'recipient'] as const) {
    for (const purpose of differenceFen && side.toUpperCase() === payer ? ['DEPOSIT', 'DIFFERENCE'] : ['DEPOSIT']) {
      const started = await h.command(h.actors[side], `/api/orders/${order.id}/payments`, { expectedVersion: (await current(order.id)).version, purpose }).expect(202);
      await worker().tick();
      await h.command(h.actors[side], `/api/testing/payments/${started.body.paymentIntentId}/complete`, { expectedVersion: (await current(order.id)).version }).expect(200);
    }
  }
  for (const side of ['initiator', 'recipient'] as const) await h.command(h.actors[side], `/api/orders/${order.id}/handover`, { expectedVersion: (await current(order.id)).version }).expect(200);
  return order.id as string;
}
async function accept(id: string, side: 'initiator' | 'recipient') {
  return h.command(h.actors[side], `/api/orders/${id}/acceptance`, { expectedVersion: (await current(id)).version }).expect(200);
}
it.each([0, 700])('requires both acceptances and every trusted obligation before completing six items (%i fen)', async amount => {
  const id = await delivered(amount);
  const beforeItems = await h.prisma.item.findMany({ where: { reservation: { orderId: id } }, orderBy: { id: 'asc' } });
  const before = await current(id);
  const first = await accept(id, 'initiator');
  expect(first.body.order.status).toBe('AWAITING_ACCEPTANCE'); expect(first.body.order.version).toBe(before.version + 1);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: id, kind: { in: ['REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] } } })).toBe(0);
  const second = await accept(id, 'recipient');
  expect(second.body.order.status).toBe('SETTLING'); expect(second.body.order.version).toBe(first.body.order.version + 1);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: id, kind: 'SETTLE_DIFFERENCE' } })).toBe(amount ? 1 : 0);
  h.clock.advance(96 * 3600000); // Old inspection dates no longer govern SETTLING.
  await worker().tick(); expect((await current(id)).status).toBe('SETTLING');
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(6);
  for (let i = 0; i < (amount ? 2 : 1); i++) await worker().tick();
  expect((await current(id)).status).toBe('COMPLETED');
  const items = await h.prisma.item.findMany({ where: { id: { in: beforeItems.map(item => item.id) } }, orderBy: { id: 'asc' } });
  expect(items.map(item => item.status)).toEqual(Array(6).fill('INACTIVE'));
  expect(items.map(item => item.ownerId)).toEqual(beforeItems.map(item => item.ownerId));
  expect(items.map(item => item.version)).toEqual(beforeItems.map(item => item.version + 1));
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(0);
  const operations = await h.prisma.outboxCommand.findMany({ where: { orderId: id, kind: { in: ['REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] } } });
  for (const operation of operations) expect(await h.app.get(SimulatedProviderStore).successCount(operation.businessNo)).toBe(1);
});
it('rolls back acceptance, all tasks, revision and success cache after actual audit insert failure', async () => {
  const id = await delivered(700); await accept(id, 'initiator'); const before = await current(id); const key = randomUUID();
  const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { const row = await original(tx, entry); if (entry.action === 'ORDER_ACCEPTED') throw new Error('Injected acceptance audit failure'); return row; });
  await h.command(h.actors.recipient, `/api/orders/${id}/acceptance`, { expectedVersion: before.version }, key).expect(500);
  expect((await current(id)).version).toBe(before.version); expect((await current(id)).status).toBe('AWAITING_ACCEPTANCE');
  expect(await h.prisma.outboxCommand.count({ where: { orderId: id, kind: { in: ['REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] } } })).toBe(0);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect((await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { orderId_side: { orderId: id, side: 'RECIPIENT' } } })).acceptedAt).toBeNull();
  vi.restoreAllMocks(); await h.command(h.actors.recipient, `/api/orders/${id}/acceptance`, { expectedVersion: before.version }, key).expect(200);
});
it('recovers an independently successful last refund after final audit rollback, without a second external execution', async () => {
  const id = await delivered(); await accept(id, 'initiator'); await accept(id, 'recipient'); await worker().tick();
  const before = await current(id); const audit = h.app.get(AuditService); const original = audit.record.bind(audit);
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { const row = await original(tx, entry); if (entry.action === 'ORDER_COMPLETED') throw new Error('Injected final audit failure'); return row; });
  await worker().tick();
  expect((await current(id)).status).toBe('SETTLING');
  expect(await h.prisma.item.count({ where: { reservation: { orderId: id }, status: 'ACTIVE', version: 3 } })).toBe(6);
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(6);
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: id }, entryType: 'REFUND' } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: id, action: 'ORDER_COMPLETED' } })).toBe(0);
  const failed = await h.prisma.outboxCommand.findFirstOrThrow({ where: { orderId: id, status: 'UNKNOWN', kind: 'REFUND_PAYMENT' } });
  expect(await h.app.get(SimulatedProviderStore).successCount(failed.businessNo)).toBe(1);
  expect((await current(id)).version).toBe(before.version + 1); // Admission committed independently.
  vi.restoreAllMocks(); const execute = vi.spyOn(h.app.get(PaymentOutboxHandler), 'execute');
  await h.prisma.outboxCommand.updateMany({ where: { orderId: id, id: { not: failed.id } }, data: { availableAt: new Date('2099-01-01') } });
  h.clock.advance(30000); await worker().tick();
  expect(execute).not.toHaveBeenCalled(); expect((await current(id)).status).toBe('COMPLETED');
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: id }, entryType: 'REFUND' } })).toBe(2);
});

async function settling(amount = 700, payer: 'INITIATOR' | 'RECIPIENT' = 'INITIATOR') {
  const id = await delivered(amount, payer); await accept(id, 'initiator'); await accept(id, 'recipient');
  const commands = await h.prisma.outboxCommand.findMany({ where: { orderId: id, kind: { in: ['REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] } }, orderBy: { businessNo: 'asc' } });
  return { id, operations: commands.map(c => ({ orderId: id, businessNo: c.businessNo, kind: c.kind, payload: c.payload as Prisma.InputJsonObject } satisfies ProviderOperation)) };
}
async function hold(id: string) {
  await h.prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id}::uuid FOR UPDATE`;
    const order = (await readOrder(tx, id))!;
    await h.app.get(ReservationsService).lockItems(tx, order.items.map(item => item.itemId));
    await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${id}::uuid ORDER BY id FOR UPDATE`;
    await h.app.get(OrderHoldService).enter(tx, (await readOrder(tx, id))!, 'TRUSTED_FINANCIAL_ANOMALY', h.clock.now());
    await tx.order.update({ where: { id }, data: { version: { increment: 1 } } });
  });
}
function barrier() {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, released, enter, release };
}
it('keeps UNKNOWN difference unsettled, reuses the original number, and credits the snapshotted beneficiary', async () => {
  const { id, operations } = await settling(700, 'RECIPIENT'); const handler = h.app.get(PaymentOutboxHandler);
  const difference = operations.find(op => op.kind === 'SETTLE_DIFFERENCE')!;
  for (const operation of operations.filter(op => op !== difference)) { expect(await handler.authorize(operation)).toBe(true); await handler.apply(operation, await handler.execute(operation)); }
  await handler.apply(difference, { status: 'UNKNOWN' }); expect((await current(id)).status).toBe('SETTLING');
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(6);
  expect(await handler.authorize(difference)).toBe(true);
  const success = await handler.execute(difference); await handler.apply(difference, success); await handler.apply(difference, success);
  expect((await current(id)).status).toBe('COMPLETED'); expect(await h.app.get(SimulatedProviderStore).successCount(difference.businessNo)).toBe(1);
  const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_DIFFERENCE_SETTLED', entityId: difference.businessNo.slice('settle:'.length) } });
  expect(audit.after).toMatchObject({ beneficiaryId: h.actors.initiator.id, amountFen: 700 });
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: id }, entryType: 'DIFFERENCE_SETTLEMENT' } })).toBe(1);
});
it('blocks fresh worker dispatch when hold wins the second authorization gate', async () => {
  const { id, operations } = await settling(); const target = operations[0]!;
  await h.prisma.outboxCommand.updateMany({ where: { orderId: id, businessNo: { not: target.businessNo } }, data: { availableAt: new Date('2099-01-01') } });
  const handler = h.app.get(PaymentOutboxHandler); const query = handler.query.bind(handler); const gate = barrier();
  vi.spyOn(handler, 'query').mockImplementation(async op => { const result = await query(op); gate.enter(); await gate.released; return result; });
  const execute = vi.spyOn(handler, 'execute'); const active = worker().tick();
  await gate.entered; try { await hold(id); } finally { gate.release(); } await active;
  expect(execute).not.toHaveBeenCalled(); expect((await current(id)).status).toBe('ON_HOLD');
  expect(await h.app.get(SimulatedProviderStore).successCount(target.businessNo)).toBe(0);
  expect((await current(id)).outstandingObligations).toMatchObject({ financialOperations: [target.businessNo] });
});
it('reconciles a genuinely in-flight settlement after hold, retaining all leases and prohibiting further fresh returns', async () => {
  const { id, operations } = await settling(); const target = operations.find(op => op.kind === 'SETTLE_DIFFERENCE')!;
  await h.prisma.outboxCommand.updateMany({ where: { orderId: id, businessNo: { not: target.businessNo } }, data: { availableAt: new Date('2099-01-01') } });
  const handler = h.app.get(PaymentOutboxHandler); const execute = handler.execute.bind(handler); const gate = barrier();
  vi.spyOn(handler, 'execute').mockImplementation(async op => { gate.enter(); await gate.released; return execute(op); });
  const active = worker().tick(); await gate.entered; try { await hold(id); } finally { gate.release(); } await active;
  expect((await current(id)).status).toBe('ON_HOLD'); expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(6);
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: id }, entryType: 'DIFFERENCE_SETTLEMENT' } })).toBe(1);
  const event = await h.prisma.integrationEvent.findFirstOrThrow({ where: { businessNo: target.businessNo }, include: { receipt: true } }); expect(event.receipt?.reason).toBe('ORDER_ON_HOLD');
  for (const op of operations) expect(await handler.authorize(op)).toBe(false);
});
it('records distinct duplicate settlement events without a second ledger/revision and quarantines terminal contradictions', async () => {
  const { id, operations } = await settling(); const handler = h.app.get(PaymentOutboxHandler); const events = h.app.get(PaymentEventsService);
  for (const op of operations) { expect(await handler.authorize(op)).toBe(true); await handler.apply(op, await handler.execute(op)); }
  const before = await current(id); const difference = operations.find(op => op.kind === 'SETTLE_DIFFERENCE')!;
  const result = await handler.query(difference); expect(result.status).toBe('SUCCESS'); if (result.status !== 'SUCCESS') throw new Error('Missing external fact');
  const sign = (changes: object) => { const raw = JSON.stringify({ ...result.event, eventId: randomUUID(), ...changes }); return h.app.get(SimulatedPaymentAdapter).verifySignedEvent(raw, createHmac('sha256', signingKey).update(raw).digest('hex')); };
  await events.applyVerified(sign({})); expect((await current(id)).version).toBe(before.version);
  await events.applyVerified(sign({ externalTransactionId: randomUUID() }));
  expect(await current(id)).toMatchObject({ status: 'COMPLETED', version: before.version });
  expect(await h.prisma.auditLog.count({ where: { entityId: id, action: 'ORDER_FINANCIAL_ANOMALY' } })).toBe(1);
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(0);
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: id }, entryType: 'DIFFERENCE_SETTLEMENT' } })).toBe(1);
});
it.each(['amount', 'currency', 'original', 'kind'] as const)('quarantines trusted settlement %s mismatches without completing any obligation', async mismatch => {
  const { id, operations } = await settling(); const op = operations.find(value => value.kind === 'SETTLE_DIFFERENCE')!;
  const handler = h.app.get(PaymentOutboxHandler); expect(await handler.authorize(op)).toBe(true);
  const result = await handler.execute(op); if (result.status !== 'SUCCESS') throw new Error('Missing external success');
  const changes = { amount: { amountFen: 701 }, currency: { currency: 'USD' }, original: { businessNo: randomUUID() }, kind: { kind: 'REFUND_SUCCEEDED' } };
  const raw = JSON.stringify({ ...result.event, eventId: randomUUID(), ...changes[mismatch] });
  const event = h.app.get(SimulatedPaymentAdapter).verifySignedEvent(raw, createHmac('sha256', signingKey).update(raw).digest('hex'));
  await h.app.get(PaymentEventsService).applyVerified(event);
  const stored = await h.prisma.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, include: { receipt: true } });
  expect(stored.payload).toEqual(event); expect(stored.receipt?.status).toBe('REJECTED');
  expect((await current(id)).status).toBe('SETTLING'); expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: id }, entryType: 'DIFFERENCE_SETTLEMENT' } })).toBe(0);
});
it('finalizer requires every original lease and disposition, returns false without revision, and never recreates missing occupancy', async () => {
  const { id, operations } = await settling(0); const service = h.app.get(SettlementService); const handler = h.app.get(PaymentOutboxHandler);
  const before = await current(id);
  expect(await h.prisma.$transaction(tx => service.tryFinalize(tx, id, h.clock.now()))).toBe(false);
  expect((await current(id)).version).toBe(before.version);
  const lease = await h.prisma.itemReservation.findFirstOrThrow({ where: { orderId: id } });
  await h.prisma.itemReservation.delete({ where: { itemId: lease.itemId } });
  for (const op of operations) { expect(await handler.authorize(op)).toBe(true); await handler.apply(op, await handler.execute(op)); }
  const reconciled = await current(id);
  expect(await h.prisma.$transaction(tx => service.tryFinalize(tx, id, h.clock.now()))).toBe(false);
  expect((await current(id)).version).toBe(reconciled.version); expect(reconciled.status).toBe('SETTLING');
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(5);
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: id } });
  expect(await h.prisma.item.count({ where: { id: { in: snapshots.map(item => item.itemId) }, status: 'ACTIVE', version: 3 } })).toBe(6);
});
it('reconciles all already saved financial facts on hold without finalizing or changing immutable history', async () => {
  const { id, operations } = await settling(); const handler = h.app.get(PaymentOutboxHandler);
  const results = [];
  for (const op of operations) { expect(await handler.authorize(op)).toBe(true); results.push(await handler.execute(op)); }
  await hold(id);
  for (let i = 0; i < operations.length; i++) await handler.apply(operations[i]!, results[i]!);
  expect((await current(id)).status).toBe('ON_HOLD'); expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(6);
  expect(await h.prisma.financialEntry.count({ where: { intent: { orderId: id } } })).toBe(6);
  expect(await h.prisma.$transaction(tx => h.app.get(SettlementService).tryFinalize(tx, id, h.clock.now()))).toBe(false);
  const entry = await h.prisma.financialEntry.findFirstOrThrow({ where: { intent: { orderId: id }, entryType: 'DIFFERENCE_SETTLEMENT' } });
  await expect(h.prisma.financialEntry.update({ where: { id: entry.id }, data: { amountFen: 1 } })).rejects.toThrow();
  await expect(h.prisma.financialEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
});
it.each(['issue', 'acceptance'] as const)('serializes the second acceptance against an issue when %s owns the order lock first', async winner => {
  const id = await delivered(700); await accept(id, 'initiator'); const before = await current(id);
  const service = h.app.get(OrderAcceptanceService); const audit = h.app.get(AuditService); const record = audit.record.bind(audit); const gate = barrier();
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
    const result = await record(tx, entry);
    if (entry.action === (winner === 'issue' ? 'ORDER_HELD' : 'ORDER_SETTLING')) { gate.enter(); await gate.released; }
    return result;
  });
  const issue = () => service.issue(h.actors.initiator, id, { expectedVersion: before.version, reason: '复查物品发现问题' }, randomUUID());
  const acceptance = () => service.accept(h.actors.recipient, id, { expectedVersion: before.version }, randomUUID());
  const first = winner === 'issue' ? issue() : acceptance(); await gate.entered;
  const second = (winner === 'issue' ? acceptance() : issue()).then(() => 'unexpected', () => 'rejected');
  gate.release(); await first; expect(await second).toBe('rejected');
  expect(await current(id)).toMatchObject({ status: winner === 'issue' ? 'ON_HOLD' : 'SETTLING', version: before.version + 1 });
  expect(await h.prisma.outboxCommand.count({ where: { orderId: id, kind: { in: ['REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] } } })).toBe(winner === 'issue' ? 0 : 3);
  expect(await h.prisma.itemReservation.count({ where: { orderId: id } })).toBe(6);
});
