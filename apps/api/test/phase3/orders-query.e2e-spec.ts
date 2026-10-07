import { randomUUID } from 'node:crypto';
import { OrderListViewSchema, OrderViewSchema } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as reader from '../../src/orders/order-reader.js';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
let h: OrderHarness;
beforeAll(async () => { h = await createOrderHarness(); });
afterAll(async () => { await h?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
it('loads order relations in a transaction without overlapping pg queries', async () => {
  const warnings: string[] = [];
  const collect = (warning: Error) => { warnings.push(warning.message); };
  process.on('warning', collect);
  try {
    await h.convert(await h.confirmedProposal()).expect(201);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(warnings.some(message => message.includes('client.query() when the client is already executing'))).toBe(false);
  } finally { process.removeListener('warning', collect); }
});
it('returns one consistent revision when a command commits between order and relation reads', async () => {
  const { order } = (await h.convert(await h.confirmedProposal()).expect(201)).body;
  const original = reader.readOrder;
  let injections = 0;
  vi.spyOn(reader, 'readOrder').mockImplementation(async (tx, id) => {
    // Preliminary authorization/expiry reads are not the returned snapshot.
    const [isolation] = await tx.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
    if (injections !== 0 || id !== order.id || isolation!.transaction_isolation !== 'repeatable read') return original(tx, id);
    injections++;
    // Real first read establishes the snapshot before another transaction commits.
    await tx.order.findUniqueOrThrow({ where: { id } });
    await h.prisma.$transaction(async writer => {
      await writer.order.update({ where: { id }, data: { version: { increment: 1 } } });
      await writer.orderPartyProgress.update({ where: { orderId_side: { orderId: id, side: 'INITIATOR' } }, data: { addressReady: true } });
    });
    return original(tx, id);
  });
  const view = OrderViewSchema.parse((await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(200)).body);
  expect(injections).toBe(1);
  expect(view.version).toBe(1); expect(view.parties.find(party => party.side === 'INITIATOR')!.addressReady).toBe(false);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
});
it('provides participant-only summaries and never exposes private records in response/cache/audit', async () => {
  const proposal = await h.confirmedProposal(); const key = randomUUID();
  const { order } = (await h.convert(proposal, undefined, key).expect(201)).body;
  await h.prisma.paymentIntent.create({ data: { orderId: order.id, side: 'INITIATOR', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', checkoutParams: { secret: 'private-checkout-credential' } } });
  await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } }, data: { incomingDeliveredAt: new Date('2026-10-03T01:00:00.000Z'), acceptanceDeadline: new Date('2026-10-06T01:00:00.000Z') } });
  await h.prisma.shipment.create({ data: { orderId: order.id, side: 'INITIATOR', carrier: 'SF', trackingNumber: 'TEST1234', businessNo: randomUUID(), status: 'COLLECTED', registeredAt: new Date('2026-10-03T00:00:00.000Z'), collectedAt: new Date('2026-10-03T00:30:00.000Z') } });
  const cancellation = await h.prisma.orderCancellation.create({ data: { orderId: order.id, requestedBySide: 'RECIPIENT', reason: '测试取消理由', requestedVersion: 1, requestedAt: new Date('2026-10-03T02:00:00.000Z') } });
  for (const actor of [h.actors.initiator, h.actors.recipient]) {
    const view = OrderViewSchema.parse((await h.get(actor, `/api/orders/${order.id}`).expect(200)).body);
    expect(view.parties.find(p => p.side === 'INITIATOR')!.payments[0]).toMatchObject({ purpose: 'DEPOSIT', amountFen: 1000, status: 'CREATED' });
    expect(view.parties.find(p => p.side === 'INITIATOR')!.outgoingShipment).toMatchObject({ carrier: 'SF', trackingNumber: 'TEST1234', status: 'COLLECTED', collectedAt: '2026-10-03T00:30:00.000Z', deliveredAt: null });
    expect(view.parties.find(p => p.side === 'RECIPIENT')).toMatchObject({ incomingDeliveredAt: '2026-10-03T01:00:00.000Z', acceptanceDeadline: '2026-10-06T01:00:00.000Z', acceptedAt: null });
    expect(view.cancellation).toMatchObject({ id: cancellation.id, status: 'REQUESTED', requestedBySide: 'RECIPIENT', respondedAt: null });
    expect(JSON.stringify(view)).not.toContain('private-checkout-credential');
  }
  await h.get(h.actors.outsider, `/api/orders/${order.id}`).expect(404).expect(({ body }) => expect(body.code).toBe('ORDER_NOT_FOUND'));
  await h.get(h.actors.initiator, `/api/orders/${randomUUID()}`).expect(404);
  await h.get(h.actors.operator, `/api/orders/${order.id}`).expect(403);
  await h.get(h.actors.mixed, `/api/orders/${order.id}`).expect(403);
  const persisted = JSON.stringify({ records: await h.prisma.idempotencyRecord.findMany({ where: { key } }), audits: await h.prisma.auditLog.findMany({ where: { entityId: order.id } }) });
  expect(persisted).not.toMatch(/checkoutParams|ciphertext|phone|recipientName|private-checkout/);
});
it('paginates by timestamp and id, filters status, and strictly validates cursors/limits', async () => {
  const baseline = await h.prisma.order.count({ where: { initiatorId: h.actors.initiator.id } });
  const ids: string[] = [];
  for (let i = 0; i < 22; i++) {
    const proposal = await h.confirmedProposal({ mode: i % 2 ? 'IN_PERSON' : 'COURIER' });
    ids.push((await h.convert(proposal).expect(201)).body.order.id);
  }
  const first = OrderListViewSchema.parse((await h.get(h.actors.initiator, '/api/me/orders').expect(200)).body);
  expect(first.items).toHaveLength(20); expect(first.nextCursor).not.toBeNull();
  const second = OrderListViewSchema.parse((await h.get(h.actors.initiator, `/api/me/orders?cursor=${first.nextCursor}`).expect(200)).body);
  expect(second.nextCursor).toBeNull();
  const all = [...first.items, ...second.items];
  expect(new Set(all.map(order => order.id)).size).toBe(baseline + 22);
  expect(all.map(order => order.id)).toEqual([...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(order => order.id));
  expect(ids.every(id => all.some(order => order.id === id))).toBe(true);
  const filtered = (await h.get(h.actors.recipient, '/api/me/orders?status=AWAITING_PAYMENT&limit=100').expect(200)).body;
  expect(filtered.items).toHaveLength(11); expect(filtered.items.every((order: { status: string }) => order.status === 'AWAITING_PAYMENT')).toBe(true);
  expect((await h.get(h.actors.outsider, '/api/me/orders').expect(200)).body).toEqual({ items: [], nextCursor: null });
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'status=bogus', 'cursor=invalid', `cursor=${Buffer.from(JSON.stringify({ createdAt: 'bad', id: randomUUID() })).toString('base64url')}`, 'cursor=e30=']) await h.get(h.actors.initiator, `/api/me/orders?${query}`).expect(400);
});
