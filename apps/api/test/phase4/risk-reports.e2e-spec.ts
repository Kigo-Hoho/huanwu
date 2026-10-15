import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { activeItem, riskOperator } from './support/risk-harness.js';
import { LogisticsEventsService } from '../../src/logistics/logistics-events.service.js';
import { SimulatedLogisticsAdapter } from '../../src/integrations/simulated-logistics.adapter.js';

let h: AfterSalesHarness;
let directory: string | undefined;
let previousDirectory: string | undefined;
beforeAll(async () => {
  previousDirectory = process.env.LOCAL_PRIVATE_EVIDENCE_DIR;
  directory = await mkdtemp(join(tmpdir(), 'barter-risk-evidence-'));
  process.env.LOCAL_PRIVATE_EVIDENCE_DIR = directory;
  h = await createAfterSalesHarness();
});
afterAll(async () => {
  const failures: unknown[] = [];
  try { await h?.close(); } catch (error) { failures.push(error); }
  if (previousDirectory === undefined) delete process.env.LOCAL_PRIVATE_EVIDENCE_DIR;
  else process.env.LOCAL_PRIVATE_EVIDENCE_DIR = previousDirectory;
  if (directory) {
    // Only the exact absolute mkdtemp child belongs to this suite.
    const owned = resolve(directory);
    if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('barter-risk-evidence-')) failures.push(new Error('Unsafe risk evidence test cleanup target'));
    else try { await rm(owned, { recursive: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Risk report test cleanup failed');
});
afterEach(async () => { vi.restoreAllMocks(); await h?.prisma.tradingRestriction.deleteMany(); });
const report = (id: string, version = 1, key = randomUUID(), actor = h.actors.initiator, extra = {}) => h.command(actor, '/api/reports', { targetType: 'ITEM', targetId: id, expectedTargetVersion: version, reason: 'PROHIBITED_ITEM', description: '请核验该公开物品', ...extra }, key);

it('reports only visible targets, deduplicates open reasons and keeps reporter identity private', async () => {
  const item = await activeItem(h);
  const key = randomUUID();
  const first = await report(item.id, 1, key).expect(201);
  expect(first.body).toEqual({ resourceId: expect.any(String), version: 1 });
  expect((await report(item.id, 1, key).expect(201)).body).toEqual(first.body);
  expect((await report(item.id).expect(201)).body).toEqual(first.body);
  await report(item.id, 1, key, h.actors.initiator, { description: '同键不同说明' }).expect(409);
  await h.get(h.actors.recipient, `/api/reports/${first.body.resourceId}`).expect(404);
  await h.get(h.actors.mixed, `/api/reports/${first.body.resourceId}`).expect(403);
  const reviewer = await riskOperator(h);
  const detail = await reviewer.get(`/api/admin/reports/${first.body.resourceId}`).expect(200);
  expect(JSON.stringify(detail.body)).not.toContain(h.actors.initiator.id);
  expect(detail.body).toMatchObject({ status: 'OPEN', evidence: [], records: [] });
  await h.prisma.item.update({ where: { id: item.id }, data: { status: 'DRAFT' } });
  expect((await report(item.id, 1, key).expect(201)).body).toEqual(first.body);
  await report(item.id).expect(404);
  const support = await riskOperator(h, h.actors.operations);
  await support.get(`/api/admin/reports/${first.body.resourceId}`).expect(403);
});
it('serializes same-reason reports from concurrent distinct logical commands', async () => {
  const item = await activeItem(h);
  const results = await Promise.all([report(item.id), report(item.id)]);
  expect(results.map(r => r.status)).toEqual([201, 201]);
  expect(results[0].body.resourceId).toBe(results[1].body.resourceId);
  expect(await h.prisma.riskReport.count({ where: { targetId: item.id } })).toBe(1);
});
it('claims, requests evidence and concludes with immutable records, versions and current permissions', async () => {
  const item = await activeItem(h);
  const id = (await report(item.id).expect(201)).body.resourceId;
  const reviewer = await riskOperator(h);
  const key = randomUUID();
  const claim = { expectedVersion: 1, reason: '已认领核验' };
  await reviewer.post(`/api/admin/reports/${id}/claim`, claim, key).expect(200).expect(r => expect(r.body.version).toBe(2));
  await reviewer.post(`/api/admin/reports/${id}/claim`, claim, key).expect(200);
  await reviewer.post(`/api/admin/reports/${id}/request-evidence`, { expectedVersion: 1, reason: '补充证明' }).expect(409);
  await reviewer.post(`/api/admin/reports/${id}/request-evidence`, { expectedVersion: 2, reason: '补充包装证明' }).expect(200);
  await reviewer.post(`/api/admin/reports/${id}/conclude`, { expectedVersion: 3, reason: '核验后不成立', conclusion: 'DISMISSED' }).expect(200);
  expect((await h.get(h.actors.initiator, `/api/reports/${id}`).expect(200)).body).toMatchObject({ status: 'DISMISSED', version: 4 });
  expect(await h.prisma.riskRecord.count({ where: { reportId: id } })).toBe(3);
  const next = await report(item.id).expect(201);
  expect(next.body.resourceId).not.toBe(id);
  await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.reviewer.id, role: 'REVIEWER' } } });
  try { await reviewer.post(`/api/admin/reports/${id}/claim`, claim, key).expect(403); }
  finally { await h.prisma.userRole.create({ data: { userId: h.actors.reviewer.id, role: 'REVIEWER' } }); }
});
it('restricts shipment and order reports to their participants without disclosing targets', async () => {
  const order = await h.prepareOrder();
  const shipmentId = randomUUID();
  await h.prisma.shipment.create({ data: { id: shipmentId, orderId: order.id, side: 'INITIATOR', businessNo: `shipment:${shipmentId}`, carrier: 'SF', trackingNumber: randomUUID(), status: 'REGISTERED' } });
  const input = { targetType: 'SHIPMENT', targetId: shipmentId, expectedTargetVersion: order.version, reason: 'FALSE_SHIPMENT', description: '请求核验该运单' };
  await h.command(h.actors.outsider, '/api/reports', input).expect(404);
  await h.command(h.actors.recipient, '/api/reports', input).expect(201);
  await h.command(h.actors.initiator, '/api/reports', { ...input, targetType: 'ORDER', targetId: order.id, reason: 'FRAUDULENT_TRADE' }).expect(201);
  await h.command(h.actors.recipient, '/api/reports', { ...input, expectedTargetVersion: 99 }).expect(409);
});
it('rolls back report status, immutable record and cache when its audit fails', async () => {
  const item = await activeItem(h);
  const id = (await report(item.id).expect(201)).body.resourceId;
  const reviewer = await riskOperator(h);
  h.faultAuditOnce(true);
  await reviewer.post(`/api/admin/reports/${id}/claim`, { expectedVersion: 1, reason: '核验' }).expect(500);
  expect(await h.prisma.riskReport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'OPEN', version: 1 });
  expect(await h.prisma.riskRecord.count({ where: { reportId: id } })).toBe(0);
});
it('appends private report image evidence through the real route with author-only uploads and risk-only reads', async () => {
  const item = await activeItem(h);
  const id = (await report(item.id).expect(201)).body.resourceId;
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer();
  const upload = (actor = h.actors.initiator) => request(h.app.getHttpServer()).post(`/api/reports/${id}/evidence`).set('Authorization', `Bearer ${h.token(actor)}`).set('Idempotency-Key', randomUUID()).field('expectedVersion', '1').field('description', '实际图片证据').attach('files', image, { filename: 'evidence.png', contentType: 'image/png' });
  await upload(h.actors.recipient).expect(404);
  const freeze = await riskOperator(h);
  expect((await freeze.action(`/api/admin/risk/users/${h.actors.initiator.id}/freeze`, 'FREEZE_TRADING', h.actors.initiator.id, { expectedVersion: 1, reason: '冻结仍可举证' })).status).toBe(200);
  await upload().expect(200).expect(r => expect(r.body).toEqual({ resourceId: id, version: 2 }));
  const detail = (await h.get(h.actors.initiator, `/api/reports/${id}`).expect(200)).body;
  expect(detail.evidence).toHaveLength(1);
  const evidenceId = detail.evidence[0].id;
  await h.get(h.actors.recipient, `/api/evidence/${evidenceId}/content?variant=preview`).expect(404);
  const reviewer = await riskOperator(h);
  await reviewer.get(`/api/evidence/${evidenceId}/content?variant=original`).expect(200).expect('Cache-Control', 'no-store');
  const support = await riskOperator(h, h.actors.operations);
  await support.get(`/api/evidence/${evidenceId}/content?variant=preview`).expect(403);
  expect(JSON.stringify((await reviewer.get(`/api/admin/reports/${id}`).expect(200)).body)).not.toMatch(/uploaderId|reporterId|storageKey|originalKey/);
});
async function exception(orderStatus: 'AWAITING_FULFILLMENT' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED') {
  const order = await h.prepareOrder();
  await h.prisma.order.update({ where: { id: order.id }, data: { status: orderStatus, detailsDeadline: null, ...(orderStatus === 'ON_HOLD' ? { holdReason: '原有人工暂停', holdPreviousStatus: 'AWAITING_FULFILLMENT', heldAt: h.clock.now() } : {}) } });
  const id = randomUUID();
  const shipment = await h.prisma.shipment.create({ data: { id, orderId: order.id, side: 'INITIATOR', businessNo: `shipment:${id}`, carrier: 'SF', trackingNumber: randomUUID() } });
  const apply = async (progress: 'EXCEPTION' | 'DELIVERED', eventId = randomUUID()) => {
    const raw = JSON.stringify({ provider: 'simulated', eventId, kind: 'SHIPMENT_PROGRESS', businessNo: shipment.businessNo, shipmentId: id, progress, occurredAt: h.clock.now().toISOString() });
    const signature = createHmac('sha256', Buffer.from(process.env.SIMULATED_INTEGRATION_SIGNING_KEY_BASE64!, 'base64')).update(raw).digest('hex');
    await h.app.get(LogisticsEventsService).applyVerified(h.app.get(SimulatedLogisticsAdapter).verifySignedEvent(raw, signature));
  };
  return { order, shipment, apply };
}
it.each(['AWAITING_FULFILLMENT', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const)('records one risk task alongside trusted EXCEPTION for %s, retaining terminal facts and original hold', async status => {
  const f = await exception(status);
  const eventId = randomUUID();
  await f.apply('EXCEPTION', eventId); await f.apply('EXCEPTION', eventId); await f.apply('EXCEPTION');
  expect(await h.prisma.riskTask.count({ where: { sourceKey: `shipment:${f.shipment.id}:exception`, orderId: f.order.id, kind: 'SHIPMENT_EXCEPTION' } })).toBe(1);
  const order = await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
  expect(order.status).toBe(['COMPLETED', 'CANCELLED'].includes(status) ? status : 'ON_HOLD');
  if (status === 'ON_HOLD') expect(order.holdReason).toBe('原有人工暂停');
  expect(await h.prisma.orderHoldBlocker.count({ where: { orderId: f.order.id } })).toBe(['COMPLETED', 'CANCELLED'].includes(status) ? 0 : status === 'ON_HOLD' ? 2 : 1);
  await f.apply('DELIVERED');
  expect(await h.prisma.shipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).toMatchObject({ status: 'EXCEPTION', deliveredAt: h.clock.now() });
});
it('rolls back trusted exception fact, task, blocker and hold on audit failure, then safely retries', async () => {
  const f = await exception('AWAITING_FULFILLMENT');
  h.faultAuditOnce(true);
  await expect(f.apply('EXCEPTION')).rejects.toThrow('Injected audit failure');
  expect(await h.prisma.riskTask.count({ where: { orderId: f.order.id } })).toBe(0);
  expect(await h.prisma.shipmentEvent.count({ where: { shipmentId: f.shipment.id } })).toBe(0);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('AWAITING_FULFILLMENT');
  await f.apply('EXCEPTION');
  expect(await h.prisma.riskTask.count({ where: { orderId: f.order.id } })).toBe(1);
});
it('paginates reports and risk tasks stably at equal timestamps while keeping customer lists scoped', async () => {
  const createdAt = new Date('2035-01-01T00:00:00.000Z');
  await h.prisma.riskReport.createMany({ data: Array.from({ length: 55 }, () => ({ reporterId: h.actors.initiator.id, targetType: 'ITEM' as const, targetId: randomUUID(), reason: 'OTHER' as const, description: '分页测试举报', createdAt })) });
  await h.prisma.riskTask.createMany({ data: Array.from({ length: 55 }, () => ({ sourceKey: randomUUID(), kind: 'OWNED_PAGINATION', description: '分页测试待办', createdAt })) });
  const reviewer = await riskOperator(h);
  for (const [path, expected] of [
    ['/api/admin/reports', (await h.prisma.riskReport.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })).map(v => v.id)],
    ['/api/admin/risk-tasks', (await h.prisma.riskTask.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })).map(v => v.id)],
  ] as const) {
    expect((await reviewer.get(path).expect(200)).body.items).toHaveLength(20);
    expect((await reviewer.get(`${path}?limit=50`).expect(200)).body.items).toHaveLength(50);
    await reviewer.get(`${path}?limit=51`).expect(400);
    await reviewer.get(`${path}?cursor=invalid`).expect(400);
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const page: { items: { id: string }[]; nextCursor: string | null } = (await reviewer.get(`${path}?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200)).body;
      ids.push(...page.items.map((value: { id: string }) => value.id)); cursor = page.nextCursor;
      expect(JSON.stringify(page)).not.toMatch(/reporterId|uploaderId|sourceKey|wechatOpenid|credential/);
    } while (cursor);
    expect(ids).toEqual(expected);
  }
  const mine = await h.get(h.actors.outsider, '/api/reports').expect(200);
  expect(mine.body.items).toEqual([]);
  const support = await riskOperator(h, h.actors.operations);
  await support.get('/api/admin/risk-tasks').expect(403);
});
it('requires actual evidence before concluding a shipment is false', async () => {
  const order = await h.prepareOrder(); const shipmentId = randomUUID();
  await h.prisma.shipment.create({ data: { id: shipmentId, orderId: order.id, side: 'INITIATOR', businessNo: `shipment:${shipmentId}`, carrier: 'SF', trackingNumber: randomUUID() } });
  const id = (await h.command(h.actors.recipient, '/api/reports', { targetType: 'SHIPMENT', targetId: shipmentId, expectedTargetVersion: 1, reason: 'FALSE_SHIPMENT', description: '疑似虚假运单，请核验' }).expect(201)).body.resourceId;
  const reviewer = await riskOperator(h);
  await reviewer.post(`/api/admin/reports/${id}/claim`, { expectedVersion: 1, reason: '核验承运证明' }).expect(200);
  await reviewer.post(`/api/admin/reports/${id}/conclude`, { expectedVersion: 2, reason: '缺少支持证据', conclusion: 'ACTIONED' }).expect(409);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } }).png().toBuffer();
  await request(h.app.getHttpServer()).post(`/api/reports/${id}/evidence`).set('Authorization', `Bearer ${h.token(h.actors.recipient)}`).set('Idempotency-Key', randomUUID()).field('expectedVersion', '2').field('description', '核验凭证图片').attach('files', image, { filename: 'proof.png', contentType: 'image/png' }).expect(200);
  await reviewer.post(`/api/admin/reports/${id}/conclude`, { expectedVersion: 3, reason: '结合凭证核验成立', conclusion: 'ACTIONED' }).expect(200);
  expect((await h.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe('REGISTERED');
});
it('associates only relevant report actions and never clears an independent freeze by concluding the report', async () => {
  const item = await activeItem(h);
  const id = (await report(item.id).expect(201)).body.resourceId;
  const reviewer = await riskOperator(h);
  expect((await reviewer.action(`/api/admin/risk/users/${h.actors.outsider.id}/freeze`, 'FREEZE_TRADING', h.actors.outsider.id, { expectedVersion: 1, reason: '不相关目标', reportId: id })).status).toBe(409);
  expect((await reviewer.action(`/api/admin/risk/users/${h.actors.recipient.id}/freeze`, 'FREEZE_TRADING', h.actors.recipient.id, { expectedVersion: 1, reason: '关联举报核验', reportId: id })).status).toBe(200);
  await reviewer.post(`/api/admin/reports/${id}/claim`, { expectedVersion: 1, reason: '核验' }).expect(200);
  await reviewer.post(`/api/admin/reports/${id}/conclude`, { expectedVersion: 2, reason: '已采取独立交易限制', conclusion: 'ACTIONED' }).expect(200);
  expect(await h.prisma.tradingRestriction.findUniqueOrThrow({ where: { userId: h.actors.recipient.id } })).toMatchObject({ status: 'FROZEN', version: 2 });
  await h.get(h.actors.initiator, `/api/items/${item.id}`).expect(404);
});
