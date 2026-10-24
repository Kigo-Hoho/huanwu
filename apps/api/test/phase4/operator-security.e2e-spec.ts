import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import { OperatorDeviceListResultSchema, OperatorSessionListResultSchema } from '@barter/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { ActionGrantService } from '../../src/operator-security/action-grant.service.js';
import { OperatorSessionService } from '../../src/operator-security/operator-session.service.js';
import { operatorRequestHash, type ActionBinding, type OperatorActionContext } from '../../src/operator-security/operator-action.types.js';

describe('owned operator security pagination', () => {
  let h: AfterSalesHarness;
  let own: Awaited<ReturnType<AfterSalesHarness['operatorLogin']>>;
  let other: typeof own;
  const devices = Array.from({ length: 56 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const sessions = Array.from({ length: 56 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1001).padStart(12, '0')}`);
  beforeAll(async () => {
    h = await createAfterSalesHarness();
    own = await h.operatorLogin();
    other = await h.operatorLogin(h.actors.superAdminTwo);
    const createdAt = new Date('2026-10-08T12:00:00.000Z');
    await h.prisma.operatorDevice.createMany({ data: devices.map((id, i) => ({ id, actorId: h.actors.superAdminOne.id, credentialDigest: String(i + 1).padStart(64, '0'), createdAt })) });
    await h.prisma.operatorSession.createMany({ data: sessions.map((id, i) => ({ id, actorId: h.actors.superAdminOne.id, deviceId: devices[i], capability: 'MOBILE_LIMITED', createdAt, expiresAt: new Date('2026-10-08T12:15:00.000Z') })) });
  });
  afterAll(async () => { await h?.close(); });
  const read = (path: string, query: object = {}, session = own) => request(h.app.getHttpServer()).get(`/api/admin/security/${path}`).set('Authorization', `Bearer ${session.token}`).set('Cookie', session.cookie).query(query);
  it.each(['devices', 'sessions'])('paginates every owned %s record with stable time/id ordering and no foreign records', async path => {
    const expected = path === 'devices' ? [own.response.body.operatorSession.deviceId, ...devices.slice().reverse()] : [own.response.body.operatorSession.id, ...sessions.slice().reverse()];
    const foreign = path === 'devices' ? other.response.body.operatorSession.deviceId : other.response.body.operatorSession.id;
    const first = await read(path).expect(200);
    expect(first.body.items).toHaveLength(20);
    expect((await read(path, { limit: 50 }).expect(200)).body.items).toHaveLength(50);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response: request.Response = await read(path, { limit: 17, ...(cursor ? { cursor } : {}) }).expect(200);
      const page = (path === 'devices' ? OperatorDeviceListResultSchema : OperatorSessionListResultSchema).parse(response.body);
      expect(page.items.length).toBeLessThanOrEqual(17);
      for (const item of page.items) {
        expect(item.id).not.toBe(foreign);
        expect(item).not.toHaveProperty('actorId');
        expect(item).not.toHaveProperty('credentialDigest');
      }
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(57);
    const foreignCursor = (await read(path, { limit: 1 }).expect(200)).body.nextCursor;
    const otherPage = await read(path, { cursor: foreignCursor, limit: 50 }, other).expect(200);
    expect(otherPage.body.items.every((item: { id: string }) => !expected.includes(item.id))).toBe(true);
  });
  it.each(['devices', 'sessions'])('rejects invalid %s pagination queries', async path => {
    for (const query of [{ limit: 0 }, { limit: 51 }, { limit: '1.5' }, { limit: '' }, { limit: ['1', '2'] }, { cursor: 'invalid' }, { cursor: '2026-10-08T12:00:00.000Z~invalid' }, { cursor: `2026-99-99T00:00:00.000Z~${devices[0]}` }, { cursor: '' }, { actorId: h.actors.superAdminTwo.id }]) {
      expect((await read(path, query)).status).toBe(400);
    }
  });
});

describe('operator security HTTP boundary', () => {
  let h: AfterSalesHarness;
  beforeAll(async () => { h = await createAfterSalesHarness(); });
  afterAll(async () => { await h?.close(); });
  const binding = () => ({ action: 'APPROVE_FUNDS', resourceId: randomUUID(), expectedVersions: { expectedVersion: 1 }, requestHash: 'a'.repeat(64) });

  it('creates a short bound mobile session without exposing credentials', async () => {
    const s = await h.operatorLogin();
    expect(s.response.status).toBe(201);
    expect(s.response.body.operatorSession.capability).toBe('MOBILE_LIMITED');
    expect(s.response.body.expiresIn).toBe(900);
    expect(JSON.stringify(s.response.body)).not.toContain('credential');
    expect(s.response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(s.response.headers['set-cookie'][0]).toContain('SameSite=Strict');
    expect((await h.enrollOwnedDevice(s)).body.status).toBe('PENDING');
  });

  it('denies funds grants despite a forged desktop User-Agent', async () => {
    const s = await h.operatorLogin();
    const denied = await h.grant(s, binding()).set('User-Agent', 'Desktop privileged');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('DESKTOP_SESSION_REQUIRED');
    expect((await h.grant(s, { ...binding(), deviceKind: 'DESKTOP_PRIVILEGED' })).status).toBe(400);
  });
  it.each(['reviewer', 'superAdminOne'] as const)('requires desktop for unfreeze grants issued to %s', async actor => {
    const s = await h.operatorLogin(h.actors[actor]);
    expect((await h.grant(s, { ...binding(), action: 'UNFREEZE_TRADING' })).status).toBe(403);
  });

  it('rejects old tokens and missing, foreign or untrusted cookie/origin bindings', async () => {
    expect((await h.command(h.actors.superAdminOne, '/api/admin/security/grants', { ...binding(), password: h.operatorPassword })).status).toBe(401);
    const s = await h.operatorLogin(h.actors.reviewer);
    const payload = { ...binding(), action: 'FREEZE_TRADING', password: h.operatorPassword };
    expect((await request(h.app.getHttpServer()).post('/api/admin/security/grants').set('Authorization', `Bearer ${s.token}`).set('Origin', 'http://localhost:5173').send(payload)).status).toBe(401);
    expect((await h.securityCommand(s, 'grants', payload).set('Origin', 'https://evil.example')).status).toBe(403);
    const other = await h.operatorLogin(h.actors.superAdminTwo);
    expect((await h.securityCommand(s, 'grants', payload).set('Cookie', other.cookie)).status).toBe(401);
  });

  it('expires mobile sessions exactly at 15 minutes and observes current role revocation', async () => {
    const s = await h.operatorLogin(h.actors.reviewer);
    const payload = { ...binding(), action: 'FREEZE_TRADING' };
    h.clock.advance(899999);
    expect((await h.grant(s, payload)).status).toBe(200);
    h.clock.advance(1);
    expect((await h.grant(s, payload)).status).toBe(401);
    const current = await h.operatorLogin(h.actors.reviewer);
    await h.prisma.userRole.deleteMany({ where: { userId: h.actors.reviewer.id } });
    expect((await h.grant(current, payload)).status).toBe(403);
  });
  it('denies device approval and revocation from untrusted mobile sessions', async () => {
    const s = await h.operatorLogin();
    const device = (await h.enrollOwnedDevice(s)).body;
    for (const action of ['approve', 'revoke']) {
      expect((await h.securityCommand(s, `devices/${device.id}/${action}`, { expectedVersion: 1, reason: 'controlled device management', operatorAction: { sessionId: s.response.body.operatorSession.id, grantId: randomUUID() } })).status).toBe(403);
    }
  });
  it('revokes only owned sessions with version advancement and authenticated idempotency', async () => {
    const first = await h.operatorLogin();
    const second = await h.operatorLogin(h.actors.superAdminOne, first.cookie);
    const id = first.response.body.operatorSession.id;
    const key = randomUUID();
    const input = { expectedVersion: 1, reason: 'close an owned session' };
    const r = await h.securityCommand(second, `sessions/${id}/revoke`, input).set('Idempotency-Key', key);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, version: 2, revoked: true });
    await h.securityCommand(second, `sessions/${id}/revoke`, input).set('Idempotency-Key', key).expect(200);
    expect((await h.grant(first, { ...binding(), action: 'FREEZE_TRADING' })).status).toBe(401);
    expect((await h.securityCommand(second, `sessions/${id}/revoke`, input)).status).toBe(409);
    const other = await h.operatorLogin(h.actors.superAdminTwo);
    expect((await h.securityCommand(second, `sessions/${other.response.body.operatorSession.id}/revoke`, input)).status).toBe(404);
  });
  it('keeps device/session reads private and credentials out of responses and audits', async () => {
    const s = await h.operatorLogin(h.actors.superAdminTwo);
    const foreign = await h.operatorLogin(h.actors.superAdminOne);
    const read = (path: string) => request(h.app.getHttpServer()).get(`/api/admin/security/${path}`).set('Authorization', `Bearer ${s.token}`).set('Cookie', s.cookie);
    const devices = OperatorDeviceListResultSchema.parse((await read('devices').expect(200)).body);
    const sessions = OperatorSessionListResultSchema.parse((await read('sessions').expect(200)).body);
    expect(devices.items.map(d => d.id)).not.toContain(foreign.response.body.operatorSession.deviceId);
    expect(sessions.items.map(v => v.id)).not.toContain(foreign.response.body.operatorSession.id);
    const audit = JSON.stringify(await h.prisma.auditLog.findMany());
    const idempotency = JSON.stringify(await h.prisma.idempotencyRecord.findMany());
    for (const secret of [h.operatorPassword, s.cookie.split('=')[1], s.token]) {
      expect(JSON.stringify([devices, sessions, s.response.body.user, audit, idempotency])).not.toContain(secret);
    }
  });
  it('uses secure cookies and exact allowed origins in production', async () => {
    const previousMode = process.env.NODE_ENV;
    const previousOrigins = process.env.OPERATOR_ORIGINS;
    try {
      process.env.NODE_ENV = 'production'; process.env.OPERATOR_ORIGINS = 'https://operator.example.test';
      const credential = await h.prisma.adminCredential.findUniqueOrThrow({ where: { userId: h.actors.superAdminTwo.id } });
      const r = await request(h.app.getHttpServer()).post('/api/admin/security/login').set('Origin', 'https://operator.example.test').send({ email: credential.email, password: h.operatorPassword }).expect(201);
      expect(r.headers['set-cookie'][0]).toContain('Secure');
      expect((await request(h.app.getHttpServer()).post('/api/admin/security/login').set('Origin', 'http://localhost:5173').send({ email: credential.email, password: h.operatorPassword })).status).toBe(403);
    } finally {
      if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
      if (previousOrigins === undefined) delete process.env.OPERATOR_ORIGINS; else process.env.OPERATOR_ORIGINS = previousOrigins;
    }
  });
});

describe('permanent server bootstrap lifecycle', () => {
  let h: AfterSalesHarness;
  beforeAll(async () => { h = await createAfterSalesHarness(); });
  afterAll(async () => { await h?.close(); });
  function cliApprove(id: string): Promise<number | null> {
    return new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', id, 'owned fixture permanent bootstrap'], { cwd: process.cwd(), env: process.env, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('close', resolveExit);
    });
  }
  it('keeps bootstrap permanently closed after all trusted devices are revoked', async () => {
    const mobile = await h.operatorLogin();
    const id = mobile.response.body.operatorSession.deviceId;
    expect(await cliApprove(id)).toBe(0);
    const desktop = await h.operatorLogin(h.actors.superAdminOne, mobile.cookie);
    const device = await h.prisma.operatorDevice.findUniqueOrThrow({ where: { id } });
    const input = { expectedVersion: device.version, reason: 'revoke the last trusted owned device' };
    const grant = await h.grant(desktop, { action: 'REVOKE_DEVICE', resourceId: id, expectedVersions: { expectedVersion: device.version }, requestHash: operatorRequestHash(input) }).expect(200);
    await h.securityCommand(desktop, `devices/${id}/revoke`, { ...input, operatorAction: { sessionId: desktop.response.body.operatorSession.id, grantId: grant.body.id } }).expect(200);
    expect(await h.prisma.operatorDevice.count({ where: { status: 'APPROVED' } })).toBe(0);
    const another = await h.operatorLogin(h.actors.superAdminTwo);
    const target = another.response.body.operatorSession.deviceId;
    expect(await cliApprove(target)).not.toBe(0);
    expect((await h.prisma.operatorDevice.findUniqueOrThrow({ where: { id: target } })).status).toBe('PENDING');
    expect(await h.prisma.auditLog.count({ where: { action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED' } })).toBe(1);
    await expect(h.prisma.auditLog.deleteMany({ where: { action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED' } })).rejects.toThrow();
  });
});

describe('atomic first bootstrap facts', () => {
  let h: AfterSalesHarness;
  beforeEach(async () => { h = await createAfterSalesHarness(); });
  afterEach(async () => { await h?.close(); });
  function cliApprove(id: string): Promise<number | null> {
    return new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', id, 'owned fixture atomic bootstrap'], { cwd: process.cwd(), env: process.env, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('close', resolveExit);
    });
  }
  it('rolls back a real CLI audit failure and allows the same pending device to retry its true first approval', async () => {
    const first = await h.operatorLogin();
    const firstId = first.response.body.operatorSession.deviceId;
    // Fault injection belongs only to this harness-owned temporary database.
    await h.prisma.$executeRawUnsafe(`CREATE FUNCTION phase4_test_reject_bootstrap_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='OPERATOR_DEVICE_BOOTSTRAP_APPROVED' THEN RAISE EXCEPTION 'owned fixture audit unavailable'; END IF; RETURN NEW; END; $$`);
    await h.prisma.$executeRawUnsafe(`CREATE TRIGGER phase4_test_bootstrap_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION phase4_test_reject_bootstrap_audit()`);
    try {
      expect(await cliApprove(firstId)).not.toBe(0);
      expect(await h.prisma.operatorDevice.findUniqueOrThrow({ where: { id: firstId } })).toMatchObject({ status: 'PENDING', version: 1 });
      expect(await h.prisma.auditLog.count({ where: { action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED' } })).toBe(0);
    } finally {
      await h.prisma.$executeRawUnsafe('DROP TRIGGER phase4_test_bootstrap_audit_fault ON "AuditLog"');
      await h.prisma.$executeRawUnsafe('DROP FUNCTION phase4_test_reject_bootstrap_audit()');
    }
    expect(await cliApprove(firstId)).toBe(0);
    expect((await h.prisma.operatorDevice.findUniqueOrThrow({ where: { id: firstId } })).status).toBe('APPROVED');
    expect(await h.prisma.auditLog.count({ where: { action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED' } })).toBe(1);
  });
  it('permits only one concurrent true first CLI approval', async () => {
    const first = await h.operatorLogin();
    const second = await h.operatorLogin(h.actors.superAdminTwo);
    const firstId = first.response.body.operatorSession.deviceId;
    const secondId = second.response.body.operatorSession.deviceId;
    const results = await Promise.all([cliApprove(firstId), cliApprove(secondId)]);
    expect(results.filter(code => code === 0)).toHaveLength(1);
    expect(results.filter(code => code !== 0)).toHaveLength(1);
    expect(await h.prisma.operatorDevice.count({ where: { status: 'APPROVED' } })).toBe(1);
    expect(await h.prisma.auditLog.count({ where: { action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED' } })).toBe(1);
    const persisted = await h.prisma.operatorDevice.findMany({ where: { id: { in: [firstId, secondId] } } });
    expect(persisted.filter(device => device.status === 'APPROVED' && device.version === 2)).toHaveLength(1);
    expect(persisted.filter(device => device.status === 'PENDING' && device.version === 1)).toHaveLength(1);
  });
});

describe('trusted desktop lifecycle and transactional grants', () => {
  let h: AfterSalesHarness;
  let desktop: Awaited<ReturnType<AfterSalesHarness['operatorLogin']>>;
  let mobile: Awaited<ReturnType<AfterSalesHarness['operatorLogin']>>;
  beforeAll(async () => {
    h = await createAfterSalesHarness();
    mobile = await h.operatorLogin();
    const device = (await h.enrollOwnedDevice(mobile)).body;
    const cli = spawnSync(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', device.id, 'owned fixture bootstrap approval'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
    expect(cli.status).toBe(0);
    desktop = await h.operatorLogin(h.actors.superAdminOne, mobile.cookie);
  });
  afterAll(async () => { await h?.close(); });
  function context(s: typeof desktop, grantId: string): OperatorActionContext { return { actor: h.actors.superAdminOne, sessionId: s.response.body.operatorSession.id, deviceId: s.response.body.operatorSession.deviceId, grantId }; }
  function binding(): ActionBinding { return { action: 'APPROVE_FUNDS', resourceId: randomUUID(), expectedVersions: { expectedCaseVersion: 4, expectedOrderVersion: 5, resolutionVersion: 2 }, requestHash: operatorRequestHash({ reason: 'specific funds decision', amountFen: 1200 }) }; }
  async function issue(b = binding(), s = desktop) { const r = await h.grant(s, b).expect(200); return { b, c: context(s, r.body.id) }; }
  async function consume(c: OperatorActionContext, b: ActionBinding) { await h.prisma.$transaction(tx => h.app.get(ActionGrantService).consume(tx, c, b)); }

  it('approves only existing pending devices through the audited bootstrap CLI', async () => {
    expect(desktop.response.body.operatorSession.capability).toBe('DESKTOP_PRIVILEGED');
    expect(desktop.response.body.expiresIn).toBe(1800);
    expect((await h.prisma.auditLog.findMany({ where: { action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED' } }))).toHaveLength(1);
    expect((await h.grant(mobile, binding())).status).toBe(403);
    const cli = spawnSync(process.execPath, [resolve('../../node_modules/tsx/dist/cli.mjs'), 'scripts/approve-operator-device.ts', randomUUID(), 'unknown owned device'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
    expect(cli.status).not.toBe(0);
  });
  it('allows desktop reviewers to unfreeze while retaining super-admin-only funds and resume grants', async () => {
    const pending = await h.operatorLogin(h.actors.reviewer);
    const id = pending.response.body.operatorSession.deviceId;
    const input = { expectedVersion: 1, reason: 'trusted risk reviewer desktop' };
    const g = await issue({ action: 'APPROVE_DEVICE', resourceId: id, expectedVersions: { expectedVersion: 1 }, requestHash: operatorRequestHash(input) });
    await h.securityCommand(desktop, `devices/${id}/approve`, { ...input, operatorAction: { sessionId: g.c.sessionId, grantId: g.c.grantId } }).expect(200);
    const reviewer = await h.operatorLogin(h.actors.reviewer, pending.cookie);
    expect((await h.grant(reviewer, { ...binding(), action: 'UNFREEZE_TRADING' })).status).toBe(200);
    for (const action of ['APPROVE_FUNDS', 'EXECUTE_FUNDS', 'RESUME_ORDER']) expect((await h.grant(reviewer, { ...binding(), action })).status).toBe(403);
  });
  it('binds grants to every version, action, resource, content, actor, session and device', async () => {
    const { b, c } = await issue();
    const variants = [ { ...b, resourceId: randomUUID() }, { ...b, action: 'EXECUTE_FUNDS' as const }, { ...b, expectedVersions: { ...b.expectedVersions, expectedOrderVersion: 6 } }, { ...b, requestHash: operatorRequestHash({ reason: 'changed decision', amountFen: 1200 }) } ];
    for (const changed of variants) await expect(consume(c, changed)).rejects.toMatchObject({ status: 403 });
    for (const changed of [{ ...c, actor: h.actors.superAdminTwo }, { ...c, sessionId: mobile.response.body.operatorSession.id }, { ...c, deviceId: randomUUID() }]) await expect(consume(changed, b)).rejects.toMatchObject({ status: expect.any(Number) });
    expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: c.grantId } })).consumedAt).toBeNull();
    await consume(c, b);
    await expect(consume(c, b)).rejects.toMatchObject({ status: 403 });
  });
  it('rolls back consumption and audit together, while grants expire exactly at five minutes', async () => {
    const { b, c } = await issue();
    h.faultAuditOnce(true);
    await expect(consume(c, b)).rejects.toThrow('Injected audit failure');
    expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: c.grantId } })).consumedAt).toBeNull();
    expect(await h.prisma.auditLog.count({ where: { action: 'OPERATOR_ACTION_GRANT_CONSUMED', entityId: c.grantId } })).toBe(0);
    h.clock.advance(299999);
    await consume(c, b);
    const expired = await issue();
    h.clock.advance(300000);
    await expect(consume(expired.c, expired.b)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects wrong passwords without issuing or auditing a grant', async () => {
    const before = await h.prisma.actionGrant.count();
    expect((await h.grant(desktop, { ...binding(), password: 'incorrect' })).status).toBe(401);
    expect(await h.prisma.actionGrant.count()).toBe(before);
  });
  it('refuses root-client grant consumption before changing authorization state', async () => {
    const { b, c } = await issue();
    await expect(h.app.get(ActionGrantService).consume(h.prisma, c, b)).rejects.toThrow();
    expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: c.grantId } })).consumedAt).toBeNull();
  });
  it('allows a different trusted administrator to approve a pending device and revoke it with idempotency', async () => {
    const other = await h.operatorLogin(h.actors.superAdminTwo);
    const target = (await h.enrollOwnedDevice(other)).body;
    const input = { expectedVersion: 1, reason: 'approve second independent administrator' };
    const grant = await issue({ action: 'APPROVE_DEVICE', resourceId: target.id, expectedVersions: { expectedVersion: 1 }, requestHash: operatorRequestHash(input) });
    const command = { ...input, operatorAction: { sessionId: grant.c.sessionId, grantId: grant.c.grantId } };
    const key = randomUUID();
    const approved = await h.securityCommand(desktop, `devices/${target.id}/approve`, command).set('Idempotency-Key', key).expect(200);
    expect(approved.body.status).toBe('APPROVED');
    await h.securityCommand(desktop, `devices/${target.id}/approve`, command).set('Idempotency-Key', key).expect(200);
    expect((await h.securityCommand(desktop, `devices/${target.id}/approve`, { ...command, reason: 'different reason' }).set('Idempotency-Key', key)).status).toBe(409);
    await h.prisma.userRole.deleteMany({ where: { userId: h.actors.superAdminOne.id } });
    expect((await h.securityCommand(desktop, `devices/${target.id}/approve`, command).set('Idempotency-Key', key)).status).toBe(403);
    await h.prisma.userRole.create({ data: { userId: h.actors.superAdminOne.id, role: 'SUPER_ADMIN' } });
    const second = await h.operatorLogin(h.actors.superAdminTwo, other.cookie);
    const oldGrant = await h.grant(second, binding()).expect(200);
    const revokeInput = { expectedVersion: approved.body.version, reason: 'revoke compromised owned device' };
    const revoke = await issue({ action: 'REVOKE_DEVICE', resourceId: target.id, expectedVersions: { expectedVersion: approved.body.version }, requestHash: operatorRequestHash(revokeInput) });
    await h.securityCommand(desktop, `devices/${target.id}/revoke`, { ...revokeInput, operatorAction: { sessionId: revoke.c.sessionId, grantId: revoke.c.grantId } }).expect(200);
    expect((await h.grant(second, binding())).status).toBe(401);
    await expect(consume({ actor: h.actors.superAdminTwo, sessionId: second.response.body.operatorSession.id, deviceId: target.id, grantId: oldGrant.body.id }, binding())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects self approval and rolls back failed device approval without consuming its grant', async () => {
    const fresh = await h.operatorLogin(h.actors.superAdminOne);
    const target = (await h.enrollOwnedDevice(fresh)).body;
    const input = { expectedVersion: 1, reason: 'cannot approve own device' };
    const g = await issue({ action: 'APPROVE_DEVICE', resourceId: target.id, expectedVersions: { expectedVersion: 1 }, requestHash: operatorRequestHash(input) });
    expect((await h.securityCommand(desktop, `devices/${target.id}/approve`, { ...input, operatorAction: { sessionId: g.c.sessionId, grantId: g.c.grantId } })).status).toBe(403);
    const pending = await h.operatorLogin(h.actors.superAdminTwo);
    const id = pending.response.body.operatorSession.deviceId;
    const g2 = await issue({ action: 'APPROVE_DEVICE', resourceId: id, expectedVersions: { expectedVersion: 1 }, requestHash: operatorRequestHash(input) });
    h.faultAuditOnce(true);
    expect((await h.securityCommand(desktop, `devices/${id}/approve`, { ...input, operatorAction: { sessionId: g2.c.sessionId, grantId: g2.c.grantId } })).status).toBe(500);
    expect((await h.prisma.operatorDevice.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: g2.c.grantId } })).consumedAt).toBeNull();
  });
  it('keeps grants available when business work conflicts and rejects concurrent reuse', async () => {
    const { b, c } = await issue();
    await expect(h.prisma.$transaction(async tx => { await h.app.get(ActionGrantService).consume(tx, c, b); throw new Error('business version conflict'); })).rejects.toThrow('business version conflict');
    expect((await h.prisma.actionGrant.findUniqueOrThrow({ where: { id: c.grantId } })).consumedAt).toBeNull();
    const results = await Promise.allSettled([consume(c, b), consume(c, b)]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await h.prisma.auditLog.count({ where: { action: 'OPERATOR_ACTION_GRANT_CONSUMED', entityId: c.grantId } })).toBe(1);
  });
  it('checks current role before returning successful retry or consuming an existing grant', async () => {
    const { b, c } = await issue();
    await h.prisma.userRole.deleteMany({ where: { userId: h.actors.superAdminOne.id } });
    await expect(consume(c, b)).rejects.toMatchObject({ status: 403 });
    await h.prisma.userRole.create({ data: { userId: h.actors.superAdminOne.id, role: 'SUPER_ADMIN' } });
  });
  it('expires desktop sessions exactly at thirty minutes', async () => {
    const session = await h.operatorLogin(h.actors.superAdminOne, desktop.cookie);
    h.clock.advance(1799999);
    expect((await h.grant(session, binding())).status).toBe(200);
    h.clock.advance(1);
    expect((await h.grant(session, binding())).status).toBe(401);
    await expect(h.prisma.$transaction(tx => h.app.get(OperatorSessionService).assertCurrent(tx, context(session, randomUUID()), 'DESKTOP_PRIVILEGED'))).rejects.toMatchObject({ status: 401 });
  });
});
