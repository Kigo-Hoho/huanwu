import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { EvidenceService } from '../../src/evidence/evidence.service.js';
import { EVIDENCE_STORAGE_PORT, type EvidenceStoragePort } from '../../src/evidence/evidence-storage.port.js';
import { EvidenceModule } from '../../src/evidence/evidence.module.js';
import { configureApp } from '../../src/main.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OrderExpiryScheduler } from '../../src/orders/order-expiry.scheduler.js';
import { ProposalExpiryScheduler } from '../../src/proposals/proposal-expiry.scheduler.js';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';

let h: AfterSalesHarness;
let directory: string;
let previousDirectory: string | undefined;
let photo: Buffer;
let secondPhoto: Buffer;
beforeAll(async () => {
  previousDirectory = process.env.LOCAL_PRIVATE_EVIDENCE_DIR;
  directory = await mkdtemp(join(tmpdir(), 'barter-private-evidence-test-'));
  process.env.LOCAL_PRIVATE_EVIDENCE_DIR = directory;
  h = await createAfterSalesHarness();
  photo = await sharp({ create: { width: 12, height: 9, channels: 3, background: 'red' } }).jpeg().withExif({ IFD0: { Copyright: 'private-location-fixture' } }).toBuffer();
  secondPhoto = await sharp({ create: { width: 7, height: 6, channels: 3, background: 'blue' } }).png().toBuffer();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try { await h?.close(); }
  finally {
    if (previousDirectory === undefined) delete process.env.LOCAL_PRIVATE_EVIDENCE_DIR; else process.env.LOCAL_PRIVATE_EVIDENCE_DIR = previousDirectory;
    if (directory?.startsWith(join(tmpdir(), 'barter-private-evidence-test-'))) await rm(directory, { recursive: true });
  }
});
const versions = (result: { case: { version: number }; orderVersion: number }) => ({ expectedCaseVersion: result.case.version, expectedOrderVersion: result.orderVersion });
async function opened() {
  const order = await h.prepareOrder();
  return (await h.command(h.actors.initiator, `/api/orders/${order.id}/after-sales`, { expectedOrderVersion: order.version, reason: '包装存在争议' }).expect(201)).body;
}
function upload(value: { case: { id: string; version: number }; orderVersion: number }, files: Buffer[] = [photo], actor = h.actors.initiator, key = randomUUID(), fields: Record<string, string> = {}) {
  const call = request(h.app.getHttpServer()).post(`/api/after-sales/${value.case.id}/evidence`).set('Authorization', `Bearer ${h.token(actor)}`).set('Idempotency-Key', key);
  for (const [name, item] of Object.entries({ ...versions(value), description: '包装照片', ...fields })) call.field(name, String(item));
  files.forEach(bytes => call.attach('files', bytes, { filename: 'photo.jpg', contentType: bytes === secondPhoto ? 'image/png' : 'image/jpeg' }));
  return call;
}
async function rows(caseId: string) { return h.prisma.caseEvidence.findMany({ where: { caseId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }); }
const content = (id: string, variant: string, actor = h.actors.initiator) => h.get(actor, `/api/evidence/${id}/content?variant=${variant}`);

it('atomically appends nine immutable images once and binds idempotency to file bytes and order', async () => {
  const value = await opened();
  const key = randomUUID();
  const files = [photo, secondPhoto, ...Array<Buffer>(7).fill(photo)];
  const appended = (await upload(value, files, h.actors.initiator, key).expect(200)).body;
  expect(appended.case.version).toBe(2);
  expect(appended.orderVersion).toBe(value.orderVersion + 1);
  expect((await upload(value, files, h.actors.initiator, key).expect(200)).body).toEqual(appended);
  await upload(value, [secondPhoto, photo, ...Array<Buffer>(7).fill(photo)], h.actors.initiator, key).expect(409).expect(r => expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'));
  expect(await rows(value.case.id)).toHaveLength(9);
  expect(await h.prisma.auditLog.count({ where: { entityId: value.case.id, action: 'CASE_EVIDENCE_APPENDED' } })).toBe(1);
  const detail = await h.get(h.actors.recipient, `/api/after-sales/${value.case.id}`).expect(200);
  expect(detail.body.evidence).toHaveLength(9);
  expect(detail.body.records.filter((r: { kind: string }) => r.kind === 'EVIDENCE_APPENDED')).toHaveLength(1);
  const cache = await h.prisma.idempotencyRecord.findFirstOrThrow({ where: { actorId: h.actors.initiator.id, commandName: 'CASE_EVIDENCE_APPENDED', key } });
  const serialized = JSON.stringify([detail.body, cache.response, await h.prisma.auditLog.findMany({ where: { entityId: value.case.id } })]);
  for (const row of await rows(value.case.id)) { expect(serialized).not.toContain(row.originalKey); expect(serialized).not.toContain(row.displayKey); }
  expect(serialized).not.toContain(photo.toString('base64'));
  await expect(h.prisma.caseEvidence.update({ where: { id: (await rows(value.case.id))[0].id }, data: { description: '替换证据' } })).rejects.toThrow();
});
it('rejects zero/ten images, malformed body, stale versions and a cumulative thirty-first image', async () => {
  let value = await opened();
  await upload(value, []).expect(400);
  await upload(value, Array<Buffer>(10).fill(photo)).expect(400);
  const invalidFields: Record<string, string>[] = [{ description: '' }, { description: 'a'.repeat(2001) }, { imageIds: randomUUID() }, { expectedCaseVersion: '1.5' }, { expectedOrderVersion: '1junk' }, { url: 'https://example.test/a.jpg' }];
  for (const fields of invalidFields) await upload(value, [photo], h.actors.initiator, randomUUID(), fields).expect(400);
  await upload(value, [photo], h.actors.initiator, randomUUID(), { expectedOrderVersion: '999' }).expect(409).expect(r => expect(r.body.code).toBe('ORDER_VERSION_CONFLICT'));
  for (const count of [9, 9, 9, 3]) value = (await upload(value, Array<Buffer>(count).fill(photo)).expect(200)).body;
  await upload(value).expect(409).expect(r => expect(r.body.code).toBe('EVIDENCE_LIMIT_EXCEEDED'));
  expect(await rows(value.case.id)).toHaveLength(30);
  await upload(value, [photo], h.actors.recipient).expect(200);
});
it('serializes racing uploads so each participant cannot exceed thirty images', async () => {
  let value = await opened();
  for (const count of [9, 9, 3]) value = (await upload(value, Array<Buffer>(count).fill(photo)).expect(200)).body;
  const results = await Promise.all([upload(value, Array<Buffer>(9).fill(photo)), upload(value, Array<Buffer>(9).fill(photo))]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await rows(value.case.id)).toHaveLength(30);
});
it('strips preview metadata, preserves original digest, audits original access and has no public route', async () => {
  const value = await opened();
  await upload(value).expect(200);
  const row = (await rows(value.case.id))[0];
  expect(row.sha256).toBe(createHash('sha256').update(photo).digest('hex'));
  const preview = await content(row.id, 'preview', h.actors.recipient).expect(200);
  expect(preview.headers['cache-control']).toBe('no-store');
  expect(preview.headers['x-content-type-options']).toBe('nosniff');
  expect((await sharp(preview.body).metadata()).exif).toBeUndefined();
  const original = await content(row.id, 'original').expect(200);
  expect(original.body).toEqual(photo);
  expect(original.headers['cache-control']).toBe('no-store');
  expect(await h.prisma.auditLog.count({ where: { action: 'EVIDENCE_ORIGINAL_ACCESSED', entityId: row.id } })).toBe(1);
  await request(h.app.getHttpServer()).get(`/api/evidence/${row.id}/content?variant=preview`).expect(401);
  await request(h.app.getHttpServer()).get(`/api/uploads/item-images/files/${row.originalKey}`).expect(404);
  await request(h.app.getHttpServer()).get(`/api/uploads/item-images/files/${row.displayKey}`).expect(404);
  await content(row.id, 'thumbnail').expect(400);
});
it('authorizes every read using current participant identity or a bound after-sales operator session', async () => {
  const value = await opened();
  await upload(value).expect(200);
  const id = (await rows(value.case.id))[0].id;
  await upload(value, [photo], h.actors.outsider).expect(404);
  await upload(value, [photo], h.actors.mixed).expect(403);
  await content(id, 'preview', h.actors.outsider).expect(404);
  await content(id, 'preview', h.actors.mixed).expect(403);
  await content(id, 'preview', h.actors.operations).expect(401);
  const reviewer = await h.operatorLogin(h.actors.reviewer);
  await request(h.app.getHttpServer()).get(`/api/evidence/${id}/content?variant=preview`).set('Authorization', `Bearer ${reviewer.token}`).set('Cookie', reviewer.cookie).expect(403);
  const ops = await h.operatorLogin(h.actors.operations);
  const read = () => request(h.app.getHttpServer()).get(`/api/evidence/${id}/content?variant=preview`).set('Authorization', `Bearer ${ops.token}`).set('Cookie', ops.cookie);
  await read().expect(200);
  const adminDetail = await request(h.app.getHttpServer()).get(`/api/admin/after-sales/${value.case.id}`).set('Authorization', `Bearer ${ops.token}`).set('Cookie', ops.cookie).expect(200);
  expect(adminDetail.body.evidence[0]).not.toHaveProperty('uploaderId');
  await request(h.app.getHttpServer()).get(`/api/evidence/${id}/content?variant=preview`).set('Authorization', `Bearer ${ops.token}`).expect(401);
  await h.prisma.operatorSession.update({ where: { id: ops.response.body.operatorSession.id }, data: { revokedAt: h.clock.now() } });
  await read().expect(401);
});
it('rechecks current customer permission before successful upload replay', async () => {
  const value = await opened(); const key = randomUUID();
  await upload(value, [photo], h.actors.initiator, key).expect(200);
  await h.prisma.userRole.create({ data: { userId: h.actors.initiator.id, role: 'OPERATIONS' } });
  try { await upload(value, [photo], h.actors.initiator, key).expect(403); }
  finally { await h.prisma.userRole.delete({ where: { userId_role: { userId: h.actors.initiator.id, role: 'OPERATIONS' } } }); }
});
it('rolls back metadata, counts, versions and owned objects when append audit fails', async () => {
  const value = await opened(); const key = randomUUID();
  const before = await readdir(directory);
  h.faultAuditOnce(true);
  await upload(value, [photo, secondPhoto], h.actors.initiator, key).expect(500);
  expect(await rows(value.case.id)).toHaveLength(0);
  expect((await h.prisma.afterSalesCase.findUniqueOrThrow({ where: { id: value.case.id } })).version).toBe(1);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: value.case.orderId } })).version).toBe(value.orderVersion);
  expect(await h.prisma.idempotencyRecord.count({ where: { actorId: h.actors.initiator.id, commandName: 'CASE_EVIDENCE_APPENDED', key } })).toBe(0);
  expect((await readdir(directory)).sort()).toEqual(before.sort());
  await upload(value, [photo, secondPhoto], h.actors.initiator, key).expect(200);
});
it('returns no bytes when original-access audit fails', async () => {
  const value = await opened(); await upload(value).expect(200);
  const id = (await rows(value.case.id))[0].id;
  h.faultAuditOnce(true);
  const response = await content(id, 'original').expect(500);
  expect(response.headers['content-type']).toContain('application/json');
  expect(JSON.stringify(response.body)).not.toContain(photo.toString('base64'));
  expect(await h.prisma.auditLog.count({ where: { action: 'EVIDENCE_ORIGINAL_ACCESSED', entityId: id } })).toBe(0);
});
it('treats valid requested evidence as the participant response within the same command', async () => {
  const value = await opened(); const ops = await h.operatorLogin(h.actors.operations);
  const asked = (await request(h.app.getHttpServer()).post(`/api/admin/after-sales/${value.case.id}/request-evidence`).set('Authorization', `Bearer ${ops.token}`).set('Cookie', ops.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', randomUUID()).send({ ...versions(value), side: 'RECIPIENT', reason: '请补充验收照片' }).expect(200)).body;
  const other = (await upload(asked).expect(200)).body;
  expect(other.case.status).toBe('AWAITING_RESPONSE');
  const result = (await upload(other, [photo], h.actors.recipient).expect(200)).body;
  expect(result.case.status).toBe('UNDER_REVIEW');
  expect(result.case.responseDeadline).toBeNull();
});
it('rejects forged MIME, truncated images and oversized files before any metadata is recorded', async () => {
  const value = await opened();
  await upload(value, [secondPhoto], h.actors.initiator, randomUUID()).expect(200);
  const current = { ...value, case: { ...value.case, version: 2 }, orderVersion: value.orderVersion + 1 };
  for (const bytes of [Buffer.from([0xff, 0xd8, 0xff]), photo.subarray(0, Math.floor(photo.length / 2)), Buffer.alloc(8388609)]) await upload(current, [bytes]).expect(400);
  await upload(current, [photo], h.actors.initiator, randomUUID(), { expectedCaseVersion: '1' }).expect(409);
  const call = request(h.app.getHttpServer()).post(`/api/after-sales/${value.case.id}/evidence`).set('Authorization', `Bearer ${h.token(h.actors.initiator)}`).set('Idempotency-Key', randomUUID());
  Object.entries({ ...versions(current), description: '伪造类型' }).forEach(([name, item]) => call.field(name, String(item)));
  await call.attach('files', photo, { filename: '../../bad.png', contentType: 'image/png' }).expect(400);
  expect(await rows(value.case.id)).toHaveLength(1);
});

it('keeps report evidence private to its author and bound risk operators without publishing report routes', async () => {
  const report = await h.prisma.riskReport.create({ data: { reporterId: h.actors.initiator.id, targetType: 'ITEM', targetId: randomUUID(), reason: 'OTHER', description: '举报附件隔离夹具' } });
  const service = h.app.get(EvidenceService);
  const key = randomUUID();
  const input = { expectedVersion: 1, description: '举报图片' };
  const files = [{ bytes: photo, contentType: 'image/jpeg' }];
  const result = await service.appendReport(h.actors.initiator, report.id, input, files, key);
  expect(result).toEqual({ resourceId: report.id, version: 2 });
  expect(await service.appendReport(h.actors.initiator, report.id, input, files, key)).toEqual(result);
  await expect(service.appendReport(h.actors.initiator, report.id, input, [{ bytes: secondPhoto, contentType: 'image/png' }], key)).rejects.toMatchObject({ status: 409 });
  await expect(service.appendReport(h.actors.recipient, report.id, { ...input, expectedVersion: 2 }, files, randomUUID())).rejects.toMatchObject({ status: 404 });
  const evidence = await h.prisma.caseEvidence.findFirstOrThrow({ where: { reportId: report.id } });
  await content(evidence.id, 'preview').expect(200);
  await content(evidence.id, 'preview', h.actors.recipient).expect(404);
  for (const [actor, status] of [[h.actors.operations, 403], [h.actors.reviewer, 200], [h.actors.superAdminOne, 200]] as const) {
    const session = await h.operatorLogin(actor);
    await request(h.app.getHttpServer()).get(`/api/evidence/${evidence.id}/content?variant=original`).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).expect(status);
  }
  const serialized = JSON.stringify([result, await h.prisma.idempotencyRecord.findFirstOrThrow({ where: { key } }), await h.prisma.riskRecord.findMany({ where: { reportId: report.id } }), await h.prisma.auditLog.findMany({ where: { entityId: report.id } })]);
  expect(serialized).not.toContain(evidence.originalKey);
  expect(serialized).not.toContain(evidence.displayKey);
  expect(await h.prisma.caseEvidence.count({ where: { reportId: report.id } })).toBe(1);
  await h.get(h.actors.initiator, `/api/reports/${report.id}`).expect(404);
});

it('rolls back report append audit failures and enforces report quota under racing versions', async () => {
  const report = await h.prisma.riskReport.create({ data: { reporterId: h.actors.initiator.id, targetType: 'ITEM', targetId: randomUUID(), reason: 'OTHER', description: '举报数量夹具' } });
  const service = h.app.get(EvidenceService);
  const append = (version: number, count: number, key = randomUUID()) => service.appendReport(h.actors.initiator, report.id, { expectedVersion: version, description: '举报照片' }, Array.from({ length: count }, () => ({ bytes: photo, contentType: 'image/jpeg' })), key);
  const before = (await readdir(directory)).sort();
  const key = randomUUID();
  h.faultAuditOnce(true);
  await expect(append(1, 1, key)).rejects.toThrow('Injected audit failure');
  expect((await readdir(directory)).sort()).toEqual(before);
  expect(await h.prisma.caseEvidence.count({ where: { reportId: report.id } })).toBe(0);
  expect(await h.prisma.riskRecord.count({ where: { reportId: report.id } })).toBe(0);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect((await h.prisma.riskReport.findUniqueOrThrow({ where: { id: report.id } })).version).toBe(1);
  for (const [version, count] of [[1, 9], [2, 9], [3, 3]]) await append(version, count);
  const race = await Promise.allSettled([append(4, 9), append(4, 9)]);
  expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(race.filter(result => result.status === 'rejected')).toHaveLength(1);
  await expect(append(5, 1)).rejects.toMatchObject({ status: 409, response: { code: 'EVIDENCE_LIMIT_EXCEEDED' } });
  expect(await h.prisma.caseEvidence.count({ where: { reportId: report.id } })).toBe(30);
});

it('cleans only unreferenced owned objects after a partial storage failure and replay', async () => {
  const value = await opened(); const key = randomUUID();
  await upload(value, [photo], h.actors.initiator, key).expect(200);
  const before = (await readdir(directory)).sort();
  await upload(value, [photo], h.actors.initiator, key).expect(200);
  expect((await readdir(directory)).sort()).toEqual(before);
  const storage = h.app.get<EvidenceStoragePort>(EVIDENCE_STORAGE_PORT);
  const originalSave = storage.save.bind(storage);
  vi.spyOn(storage, 'save').mockImplementationOnce(originalSave).mockRejectedValueOnce(new Error('Storage unavailable after original'));
  await upload({ ...value, case: { ...value.case, version: 2 }, orderVersion: value.orderVersion + 1 }).expect(500);
  expect((await readdir(directory)).sort()).toEqual(before);
  expect(await rows(value.case.id)).toHaveLength(1);
  const row = (await rows(value.case.id))[0];
  await h.app.get(EvidenceService).cleanupOwned([{ key: row.originalKey, owner: row.originalKey.slice(0, 36) }]);
  await content(row.id, 'original').expect(200);
});

it('rejects cleanup descriptors spanning different upload owners', async () => {
  const storage = h.app.get<EvidenceStoragePort>(EVIDENCE_STORAGE_PORT);
  const objects = [await storage.save(randomUUID(), photo), await storage.save(randomUUID(), photo)];
  try {
    await expect(h.app.get(EvidenceService).cleanupOwned(objects)).rejects.toMatchObject({ status: 400 });
    for (const object of objects) expect(await storage.read(object.key)).toEqual(photo);
  } finally { for (const object of objects) await storage.deleteOwned(object); }
});

it('selects unavailable storage in production and returns 503 without writing a local file', async () => {
  const value = await opened();
  await upload(value).expect(200);
  const row = (await rows(value.case.id))[0];
  const before = (await readdir(directory)).sort();
  const names = ['NODE_ENV', 'PAYMENT_PROVIDER', 'LOGISTICS_PROVIDER', 'WECHAT_IDENTITY_PROVIDER'] as const;
  const previous = names.map(name => [name, process.env[name]] as const);
  process.env.NODE_ENV = 'production';
  process.env.PAYMENT_PROVIDER = 'disabled'; process.env.LOGISTICS_PROVIDER = 'disabled'; process.env.WECHAT_IDENTITY_PROVIDER = 'wechat';
  let module: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>> | undefined;
  let app: ReturnType<NonNullable<typeof module>['createNestApplication']> | undefined;
  try {
    module = await Test.createTestingModule({ imports: [EvidenceModule] })
      .overrideProvider(OutboxWorker).useValue({})
      .overrideProvider(OrderExpiryScheduler).useValue({})
      .overrideProvider(ProposalExpiryScheduler).useValue({}).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
    await request(app.getHttpServer()).get(`/api/evidence/${row.id}/content?variant=preview`).set('Authorization', `Bearer ${h.token(h.actors.initiator)}`).expect(503);
    await request(app.getHttpServer()).post(`/api/after-sales/${value.case.id}/evidence`).set('Authorization', `Bearer ${h.token(h.actors.initiator)}`).set('Idempotency-Key', randomUUID())
      .field('description', '生产配置缺失').field('expectedCaseVersion', '2').field('expectedOrderVersion', String(value.orderVersion + 1)).attach('files', photo, { filename: 'evidence.jpg', contentType: 'image/jpeg' }).expect(503);
    expect((await readdir(directory)).sort()).toEqual(before);
    expect(await rows(value.case.id)).toHaveLength(1);
  } finally {
    try { if (app) await app.close(); else await module?.close(); }
    finally { for (const [name, old] of previous) { if (old === undefined) delete process.env[name]; else process.env[name] = old; } }
  }
});
