import { randomBytes, randomUUID } from 'node:crypto';
import { OrderAddressViewSchema, OrderCommandResultSchema, OrderListViewSchema } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as reader from '../../src/orders/order-reader.js';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { AuditService } from '../../src/audit/audit.service.js';

let h: OrderHarness;
const mine = { recipientName: '发起方私密姓名', phone: '13912345678', region: '上海市浦东新区', detail: '发起方保密街123号456室' };
const theirs = { recipientName: '接收方私密姓名', phone: '13887654321', region: '北京市朝阳区', detail: '接收方保密路321号654室' };
beforeAll(async () => { h = await createOrderHarness(); });
beforeEach(() => {
  vi.stubEnv('ADDRESS_ENCRYPTION_KEY_BASE64', randomBytes(32).toString('base64'));
  vi.stubEnv('ADDRESS_ENCRYPTION_KEY_VERSION', 'address-e2e-v1');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await h?.close(); });
async function courier() { return (await h.convert(await h.confirmedProposal()).expect(201)).body.order; }
async function ready() {
  const order = await courier();
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }).expect(200);
  await h.command(h.actors.recipient, `/api/orders/${order.id}/address`, { ...theirs, expectedVersion: 2 }).expect(200);
  return order;
}
async function fundsReady(id: string) {
  // Trusted temporary fixture only; no payment driver/HTTP endpoint is installed.
  await h.prisma.$transaction(async tx => {
    await tx.orderPartyProgress.updateMany({ where: { orderId: id }, data: { fundsReady: true } });
    await tx.order.update({ where: { id }, data: { status: 'AWAITING_FULFILLMENT', fulfillmentDeadline: new Date(h.clock.now().getTime() + 72 * 3600000) } });
  });
}
it.each(['self', 'outgoing'] as const)('reads frozen maximum escaped shipping details through %s GET after successful saves', async access => {
  const order = await courier();
  const escaped = { recipientName: '\u0001'.repeat(80), phone: '\u0001'.repeat(32), region: '\u0001'.repeat(200), detail: '\u0001'.repeat(500) };
  const saved = await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...escaped, expectedVersion: 1 }).expect(200);
  await h.command(h.actors.recipient, `/api/orders/${order.id}/address`, { ...theirs, expectedVersion: 2 }).expect(200);
  await fundsReady(order.id);
  const actor = access === 'self' ? h.actors.initiator : h.actors.recipient;
  const response = await h.get(actor, `/api/orders/${order.id}/shipping-address?side=${access}`).expect(200);
  expect(response.body).toEqual({ ...escaped, orderId: order.id, side: 'INITIATOR', version: 1 });
  const row = await h.prisma.orderAddress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } } });
  expect(row.frozenAt).not.toBeNull(); expect(row.ciphertext.length).toBeGreaterThan(4096);
  const persisted = JSON.stringify({ saved: saved.body, row, cache: await h.prisma.idempotencyRecord.findMany({ where: { commandName: 'SAVE_ORDER_ADDRESS', actorId: h.actors.initiator.id } }), audits: await h.prisma.auditLog.findMany({ where: { entityId: { in: [order.id, row.id] } } }) });
  expect(persisted).not.toContain(JSON.stringify(escaped.phone).slice(1, -1));
  expect(persisted).not.toContain(JSON.stringify(escaped.detail).slice(1, -1));
});
it('stores only encrypted own-side data and returns safe results, summaries, caches and audits', async () => {
  const order = await courier(); const key = randomUUID();
  const first = await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }, key).expect(200);
  const result = OrderCommandResultSchema.parse(first.body);
  expect(result.order.version).toBe(2); expect(result.order.status).toBe('AWAITING_DETAILS');
  expect(result.order.parties.find(p => p.side === 'INITIATOR')!.addressReady).toBe(true);
  expect(result.order.parties.find(p => p.side === 'RECIPIENT')!.addressReady).toBe(false);
  const ownResponse = await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=self`).expect(200);
  expect(ownResponse.headers['cache-control']).toBe('no-store');
  const own = OrderAddressViewSchema.parse(ownResponse.body);
  expect(own).toEqual({ ...mine, orderId: order.id, side: 'INITIATOR', version: 1 });
  const encrypted = await h.prisma.orderAddress.findMany({ where: { orderId: order.id } });
  expect(encrypted).toHaveLength(1); expect(encrypted[0].side).toBe('INITIATOR');
  expect(encrypted[0].nonce).toHaveLength(12); expect(encrypted[0].tag).toHaveLength(16);
  const replay = await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }, key).expect(200);
  expect(replay.body).toEqual(first.body);
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, phone: '13900001111', expectedVersion: 1 }, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  const list = OrderListViewSchema.parse((await h.get(h.actors.initiator, '/api/me/orders').expect(200)).body);
  const safe = JSON.stringify({ result, list, detail: (await h.get(h.actors.recipient, `/api/orders/${order.id}`).expect(200)).body, records: await h.prisma.idempotencyRecord.findMany({ where: { key } }), audits: await h.prisma.auditLog.findMany({ where: { entityId: { in: [order.id, encrypted[0].id] } } }), encrypted });
  for (const secret of Object.values(mine)) expect(safe).not.toContain(secret);
  expect(Buffer.from(encrypted[0].ciphertext).toString('utf8')).not.toContain(mine.phone);
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_ADDRESS_SAVED', entityId: order.id } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_ADDRESS_CHANGED', entityId: encrypted[0].id } })).toBe(1);
});
it('supports own revisions before completion, freezes both on the second save and starts a fresh 24-hour payment deadline', async () => {
  const order = await courier();
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }).expect(200);
  const changed = { ...mine, detail: '修订后的保密地址555室' };
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...changed, expectedVersion: 2 }).expect(200);
  expect((await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=self`).expect(200)).body).toMatchObject({ ...changed, version: 2 });
  h.clock.advance(3600000);
  const final = (await h.command(h.actors.recipient, `/api/orders/${order.id}/address`, { ...theirs, expectedVersion: 3 }).expect(200)).body.order;
  expect(final).toMatchObject({ status: 'AWAITING_PAYMENT', version: 4, detailsDeadline: null, paymentDeadline: new Date(h.clock.now().getTime() + 24 * 3600000).toISOString() });
  const rows = await h.prisma.orderAddress.findMany({ where: { orderId: order.id } });
  expect(rows).toHaveLength(2); expect(rows.every(row => row.frozenAt?.getTime() === h.clock.now().getTime())).toBe(true);
  const revisionAudit = await h.prisma.auditLog.findFirstOrThrow({ where: { entityId: rows.find(row => row.side === 'INITIATOR')!.id, action: 'ORDER_ADDRESS_CHANGED', after: { path: ['version'], equals: 2 } } });
  expect(revisionAudit.before).toEqual({ side: 'INITIATOR', version: 1 }); expect(revisionAudit.after).toEqual({ side: 'INITIATOR', version: 2 });
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_ADDRESSES_FROZEN' } })).toBe(1);
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 4 }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_INVALID_STATE'));
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(4);
});
it('enforces participant/customer identity before private configuration or decryption and rejects caller-selected ownership', async () => {
  const order = await courier(); vi.stubEnv('ADDRESS_ENCRYPTION_KEY_BASE64', undefined);
  for (const actor of [h.actors.outsider, h.actors.operator, h.actors.mixed]) {
    const status = actor === h.actors.outsider ? 404 : 403;
    await h.command(actor, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }).expect(status);
    await h.get(actor, `/api/orders/${order.id}/shipping-address?side=self`).expect(status);
    await h.get(actor, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(status);
  }
  await h.get(h.actors.initiator, `/api/orders/${randomUUID()}/shipping-address?side=self`).expect(404);
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1, side: 'RECIPIENT' }).expect(400);
  for (const query of ['side=RECIPIENT', 'side=self&extra=1', '']) await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?${query}`).expect(400);
});
it('denies unpaid outgoing reads, requires both funds flags and audits only authorized opposite-side reads', async () => {
  const order = await ready();
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_PAYMENT_NOT_READY'));
  await fundsReady(order.id);
  await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } }, data: { fundsReady: false } });
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(409);
  await h.prisma.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } }, data: { fundsReady: true } });
  for (const [actor, expected, side] of [[h.actors.initiator, theirs, 'RECIPIENT'], [h.actors.recipient, mine, 'INITIATOR']] as const) {
    expect((await h.get(actor, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(200)).body).toEqual({ ...expected, orderId: order.id, side, version: 1 });
  }
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=self`).expect(200);
  const audits = await h.prisma.auditLog.findMany({ where: { action: 'ORDER_OUTGOING_ADDRESS_READ', entityId: order.id } });
  expect(audits).toHaveLength(2); expect(audits.map(row => row.actorId).sort()).toEqual([h.actors.initiator.id, h.actors.recipient.id].sort());
  expect(audits.map(row => row.after)).toEqual(expect.arrayContaining([{ side: 'RECIPIENT', version: 1 }, { side: 'INITIATOR', version: 1 }]));
  for (const secret of [...Object.values(mine), ...Object.values(theirs)]) expect(JSON.stringify(audits)).not.toContain(secret);
});
it('denies outgoing access in cancelled, held and completed phases even with historical funding', async () => {
  const order = await ready(); await fundsReady(order.id);
  for (const status of ['CANCEL_PENDING', 'CANCELLED', 'ON_HOLD', 'SETTLING', 'COMPLETED'] as const) {
    await h.prisma.order.update({ where: { id: order.id }, data: { status } });
    await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(409);
    await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=self`).expect(200);
  }
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_OUTGOING_ADDRESS_READ', entityId: order.id } })).toBe(0);
});
it('denies outgoing addresses during a requested cancellation while preserving self reads', async () => {
  const order = await ready(); await fundsReady(order.id);
  await h.prisma.orderCancellation.create({ data: { orderId: order.id, requestedBySide: 'RECIPIENT', reason: '尚未回应的取消请求', requestedVersion: 3, requestedAt: h.clock.now() } });
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_CANCELLATION_PENDING'));
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=self`).expect(200);
  expect(await h.prisma.auditLog.count({ where: { action: 'ORDER_OUTGOING_ADDRESS_READ', entityId: order.id } })).toBe(0);
});
it('rolls back encrypted inserts, progress, freeze, deadline, revision, audit and cache on audit failure', async () => {
  const order = await courier(); const key = randomUUID();
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }).expect(200);
  const before = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const auditCount = await h.prisma.auditLog.count();
  h.faultAuditOnce(true);
  await h.command(h.actors.recipient, `/api/orders/${order.id}/address`, { ...theirs, expectedVersion: 2 }, key).expect(500);
  expect(await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(before);
  const rows = await h.prisma.orderAddress.findMany({ where: { orderId: order.id } });
  expect(rows).toHaveLength(1); expect(rows[0].frozenAt).toBeNull();
  expect((await h.prisma.orderPartyProgress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } } })).addressReady).toBe(false);
  expect(await h.prisma.auditLog.count()).toBe(auditCount); expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
});
it('withholds private response and rolls back an inserted access audit when audit delivery fails', async () => {
  const order = await ready(); await fundsReady(order.id); const count = await h.prisma.auditLog.count();
  h.faultAuditOnce(true);
  const response = await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(500);
  expect(JSON.stringify(response.body)).not.toContain(theirs.phone); expect(await h.prisma.auditLog.count()).toBe(count);
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(200);
});
it('returns one authorized snapshot if funding/state changes between private read queries', async () => {
  const order = await ready(); await fundsReady(order.id); const original = reader.readOrder;
  let injections = 0;
  vi.spyOn(reader, 'readOrder').mockImplementation(async (tx, id) => {
    // Exercise the final authorized response snapshot, after expiry cleanup.
    const [isolation] = await tx.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
    if (injections !== 0 || id !== order.id || isolation!.transaction_isolation !== 'repeatable read') return original(tx, id);
    injections++;
    await tx.order.findUniqueOrThrow({ where: { id } });
    await h.prisma.$transaction(async writer => {
      await writer.order.update({ where: { id }, data: { status: 'CANCEL_PENDING' } });
      await writer.orderPartyProgress.updateMany({ where: { orderId: id }, data: { fundsReady: false } });
    });
    return original(tx, id);
  });
  expect((await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(200)).body).toMatchObject(theirs);
  expect(injections).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCEL_PENDING');
});
it('refuses missing encryption config without writes while preserving safe authorized replay', async () => {
  const order = await courier(); const key = randomUUID();
  const first = await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }, key).expect(200);
  vi.stubEnv('ADDRESS_ENCRYPTION_KEY_BASE64', undefined);
  expect((await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }, key).expect(200)).body).toEqual(first.body);
  await h.command(h.actors.recipient, `/api/orders/${order.id}/address`, { ...theirs, expectedVersion: 2 }).expect(503).expect(({ body }) => expect(body.code).toBe('INTEGRATION_UNAVAILABLE'));
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=self`).expect(503);
  expect(await h.prisma.orderAddress.count({ where: { orderId: order.id } })).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
  await h.get(h.actors.initiator, `/api/orders/${order.id}`).expect(200);
});
it('rejects expired saves and in-person addresses without changing orders', async () => {
  const order = await courier(); const now = h.clock.now();
  try {
    h.clock.set(order.detailsDeadline);
    await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_EXPIRED'));
  } finally { h.clock.set(now); }
  const person = (await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body.order;
  await h.command(h.actors.initiator, `/api/orders/${person.id}/address`, { ...mine, expectedVersion: 1 }).expect(409);
  await h.get(h.actors.initiator, `/api/orders/${person.id}/shipping-address?side=self`).expect(409);
  expect(await h.prisma.orderAddress.count({ where: { orderId: { in: [order.id, person.id] } } })).toBe(0);
});
it('serializes concurrent identical address commands and does not replay a key across resources or revoked roles', async () => {
  const order = await courier(); const another = await courier(); const key = randomUUID();
  const responses = await Promise.all([
    h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, recipientName: ` ${mine.recipientName} `, expectedVersion: 1 }, key),
    h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }, key),
  ]);
  expect(responses.map(response => response.status)).toEqual([200, 200]); expect(responses[0].body).toEqual(responses[1].body);
  expect(await h.prisma.orderAddress.count({ where: { orderId: order.id } })).toBe(1);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_ADDRESS_SAVED' } })).toBe(1);
  const row = await h.prisma.orderAddress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } } });
  expect(await h.prisma.auditLog.count({ where: { entityId: row.id, action: 'ORDER_ADDRESS_CHANGED' } })).toBe(1);
  await h.command(h.actors.initiator, `/api/orders/${another.id}/address`, { ...mine, expectedVersion: 1 }, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  const role = await h.prisma.userRole.create({ data: { userId: h.actors.initiator.id, role: 'REVIEWER' } });
  try {
    await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }, key).expect(403);
    await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=self`).expect(403);
  } finally { await h.prisma.userRole.delete({ where: { userId_role: { userId: role.userId, role: role.role } } }); }
});
it('fails closed for corrupted encrypted database data without private response or access audit', async () => {
  const order = await ready(); await fundsReady(order.id);
  const row = await h.prisma.orderAddress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } } });
  const damaged = Buffer.from(row.tag); damaged[0] ^= 1;
  await h.prisma.orderAddress.update({ where: { id: row.id }, data: { tag: damaged } });
  const response = await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(503);
  expect(response.body.code).toBe('INTEGRATION_UNAVAILABLE');
  for (const secret of Object.values(theirs)) expect(JSON.stringify(response.body)).not.toContain(secret);
  expect(await h.prisma.auditLog.count({ where: { entityId: order.id, action: 'ORDER_OUTGOING_ADDRESS_READ' } })).toBe(0);
});
it('allows outgoing shipping reads in transit and acceptance only with the retained frozen/funding preconditions', async () => {
  const order = await ready(); await fundsReady(order.id);
  for (const status of ['IN_TRANSIT', 'AWAITING_ACCEPTANCE'] as const) {
    await h.prisma.order.update({ where: { id: order.id }, data: { status } });
    expect((await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(200)).body).toMatchObject(theirs);
  }
  await h.prisma.orderAddress.update({ where: { orderId_side: { orderId: order.id, side: 'RECIPIENT' } }, data: { frozenAt: null } });
  await h.get(h.actors.initiator, `/api/orders/${order.id}/shipping-address?side=outgoing`).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_DETAILS_REQUIRED'));
});
it('rolls back prior encrypted address revisions and all inserted metadata when the generic audit fails', async () => {
  const order = await courier();
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, expectedVersion: 1 }).expect(200);
  const original = await h.prisma.orderAddress.findUniqueOrThrow({ where: { orderId_side: { orderId: order.id, side: 'INITIATOR' } } });
  const count = await h.prisma.auditLog.count(); const audit = h.app.get(AuditService); const record = audit.record.bind(audit); const key = randomUUID();
  vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
    const inserted = await record(tx, entry);
    if (entry.action === 'ORDER_ADDRESS_SAVED') throw new Error('Injected generic audit failure');
    return inserted;
  });
  await h.command(h.actors.initiator, `/api/orders/${order.id}/address`, { ...mine, detail: '不能持久化的保密地址999室', expectedVersion: 2 }, key).expect(500);
  expect(await h.prisma.orderAddress.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  expect(await h.prisma.auditLog.count()).toBe(count); expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
});
