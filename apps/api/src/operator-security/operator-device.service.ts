import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ActionGrantService } from './action-grant.service.js';
import { assertActionRole, canonicalHash, deviceView, operatorRequestHash, type OperatorActionContext } from './operator-action.types.js';
import { OperatorSessionService } from './operator-session.service.js';

export function securityCommandKey(key: string | undefined): string {
  const parsed = z.string().trim().min(1).max(200).safeParse(key);
  if (!parsed.success) throw new BadRequestException('Idempotency-Key required');
  return parsed.data;
}
@Injectable()
export class OperatorDeviceService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(AuditService) private readonly audit: AuditService, @Inject(CLOCK) private readonly clock: Clock, @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService, @Inject(ActionGrantService) private readonly grants: ActionGrantService) {}

  // A server administration capability, never exposed as an anonymous HTTP route.
  async approveDevice(deviceId: string, reason: string): Promise<void> {
    const id = z.string().uuid().parse(deviceId);
    const why = z.string().trim().min(1).max(2000).parse(reason);
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(470402)::text`;
      await tx.$queryRaw`SELECT id FROM "OperatorDevice" WHERE id = ${id}::uuid FOR UPDATE`;
      const device = await tx.operatorDevice.findUnique({ where: { id }, include: { actor: { include: { roles: true, adminCredential: true } } } });
      if (!device || device.status !== 'PENDING') throw new NotFoundException('Existing pending device required');
      // The immutable initialization fact survives all later device revocations.
      // Read it after the common transaction lock so concurrent CLI attempts
      // cannot both initialize. A failed audit rolls this fact and approval back.
      const initialized = await tx.auditLog.findFirst({
        where: { action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED', entityType: 'OperatorDevice' },
        select: { id: true },
      });
      if (initialized || await tx.operatorDevice.count({ where: { status: 'APPROVED', capability: 'DESKTOP_PRIVILEGED' } })) {
        throw new ForbiddenException('Bootstrap approval is permanently closed; use a trusted administrator');
      }
      if (device.actor.disabledAt || device.actor.wechatOpenid || !device.actor.adminCredential || device.actor.roles.some(x => x.role === 'CUSTOMER') || !device.actor.roles.some(x => x.role === 'SUPER_ADMIN')) throw new ForbiddenException('Bootstrap requires a current independent super administrator');
      await tx.operatorDevice.update({ where: { id }, data: { status: 'APPROVED', capability: 'DESKTOP_PRIVILEGED', approvedAt: this.clock.now(), version: { increment: 1 } } });
      await this.audit.record(tx, { actorId: null, action: 'OPERATOR_DEVICE_BOOTSTRAP_APPROVED', entityType: 'OperatorDevice', entityId: id, reason: why, before: { status: 'PENDING' }, after: { status: 'APPROVED', capability: 'DESKTOP_PRIVILEGED', channel: 'SERVER_CLI' } });
    });
  }

  async command(context: OperatorActionContext, id: string, action: 'APPROVE_DEVICE' | 'REVOKE_DEVICE', input: { expectedVersion: number; reason: string }, key: string) {
    const resourceId = z.string().uuid().parse(id);
    const requestHash = operatorRequestHash(input);
    const identity = { actorId: context.actor.id, commandName: `security:${action}:${resourceId}`, key: securityCommandKey(key) };
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(470402)::text`;
      await this.sessions.assertCurrent(tx, context, 'DESKTOP_PRIVILEGED');
      assertActionRole(context.actor, action);
      const where = { actorId_commandName_key: identity };
      const previous = await tx.idempotencyRecord.findUnique({ where });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key content differs' });
        return previous.response;
      }
      await tx.$queryRaw`SELECT id FROM "OperatorDevice" WHERE id = ${resourceId}::uuid FOR UPDATE`;
      const device = await tx.operatorDevice.findUnique({ where: { id: resourceId } });
      if (!device) throw new NotFoundException('Device unavailable');
      if (action === 'APPROVE_DEVICE' && device.actorId === context.actor.id) throw new ForbiddenException('Administrators cannot approve their own device');
      if (device.version !== input.expectedVersion) throw new ConflictException('Device version conflict');
      if (device.status === 'REVOKED' || (action === 'APPROVE_DEVICE' && device.status !== 'PENDING')) throw new ConflictException('Device state conflict');
      await this.grants.consume(tx, context, { action, resourceId, expectedVersions: { expectedVersion: input.expectedVersion }, requestHash });
      const updated = await tx.operatorDevice.update({ where: { id: resourceId, version: input.expectedVersion, status: device.status }, data: action === 'APPROVE_DEVICE' ? { status: 'APPROVED', capability: 'DESKTOP_PRIVILEGED', approvedAt: this.clock.now(), approvedById: context.actor.id, version: { increment: 1 } } : { status: 'REVOKED', revokedAt: this.clock.now(), version: { increment: 1 } } });
      await this.audit.record(tx, { actorId: context.actor.id, action: action === 'APPROVE_DEVICE' ? 'OPERATOR_DEVICE_APPROVED' : 'OPERATOR_DEVICE_REVOKED', entityType: 'OperatorDevice', entityId: resourceId, reason: input.reason, before: { status: device.status, version: device.version }, after: { status: updated.status, version: updated.version, sessionId: context.sessionId, deviceId: context.deviceId } });
      const result = deviceView(updated);
      await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: result } });
      return result;
    });
  }
  async revokeSession(context: Omit<OperatorActionContext, 'grantId'>, id: string, input: { expectedVersion: number; reason: string }, key: string) {
    const resourceId = z.string().uuid().parse(id);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(470402)::text`;
      await this.sessions.assertCurrent(tx, context, 'MOBILE_LIMITED');
      await tx.$queryRaw`SELECT id FROM "OperatorSession" WHERE id = ${resourceId}::uuid FOR UPDATE`;
      const session = await tx.operatorSession.findUnique({ where: { id: resourceId } });
      if (!session || session.actorId !== context.actor.id) throw new NotFoundException('Own session required');
      const identity = { actorId: context.actor.id, commandName: `security:revokeSession:${resourceId}`, key: securityCommandKey(key) };
      const where = { actorId_commandName_key: identity };
      const hash = canonicalHash(input);
      const previous = await tx.idempotencyRecord.findUnique({ where });
      if (previous) {
        if (previous.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key content differs' });
        return previous.response;
      }
      if (session.revokedAt) throw new ConflictException('Session already revoked');
      if (session.version !== input.expectedVersion) throw new ConflictException('Session version conflict');
      const updated = await tx.operatorSession.updateMany({ where: { id: resourceId, version: input.expectedVersion, revokedAt: null }, data: { revokedAt: this.clock.now(), version: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictException('Session version conflict');
      await this.audit.record(tx, { actorId: context.actor.id, action: 'OPERATOR_SESSION_REVOKED', entityType: 'OperatorSession', entityId: resourceId, reason: input.reason, after: { revoked: true, sessionId: context.sessionId, deviceId: context.deviceId } });
      const result: Prisma.InputJsonObject = { id: resourceId, version: session.version + 1, revoked: true };
      await tx.idempotencyRecord.create({ data: { ...identity, requestHash: hash, response: result } });
      return result;
    });
  }
}
