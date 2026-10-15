import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { canonicalHash } from '../../../src/operator-security/operator-action.types.js';
import type { AfterSalesHarness } from './after-sales-harness.js';

export async function riskOperator(h: AfterSalesHarness, actor = h.actors.reviewer) {
  const session = await h.operatorLogin(actor);
  expect(session.response.status).toBe(201);
  return {
    session,
    get: (path: string) => request(h.app.getHttpServer()).get(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie),
    post: (path: string, input: object, key = randomUUID()) => request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send(input),
    async action(path: string, action: string, id: string, input: { expectedVersion: number; reason: string; reportId?: string; blockerId?: string }, key = randomUUID()) {
      const grant = await h.grant(session, { action, resourceId: id, expectedVersions: { expectedVersion: input.expectedVersion }, requestHash: canonicalHash(input) }).expect(200);
      return request(h.app.getHttpServer()).post(path).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', key).send({ ...input, operatorAction: { sessionId: session.response.body.operatorSession.id, grantId: grant.body.id } });
    },
  };
}
export async function trustedRiskOperator(h: AfterSalesHarness) {
  const bootstrap = await h.operatorLogin(h.actors.superAdminOne);
  const device = await h.enrollOwnedDevice(bootstrap).expect(201);
  const cli = spawnSync(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', device.body.id, 'Task7 owned desktop bootstrap'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  expect(cli.status).toBe(0);
  const admin = await h.operatorLogin(h.actors.superAdminOne, bootstrap.cookie);
  const mobile = await h.operatorLogin(h.actors.reviewer);
  const reviewerDevice = await h.enrollOwnedDevice(mobile).expect(201);
  const business = { expectedVersion: reviewerDevice.body.version, reason: 'Task7 owned reviewer desktop' };
  const grant = await h.grant(admin, { action: 'APPROVE_DEVICE', resourceId: reviewerDevice.body.id, expectedVersions: { expectedVersion: business.expectedVersion }, requestHash: canonicalHash(business) }).expect(200);
  await request(h.app.getHttpServer()).post(`/api/admin/security/devices/${reviewerDevice.body.id}/approve`).set('Authorization', `Bearer ${admin.token}`).set('Cookie', admin.cookie).set('Origin', 'http://localhost:5173').set('Idempotency-Key', randomUUID()).send({ ...business, operatorAction: { sessionId: admin.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200);
  const session = await h.operatorLogin(h.actors.reviewer, mobile.cookie);
  const bound = { ...h, operatorLogin: async () => session } as AfterSalesHarness;
  return riskOperator(bound);
}
export async function activeItem(h: AfterSalesHarness, ownerId = h.actors.recipient.id) {
  return h.prisma.item.create({ data: { ownerId, status: 'ACTIVE', title: '待核验物品标题', description: '实拍完整物品描述', condition: 'GOOD', referenceValueFen: 2000, wantedText: '换物', images: { create: [0, 1, 2].map(sortOrder => ({ sortOrder, url: `https://example.test/${sortOrder}.jpg` })) } } });
}
export async function pendingProposal(h: AfterSalesHarness) {
  const offered = await activeItem(h, h.actors.initiator.id);
  const target = await activeItem(h);
  return (await h.command(h.actors.initiator, '/api/proposals', { offeredItemIds: [offered.id], targetItemId: target.id, differenceFen: 0, payer: 'NONE', deliveryMode: 'IN_PERSON', initiatorShippingFen: 0, recipientShippingFen: 0 }).expect(201)).body as { id: string; version: number };
}
