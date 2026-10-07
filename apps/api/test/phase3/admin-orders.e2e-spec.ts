import { randomUUID } from 'node:crypto';
import { OrderListViewSchema, OrderViewSchema } from '@barter/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as reader from '../../src/orders/order-reader.js';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';

let h: OrderHarness;
beforeAll(async () => { h = await createOrderHarness(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await h?.close(); });
const listPath = '/api/admin/orders';
async function newOrder(mode: 'COURIER' | 'IN_PERSON' = 'COURIER') {
  h.clock.set('2026-10-03T00:00:00.000Z');
  return (await h.convert(await h.confirmedProposal({ mode })).expect(201)).body.order;
}

it.each(['OPERATIONS', 'REVIEWER', 'SUPER_ADMIN'] as const)('allows %s independent read-only summaries', async role => {
  await h.prisma.userRole.deleteMany({ where: { userId: h.actors.operator.id } });
  await h.prisma.userRole.create({ data: { userId: h.actors.operator.id, role } });
  const order = await newOrder();
  const detail = OrderViewSchema.parse((await h.get(h.actors.operator, `${listPath}/${order.id}`).expect(200)).body);
  expect(detail.id).toBe(order.id);
  const list = OrderListViewSchema.parse((await h.get(h.actors.operator, listPath).expect(200)).body);
  expect(list.items.some(o => o.id === order.id)).toBe(true);
});

it('rejects customers and mixed identities and requires authentication', async () => {
  const order = await newOrder();
  for (const path of [listPath, `${listPath}/${order.id}`]) {
    await request(h.app.getHttpServer()).get(path).expect(401);
    for (const actor of [h.actors.initiator, h.actors.outsider, h.actors.mixed]) {
      await h.get(actor, path).expect(403).expect(({ body }) => expect(body.code).toBe('FORBIDDEN'));
    }
  }
});

it('registers no impersonation commands or private address/checkout reads', async () => {
  const order = await newOrder();
  for (const suffix of ['', '/address', '/payments', '/shipments', '/handover', '/acceptance', '/issue', '/cancellation', '/cancellation/respond', '/cancellation/withdraw']) {
    await h.command(h.actors.operator, `${listPath}/${order.id}${suffix}`, { expectedVersion: 1 }).expect(404);
  }
  await h.command(h.actors.operator, listPath, {}).expect(404);
  await h.get(h.actors.operator, `${listPath}/${order.id}/shipping-address?side=self`).expect(404);
  await h.get(h.actors.operator, `${listPath}/${order.id}/payments/${randomUUID()}/checkout`).expect(404);
});

it('keeps overdue status, revisions, audit, outbox leases and reservations unchanged', async () => {
  const order = await newOrder();
  await h.prisma.outboxCommand.create({ data: { orderId: order.id, kind: 'CREATE_PAYMENT', businessNo: randomUUID(), payload: { amountFen: 1000, currency: 'CNY' }, status: 'PROCESSING', leaseOwner: 'readonly-test', leaseExpiresAt: new Date('2026-10-07T00:00:00.000Z') } });
  const snapshot = async () => ({
    order: await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    audit: await h.prisma.auditLog.findMany({ where: { entityId: order.id }, orderBy: { id: 'asc' } }),
    outbox: await h.prisma.outboxCommand.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } }),
    reservations: await h.prisma.itemReservation.findMany({ where: { orderId: order.id }, orderBy: { itemId: 'asc' } }),
  });
  const before = await snapshot(); h.clock.advance(96 * 3600000);
  expect((await h.get(h.actors.operator, `${listPath}/${order.id}`).expect(200)).body.status).toBe('AWAITING_DETAILS');
  expect((await h.get(h.actors.operator, `${listPath}?status=AWAITING_DETAILS&limit=100`).expect(200)).body.items.some((o: { id: string }) => o.id === order.id)).toBe(true);
  expect(await snapshot()).toEqual(before);
});

it('projects safe payment, shipment, handover, deadlines and the latest bounded cancellation', async () => {
  const order = await newOrder();
  const address = { expectedVersion: 1, recipientName: '隐私姓名', phone: '13900001234', region: '私密地区', detail: '完整私密街道门牌' };
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, address).expect(200);
  await h.prisma.paymentIntent.create({ data: { orderId: order.id, side: 'INITIATOR', purpose: 'DEPOSIT', amountFen: 1000, businessNo: randomUUID(), provider: 'simulated', checkoutParams: { secret: 'checkout-private-value' } } });
  await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } }, data: { handedOverAt: new Date('2026-10-03T01:00:00.000Z'), incomingDeliveredAt: new Date('2026-10-03T02:00:00.000Z'), acceptanceDeadline: new Date('2026-10-06T02:00:00.000Z') } });
  await h.prisma.shipment.create({ data: { orderId: order.id, side: 'RECIPIENT', carrier: 'SF', trackingNumber: 'ADMINSAFE123', businessNo: randomUUID(), status: 'REGISTERED', registeredAt: h.clock.now() } });
  const past = await h.prisma.orderCancellation.create({ data: { orderId: order.id, requestedBySide: 'INITIATOR', reason: '旧的取消理由', requestedVersion: 1, requestedAt: h.clock.now(), status: 'WITHDRAWN' } });
  const latest = await h.prisma.orderCancellation.create({ data: { orderId: order.id, requestedBySide: 'RECIPIENT', reason: '最新取消理由', requestedVersion: 2, requestedAt: h.clock.now() } });
  for (const body of [(await h.get(h.actors.operator, `${listPath}/${order.id}`).expect(200)).body, (await h.get(h.actors.operator, `${listPath}?limit=100`).expect(200)).body.items.find((o: { id: string }) => o.id === order.id)]) {
    const view = OrderViewSchema.parse(body);
    expect(view.parties.find(p => p.side === 'INITIATOR')).toMatchObject({ addressReady: true, handedOverAt: '2026-10-03T01:00:00.000Z', incomingDeliveredAt: '2026-10-03T02:00:00.000Z', acceptanceDeadline: '2026-10-06T02:00:00.000Z', payments: [{ purpose: 'DEPOSIT', amountFen: 1000, status: 'CREATED' }] });
    expect(view.parties.find(p => p.side === 'RECIPIENT')!.outgoingShipment).toMatchObject({ status: 'REGISTERED', trackingNumber: 'ADMINSAFE123' });
    expect(view.cancellation?.id).toBe(latest.id);
    const json = JSON.stringify(view);
    for (const privateValue of [address.phone, address.recipientName, address.region, address.detail, 'checkout-private-value', past.id]) expect(json).not.toContain(privateValue);
    expect(json).not.toMatch(/ciphertext|checkoutParams|keyVersion|nonce|leaseOwner/);
  }
});

it('uses consistent RepeatableRead snapshots for both detail and batched list without overlapping queries', async () => {
  const order = await newOrder();
  const original = reader.readOrderRelations; const originalRead = reader.readOrder; let injected = 0;
  const warnings: string[] = []; const collect = (warning: Error) => { warnings.push(warning.message); };
  process.on('warning', collect);
  try {
    const inject: typeof reader.readOrderRelations = async (tx, orders) => {
      if (orders.some(o => o.id === order.id)) {
        const [isolation] = await tx.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
        expect(isolation!.transaction_isolation).toBe('repeatable read');
        injected++;
        await h.prisma.$transaction(async writer => {
          await writer.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
          await writer.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } }, data: { addressReady: injected === 1 } });
        });
      }
      return original(tx, orders);
    };
    vi.spyOn(reader, 'readOrderRelations').mockImplementation(inject);
    vi.spyOn(reader, 'readOrder').mockImplementation(async (tx, id) => {
      const row = await tx.order.findUniqueOrThrow({ where: { id } });
      await inject(tx, [row]);
      return originalRead(tx, id);
    });
    const detail = (await h.get(h.actors.operator, `${listPath}/${order.id}`).expect(200)).body;
    expect(detail.version).toBe(1); expect(detail.parties.find((p: { side: string }) => p.side === 'INITIATOR').addressReady).toBe(false);
    const list = (await h.get(h.actors.operator, `${listPath}?limit=100`).expect(200)).body.items.find((o: { id: string }) => o.id === order.id);
    expect(list.version).toBe(2); expect(list.parties.find((p: { side: string }) => p.side === 'INITIATOR').addressReady).toBe(true);
    expect(injected).toBe(2);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(warnings.some(message => message.includes('client.query() when the client is already executing'))).toBe(false);
  } finally { process.removeListener('warning', collect); }
});

it('paginates equal timestamps stably with default 20, max 100 and ON_HOLD exception filtering', async () => {
  const baseline = await h.prisma.order.count();
  for (let n = 0; n < 22; n++) await newOrder();
  const hold = await newOrder();
  await h.prisma.order.update({ where: { id: hold.id }, data: { status: 'ON_HOLD', holdReason: '物流异常待处理' } });
  const first = OrderListViewSchema.parse((await h.get(h.actors.operator, listPath).expect(200)).body);
  expect(first.items).toHaveLength(20); expect(first.nextCursor).not.toBeNull();
  const second = OrderListViewSchema.parse((await h.get(h.actors.operator, `${listPath}?cursor=${first.nextCursor}&limit=100`).expect(200)).body);
  const all = [...first.items, ...second.items];
  expect(all).toHaveLength(baseline + 23); expect(new Set(all.map(o => o.id)).size).toBe(all.length); expect(second.nextCursor).toBeNull();
  expect(all.map(o => o.id)).toEqual([...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(o => o.id));
  expect((await h.get(h.actors.operator, `${listPath}?status=ON_HOLD&limit=100`).expect(200)).body.items.map((o: { id: string }) => o.id)).toEqual([hold.id]);
});

it('rejects the same strict malformed queries on operator and participant paths and returns unknown order 404', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=1&limit=2', 'status=bogus', 'status=ON_HOLD&status=CANCELLED', 'unknown=1', 'cursor=invalid', 'cursor=e30=', `cursor=${Buffer.from(JSON.stringify({ createdAt: 'bad', id: randomUUID() })).toString('base64url')}`, `cursor=${Buffer.from(JSON.stringify({ createdAt: '2026-10-03T00:00:00.000Z', id: randomUUID(), extra: true })).toString('base64url')}`]) {
    await h.get(h.actors.operator, `${listPath}?${query}`).expect(400).expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
    await h.get(h.actors.initiator, `/api/me/orders?${query}`).expect(400);
  }
  await h.get(h.actors.operator, `${listPath}/${randomUUID()}`).expect(404).expect(({ body }) => expect(body.code).toBe('ORDER_NOT_FOUND'));
});
