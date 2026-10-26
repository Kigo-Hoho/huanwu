import { randomBytes } from 'node:crypto';
import type { OperatorCapability, OperatorSessionView } from '@barter/contracts';
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { canonicalHash, type OperatorSessionContext } from './operator-action.types.js';

export const DEVICE_COOKIE = 'barter_operator_device';
export function operatorOrigins(): string[] {
  const origins = (process.env.OPERATOR_ORIGINS ?? (process.env.NODE_ENV !== 'production' ? 'http://localhost:5173' : '')).split(',').map(x => x.trim()).filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol)) throw new Error('OPERATOR_ORIGINS requires exact trusted origins');
  }
  return origins;
}
export function assertOperatorOrigin(request: Request): void {
  const origin = request.headers.origin;
  if (!origin || !operatorOrigins().includes(origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Trusted operator origin is required');
}
function cookieCredential(request: Request): string | undefined {
  const values = request.headers.cookie?.split(';').map(v => v.trim()).filter(v => v.startsWith(`${DEVICE_COOKIE}=`)).map(v => v.slice(DEVICE_COOKIE.length + 1));
  const unique = [...new Set(values?.filter(v => /^[a-f0-9]{64}$/.test(v)))];
  return unique.length === 1 ? unique[0] : undefined;
}
@Injectable()
export class OperatorSessionService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CLOCK) private readonly clock: Clock, @Inject(AuditService) private readonly audit: AuditService) {}

  async login(actor: AuthenticatedUser, request: Request, response: Response): Promise<OperatorSessionView> {
    assertOperatorOrigin(request);
    const previous = cookieCredential(request);
    const credential = previous ?? randomBytes(32).toString('hex');
    const result = await this.prisma.$transaction(async tx => {
      let device = previous ? await tx.operatorDevice.findUnique({ where: { credentialDigest: canonicalHash(previous) } }) : null;
      let secret = credential;
      if (!device || device.actorId !== actor.id || device.status === 'REVOKED') {
        secret = randomBytes(32).toString('hex');
        device = await tx.operatorDevice.create({ data: { actorId: actor.id, credentialDigest: canonicalHash(secret) } });
        await this.audit.record(tx, { actorId: actor.id, action: 'OPERATOR_DEVICE_ENROLLED', entityType: 'OperatorDevice', entityId: device.id, after: { status: 'PENDING', capability: 'MOBILE_LIMITED' } });
      }
      const capability = device.status === 'APPROVED' ? device.capability : 'MOBILE_LIMITED';
      const createdAt = this.clock.now();
      const expiresAt = new Date(createdAt.getTime() + (capability === 'DESKTOP_PRIVILEGED' ? 30 : 15) * 60_000);
      const session = await tx.operatorSession.create({ data: { actorId: actor.id, deviceId: device.id, capability, expiresAt, createdAt } });
      await this.audit.record(tx, { actorId: actor.id, action: 'OPERATOR_SESSION_CREATED', entityType: 'OperatorSession', entityId: session.id, after: { deviceId: device.id, capability, expiresAt: expiresAt.toISOString() } });
      return { session, secret };
    });
    response.cookie(DEVICE_COOKIE, result.secret, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api', maxAge: 30 * 24 * 60 * 60_000 });
    const { id, version, deviceId, capability, expiresAt } = result.session;
    return { id, version, deviceId, capability, expiresAt: expiresAt.toISOString() };
  }
  async fromRequest(actor: AuthenticatedUser, sessionId: string | undefined, request: Request): Promise<OperatorSessionContext> {
    const credential = cookieCredential(request);
    if (!sessionId || !credential) throw new UnauthorizedException({ code: 'REAUTH_REQUIRED', message: 'Bound operator session required' });
    return this.prisma.$transaction(async tx => {
      const session = await tx.operatorSession.findUnique({ where: { id: sessionId }, include: { device: true } });
      if (!session || session.device.credentialDigest !== canonicalHash(credential)) throw new UnauthorizedException('Device binding is invalid');
      const context = { actor, sessionId, deviceId: session.deviceId };
      await this.assertCurrent(tx, context, 'MOBILE_LIMITED');
      return context;
    });
  }
  async assertCurrent(tx: Prisma.TransactionClient, context: OperatorSessionContext, capability: OperatorCapability): Promise<void> {
    if (typeof (tx as Prisma.TransactionClient & { $connect?: unknown }).$connect === 'function') throw new Error('Operator authorization requires an active transaction client');
    // Shared locks ensure revocation cannot commit between verification and the caller's commit.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${context.actor.id}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "OperatorSession" WHERE id = ${context.sessionId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "OperatorDevice" WHERE id = ${context.deviceId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT "userId" FROM "UserRole" WHERE "userId" = ${context.actor.id}::uuid FOR SHARE`;
    const session = await tx.operatorSession.findUnique({ where: { id: context.sessionId }, include: { device: true } });
    const user = await tx.user.findUnique({ where: { id: context.actor.id }, include: { roles: true, adminCredential: true } });
    if (!session || session.actorId !== context.actor.id || session.deviceId !== context.deviceId || session.device.actorId !== context.actor.id || session.revokedAt || session.device.status === 'REVOKED' || this.clock.now() >= session.expiresAt || !user || user.disabledAt || !user.adminCredential || user.wechatOpenid) throw new UnauthorizedException({ code: 'REAUTH_REQUIRED', message: 'Operator session is unavailable' });
    const roles = user.roles.map(x => x.role);
    if (roles.includes('CUSTOMER') || !roles.some(x => ['OPERATIONS', 'REVIEWER', 'SUPER_ADMIN'].includes(x))) throw new ForbiddenException('Current operator role is required');
    context.actor.roles = roles;
    if (capability === 'DESKTOP_PRIVILEGED' && (session.capability !== capability || session.device.capability !== capability || session.device.status !== 'APPROVED')) throw new ForbiddenException({ code: 'DESKTOP_SESSION_REQUIRED', message: 'Approved desktop session required' });
  }
}
